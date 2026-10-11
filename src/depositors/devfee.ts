// Dev-fee history for site/: the owner-set dev fee recipient claims the dev half of
// every trading fee (docs: 2% win fee / 2% LP-side loss fee, split half to stakers and
// half to the dev fee recipient) from the Exchange's devFeeAccumulator into its own
// Exchange balance. Each claim is an event, so the series is exact back to genesis;
// the unclaimed remainder is read live from devFeeAccumulator().

import type { DevFeeClaimEvent, Hex } from "./events.js";

export const HOUR_MS = 3_600_000;

export interface DevFeeSeries {
  startMs: number;
  intervalMs: number;
  /** USDC claimed inside each interval (plain numbers, 18dp scaled down). */
  claimedPerInterval: number[];
  /** Running total of claims through the end of each interval. */
  cumulative: number[];
}

export interface DevFeeClaimRow {
  block: number;
  /** Unix seconds (interpolated from sampled block timestamps), null without samples. */
  ts: number | null;
  txHash: Hex;
  recipient: Hex;
  amount18: string;
}

/** One accrual reading per index run (kept in the checkpoint): claims so far plus the live unclaimed accumulator. */
export interface DevFeeSample {
  ms: number;
  block: number;
  claimed18: string;
  unclaimed18: string;
}

export const SAMPLE_RETENTION_MS = 30 * 86_400_000;

/** Appends a reading (when the live accumulator was readable) and drops readings older than the retention window. */
export function appendDevFeeSample(samples: DevFeeSample[], s: DevFeeSample | null, retentionMs = SAMPLE_RETENTION_MS): DevFeeSample[] {
  const out = s ? [...samples, s] : [...samples];
  const cutoff = (s?.ms ?? Date.now()) - retentionMs;
  return out.filter((x) => x.ms >= cutoff);
}

export interface DevFeeSummary {
  /** devFeeRecipient() at index time; null if the call failed. */
  recipient: Hex | null;
  /** devFeeAccumulator() at index time (18dp string); null if the call failed. */
  unclaimed18: string | null;
  /** Exchange balance of the recipient at index time (18dp string); null if unavailable. */
  recipientBalance18: string | null;
  claimedTotal18: string;
  claimCount: number;
  firstClaimTs: number | null;
  lastClaimTs: number | null;
  /** Newest first, capped. */
  claims: DevFeeClaimRow[];
  series: DevFeeSeries | null;
  /** Accrued total (claimed + unclaimed, USD) at each index run, oldest first: smoother than the claim steps. */
  accrued: { ms: number; usd: number }[];
}

export const usd18 = (v: bigint): number => Number(v / 1_000_000_000_000n) / 1_000_000;

/** Hourly bins from the first claim's hour to `nowMs` (inclusive of the current hour). Null without timestamps. */
export function devFeeSeries(claims: readonly DevFeeClaimEvent[], tsOf: (block: number) => number | null, nowMs: number, intervalMs = HOUR_MS): DevFeeSeries | null {
  const stamped = claims.map((c) => ({ ms: tsOf(c.block), amount: c.amount18 })).filter((c): c is { ms: number; amount: bigint } => c.ms != null).map((c) => ({ ms: c.ms * 1000, amount: c.amount }));
  if (!stamped.length) return null;
  const firstMs = Math.min(...stamped.map((c) => c.ms));
  const startMs = Math.floor(firstMs / intervalMs) * intervalMs;
  const n = Math.max(1, Math.floor((Math.max(nowMs, firstMs) - startMs) / intervalMs) + 1);
  const per = Array.from({ length: n }, () => 0n);
  for (const c of stamped) {
    const i = Math.min(n - 1, Math.max(0, Math.floor((c.ms - startMs) / intervalMs)));
    per[i] += c.amount;
  }
  const claimedPerInterval: number[] = [], cumulative: number[] = [];
  let run = 0n;
  for (const v of per) { run += v; claimedPerInterval.push(usd18(v)); cumulative.push(usd18(run)); }
  return { startMs, intervalMs, claimedPerInterval, cumulative };
}

export function devFeeSummary(claims: readonly DevFeeClaimEvent[], live: { recipient: Hex | null; unclaimed18: bigint | null; recipientBalance18: bigint | null }, tsOf: (block: number) => number | null, nowMs: number, samples: readonly DevFeeSample[] = [], maxRows = 500): DevFeeSummary {
  const sorted = [...claims].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  const total = sorted.reduce((s, c) => s + c.amount18, 0n);
  const first = sorted[0], last = sorted[sorted.length - 1];
  return {
    recipient: live.recipient,
    unclaimed18: live.unclaimed18 == null ? null : live.unclaimed18.toString(),
    recipientBalance18: live.recipientBalance18 == null ? null : live.recipientBalance18.toString(),
    claimedTotal18: total.toString(),
    claimCount: sorted.length,
    firstClaimTs: first ? tsOf(first.block) : null,
    lastClaimTs: last ? tsOf(last.block) : null,
    claims: sorted.slice(-maxRows).reverse().map((c) => ({ block: c.block, ts: tsOf(c.block), txHash: c.txHash, recipient: c.recipient, amount18: c.amount18.toString() })),
    series: devFeeSeries(sorted, tsOf, nowMs),
    accrued: [...samples].sort((a, b) => a.ms - b.ms).map((x) => ({ ms: x.ms, usd: usd18(BigInt(x.claimed18) + BigInt(x.unclaimed18)) })),
  };
}
