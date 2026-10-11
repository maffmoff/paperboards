import { describe, expect, it } from "vitest";
import { curveParams, marketSeries, mintRateAtLp, periodRates, protocolSeries, protocolStats, stakerSharePct } from "./protocol.js";

const hourly = (values: (i: number) => number, n = 30) => Array.from({ length: n }, (_, i) => values(i));
const H = 3_600_000;

describe("protocolStats", () => {
  it("uses the trailing 24h when the history is long enough", () => {
    const s = protocolStats({
      startMs: 0,
      intervalMs: H,
      columns: {
        paperSupply: hourly((i) => (i < 5 ? 100 : 110)), // index 5 = 24h before the last (29)
        paperStaked: hourly(() => 50),
        stakingRewards: hourly((i) => i * 2), // 2 USDC per hour, cumulative
        traderPnl: hourly(() => -11), // traders paid 11 for 110 PAPER -> 0.1 per PAPER
      },
    })!;
    expect(s).toMatchObject({ asOfMs: 29 * H, paperSupply: 110, windowHours: 24, rewards: 48 });
    expect(s.avgCost).toBeCloseTo(0.1);
    expect(s.apr).toBeCloseTo(((48 / 50) * 365) / 0.1);
    expect(s.inflation).toBeCloseTo(0);
    expect(s.rewardPerPaperYear).toBeCloseTo((48 / 50) * 365);
  });

  it("starts the window at the first populated point when minting began less than 24h ago", () => {
    const zeros = (i: number, v: number) => (i < 26 ? 0 : v);
    const s = protocolStats({
      startMs: 0,
      intervalMs: H,
      columns: {
        paperSupply: hourly((i) => zeros(i, 100 * (i - 25))), // 100 at 26 ... 400 at 29
        paperStaked: hourly((i) => zeros(i, 10)),
        stakingRewards: hourly((i) => zeros(i, i - 26)), // 0 at 26 ... 3 at 29
      },
    })!;
    expect(s).toMatchObject({ windowHours: 3, rewards: 3 });
    expect(s.inflation).toBeCloseTo(3);
    expect(s.rewardPerPaperYear).toBeCloseTo((3 / 10) * (365 * 24 / 3));
  });

  it("returns nulls for the rates with a single populated point", () => {
    const s = protocolStats({ startMs: 0, intervalMs: H, columns: { paperSupply: [0, 2], paperStaked: [0, 1], stakingRewards: [0, 1] } })!;
    expect(s).toMatchObject({ paperSupply: 2, windowHours: null, inflation: null, rewards: null, rewardPerPaperYear: null });
  });
});

describe("protocolSeries", () => {
  it("starts at the first populated point and evaluates each point like the headline", () => {
    const zeros = (i: number, v: number) => (i < 26 ? 0 : v);
    const h = {
      startMs: 0,
      intervalMs: H,
      columns: {
        paperSupply: hourly((i) => zeros(i, 100 * (i - 25))),
        paperStaked: hourly((i) => zeros(i, 50)),
        stakingRewards: hourly((i) => zeros(i, (i - 26) * 2)),
        traderPnl: hourly((i) => zeros(i, -10)),
      },
    };
    const s = protocolSeries(h)!;
    expect(s.startMs).toBe(26 * H);
    expect(s.supply).toEqual([100, 200, 300, 400]);
    expect(s.stakedPct).toEqual([0.5, 0.25, 50 / 300, 0.125]);
    expect(s.inflationPerInterval[0]).toBeNull();
    expect(s.inflationPerInterval[1]).toBeCloseTo(1);
    expect(s.rewardsPerInterval).toEqual([null, 2, 2, 2]);
    expect(s.apr[0]).toBeNull();
    expect(s.apr[3]).toBeCloseTo(protocolStats(h)!.apr!);
  });
});

describe("reward curve", () => {
  const e18 = (x: number) => (BigInt(Math.round(x * 1e6)) * 10n ** 12n).toString();
  const c = curveParams({
    source: { at: 1 },
    balances: { lp: e18(4_000_000), reserve: e18(1_500_000), queue: e18(500_000) },
    paper: { rate: e18(100), cliff: e18(2_000_000), decay: e18(120_000_000), tailProgress: e18(30_000_000), trackedLp: e18(4_900_000), cap: e18(5_000_000), supply: e18(1e9) },
  })!;

  it("reads the summary like the official selectors", () => {
    expect(c).toMatchObject({ flatRate: 100, threshold: 2e6, decayScale: 120e6, tailProgress: 30e6, trackedLp: 4.9e6, stakerCap: 5e6, currentLp: 5e6, supplyPaper: 1e9 });
  });

  it("is flat below the threshold and decays with progress past tracked LP above it", () => {
    expect(mintRateAtLp(1e6, c)).toBe(100);
    expect(mintRateAtLp(3e6, c)).toBeCloseTo(100 * (120 / 150) ** 2);
    expect(mintRateAtLp(14.9e6, c)).toBeCloseTo(100 * (120 / 160) ** 2); // 10M past tracked LP
  });

  it("pays stakers 0% below zero LP, 1% up to the cap, 99% from the cap", () => {
    expect([stakerSharePct(-1, c), stakerSharePct(0, c), stakerSharePct(4.99e6, c), stakerSharePct(5e6, c)]).toEqual([0, 1, 1, 99]);
  });
});

describe("periodRates", () => {
  // 30 hourly points; PAPER starts at index 20 (10 populated hours), 100 PAPER and $1 of loss minted per hour.
  const zeros = (i: number, v: number) => (i < 20 ? 0 : v);
  const h = {
    startMs: 0,
    intervalMs: H,
    columns: {
      paperSupply: hourly((i) => zeros(i, 1000 + 100 * (i - 20))),
      paperStaked: hourly((i) => zeros(i, 500)),
      stakingRewards: hourly((i) => zeros(i, 2 * (i - 20))),
      traderPnl: hourly((i) => zeros(i, -10 - (i - 20))),
    },
  };
  const p = periodRates(h)!;

  it("covers 1h and 1d windows, clamping the ones longer than the minted history", () => {
    expect(p["1h"]).toMatchObject({ hours: 1, clamped: false, rewards: 2, costPerPaper: 0.01 });
    expect(p["1h"]!.inflation).toBeCloseTo(100 / 1800);
    // Longer than the 10 minted hours: the whole history, including the first minted hour.
    expect(p["1d"]).toMatchObject({ hours: 10, clamped: true, rewards: 18 });
    expect(p["7d"]).toMatchObject({ hours: 10, clamped: true });
    expect(p.all).toMatchObject({ hours: 10, clamped: false });
    expect(p["1d"]!.inflation).toBeCloseTo(1900 / 1000 - 1);
  });

  it("makes the all-time cost the cumulative average (-pnl / supply)", () => {
    expect(p.all!.costPerPaper).toBeCloseTo(19 / 1900);
    expect(p["30d"]!.costPerPaper).toBeCloseTo(19 / 1900);
  });

  it("annualizes rewards per staked PAPER and divides by the all-time average cost", () => {
    const ppy = (2 / 500) * 365 * 24;
    expect(p["1h"]!.rewardPerPaperYear).toBeCloseTo(ppy);
    expect(p["1h"]!.apr).toBeCloseTo(ppy / (19 / 1900));
  });
});

describe("marketSeries", () => {
  it("keeps every point since genesis and differences the cumulative columns", () => {
    const m = marketSeries({ startMs: 7, intervalMs: H, columns: { tvl: [1, 2, 3], volume: [0, 10, 30], trades: [0, 1, 4], stakingRewards: [0, 0, 5], users: [1, 2, 2], traderPnl: [0, -1, -3] } })!;
    expect(m).toMatchObject({ startMs: 7, tvl: [1, 2, 3], volumePerInterval: [null, 10, 20], tradesPerInterval: [null, 1, 3], stakingRewards: [0, 0, 5], users: [1, 2, 2], traderPnl: [0, -1, -3] });
  });
});
