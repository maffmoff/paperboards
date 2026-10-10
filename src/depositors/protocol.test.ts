import { describe, expect, it } from "vitest";
import { protocolSeries, protocolStats } from "./protocol.js";

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
