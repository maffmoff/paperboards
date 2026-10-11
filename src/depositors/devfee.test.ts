import { describe, expect, it } from "vitest";
import { appendDevFeeSample, devFeeSeries, devFeeSummary, usd18 } from "./devfee.js";
import { DEV_FEE_CLAIMED_TOPIC, decodeDevFeeClaimLog, deserializeDevFeeClaim, serializeDevFeeClaim, type DevFeeClaimEvent, type RawLog } from "./events.js";

const EXCHANGE = "0x6cd5661646289fb6e65ea5c032310fded797d0a2";
const word = (n: bigint) => n.toString(16).padStart(64, "0");
// Real mainnet log: tx 0xce66b7c7…a170, block 48212342 (2026-10-11 00:30:49 UTC), 22,509.09 USDC.
const claimLog: RawLog = {
  address: EXCHANGE,
  topics: [DEV_FEE_CLAIMED_TOPIC, "0x000000000000000000000000eef651e381e04b5ae25393b1367c19bcfd575792"],
  data: `0x${word(22509092728560376000000n)}${word(22509092728560376000000n)}`,
  blockNumber: "0x2dfa976",
  transactionHash: "0xce66b7c7bfae1a7cdf28da93ed33be8b790b284f1952388370b2c300d9b1a170",
  logIndex: "0x0",
};

describe("decodeDevFeeClaimLog", () => {
  it("decodes recipient, 18dp amount and block", () => {
    expect(decodeDevFeeClaimLog(claimLog, EXCHANGE)).toEqual({
      recipient: "0xeef651e381e04b5ae25393b1367c19bcfd575792",
      amount18: 22509092728560376000000n,
      block: 48212342,
      txHash: claimLog.transactionHash,
      logIndex: 0,
    });
  });
  it("ignores other contracts and other topics", () => {
    expect(decodeDevFeeClaimLog({ ...claimLog, address: "0xaad6c7b0cc3014fc80ffedae0ed7ce5967b0f016" }, EXCHANGE)).toBeNull();
    expect(decodeDevFeeClaimLog({ ...claimLog, topics: ["0xd8138f8a3f377c5259ca548e70e4c2de94f129f5a11036a15b69513cba2b426a", claimLog.topics[1]] }, EXCHANGE)).toBeNull();
  });
  it("round-trips through JSON", () => {
    const e = decodeDevFeeClaimLog(claimLog, EXCHANGE)!;
    expect(deserializeDevFeeClaim(JSON.parse(JSON.stringify(serializeDevFeeClaim(e))))).toEqual(e);
  });
});

const claim = (block: number, usd: number): DevFeeClaimEvent => ({ recipient: "0xeef651e381e04b5ae25393b1367c19bcfd575792", amount18: BigInt(Math.round(usd * 1e6)) * 1_000_000_000_000n, block, txHash: `0x${block.toString(16).padStart(64, "0")}`, logIndex: 0 });
const H = 3_600_000;
// 1 block = 1 second from t0.
const t0 = Date.UTC(2026, 9, 10, 14, 0, 0) / 1000;
const tsOf = (b: number) => t0 + b;

describe("devFeeSeries", () => {
  it("bins claims by hour from the first claim's hour to now, with a running total", () => {
    const claims = [claim(600, 10), claim(1800, 5), claim(7300, 20)]; // 14:10, 14:30, 16:01
    const s = devFeeSeries(claims, tsOf, (t0 + 9000) * 1000)!; // now = 16:30
    expect(s.startMs).toBe(t0 * 1000);
    expect(s.intervalMs).toBe(H);
    expect(s.claimedPerInterval).toEqual([15, 0, 20]);
    expect(s.cumulative).toEqual([15, 15, 35]);
  });
  it("is null without timestamps", () => {
    expect(devFeeSeries([claim(1, 1)], () => null, 0)).toBeNull();
  });
  it("keeps the current hour even when now is before the last claim's timestamp", () => {
    const s = devFeeSeries([claim(600, 10)], tsOf, 0)!;
    expect(s.claimedPerInterval).toEqual([10]);
  });
});

describe("devFeeSummary", () => {
  it("totals claims, orders rows newest first and carries the live reads as strings", () => {
    const out = devFeeSummary([claim(1800, 5), claim(600, 10)], { recipient: "0xeef651e381e04b5ae25393b1367c19bcfd575792", unclaimed18: 7n * 10n ** 18n, recipientBalance18: null }, tsOf, (t0 + 3600) * 1000);
    expect(out.claimedTotal18).toBe((15n * 10n ** 18n).toString());
    expect(out.claimCount).toBe(2);
    expect(out.unclaimed18).toBe((7n * 10n ** 18n).toString());
    expect(out.recipientBalance18).toBeNull();
    expect(out.firstClaimTs).toBe(t0 + 600);
    expect(out.lastClaimTs).toBe(t0 + 1800);
    expect(out.claims.map((c) => c.block)).toEqual([1800, 600]);
    expect(out.series?.cumulative).toEqual([15, 15]);
  });
  it("handles no claims", () => {
    const out = devFeeSummary([], { recipient: null, unclaimed18: null, recipientBalance18: null }, tsOf, 0);
    expect(out).toMatchObject({ claimedTotal18: "0", claimCount: 0, firstClaimTs: null, lastClaimTs: null, claims: [], series: null });
  });
});

describe("accrued samples", () => {
  const sample = (ms: number, claimed: number, unclaimed: number) => ({ ms, block: ms / 1000, claimed18: (BigInt(claimed) * 10n ** 18n).toString(), unclaimed18: (BigInt(unclaimed) * 10n ** 18n).toString() });
  it("appends a reading and drops ones older than the retention window", () => {
    const day = 86_400_000;
    const kept = appendDevFeeSample([sample(0, 1, 0), sample(5 * day, 2, 0)], sample(31 * day, 3, 1), 30 * day);
    expect(kept.map((s) => s.ms)).toEqual([5 * day, 31 * day]);
  });
  it("keeps the list unchanged when the live read failed", () => {
    expect(appendDevFeeSample([sample(1, 1, 0)], null, Infinity)).toEqual([sample(1, 1, 0)]);
  });
  it("emits claimed + unclaimed per sample, oldest first", () => {
    const out = devFeeSummary([], { recipient: null, unclaimed18: null, recipientBalance18: null }, () => null, 0, [sample(2000, 10, 5), sample(1000, 4, 1)]);
    expect(out.accrued).toEqual([{ ms: 1000, usd: 5 }, { ms: 2000, usd: 15 }]);
  });
});

describe("usd18", () => {
  it("keeps 6 decimals", () => { expect(usd18(22509092728560376000000n)).toBeCloseTo(22509.092728, 6); });
});
