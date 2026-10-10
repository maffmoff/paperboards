// Pure aggregation: Exchange events -> depositor ranking rows.

import type { ClaimEvent, ExchangeEvent, Hex } from "./events.js";

export type SortKey = "deposited" | "net" | "count" | "latest" | "largest" | "paper" | "pnl" | "balance" | "rewards" | "netPnl";

/** Per-account figures from the official leaderboard (window all), 18-decimal strings. */
export interface LeaderboardStats {
  paper18: string;
  /** totalWindowedPnl over window all = realized + current unrealized. */
  pnl18: string;
  realizedPnl18: string;
  unrealizedPnl18: string;
  /** currentBalance: free USDC in the account, excluding margin held by open positions. */
  balance18: string;
}

export interface DepositorRow {
  rank: number;
  address: Hex;
  proxy: Hex | null;
  /** Display name on the Papertrade leaderboard. */
  name: string | null;
  /** Display name on the Hyperliquid leaderboard, when the wallet has one. */
  hlName: string | null;
  /** PAPER on the official leaderboard (`paperTotal`, 18 decimals); null when the wallet is not listed there. */
  paper18: string | null;
  /** Total PnL (realized + unrealized, 18 decimals) on the official leaderboard; null when not listed. */
  pnl18: string | null;
  realizedPnl18: string | null;
  unrealizedPnl18: string | null;
  /** currentBalance on the official leaderboard (18 decimals): free USDC only; null when not listed. */
  freeBalance18: string | null;
  /**
   * Account value (18 decimals) = (deposited - withdrawn) + total pnl + rewards claimed.
   * Matched the official portfolio equity (/query/accounts/{a}/portfolio-history) for
   * 0x6f25… to the cent on 2026-10-11. Null when the wallet is not on the leaderboard.
   */
  balance18: string | null;
  /** USDC staking rewards claimed from PaperStaking (18 decimals). Unclaimed rewards are not included. */
  rewardsClaimed18: string;
  claimCount: number;
  /** Unclaimed USDC staking rewards (PaperStaking.pendingReward, 18 decimals); "0" when unread. */
  rewardsPending18: string;
  /** Trade pnl + rewards claimed + rewards unclaimed (18 decimals); null when pnl is unknown. */
  netPnl18: string | null;
  depositedUsdc: string;
  withdrawnUsdc: string;
  netUsdc: string;
  depositCount: number;
  withdrawCount: number;
  largestUsdc: string;
  firstBlock: number;
  lastBlock: number;
  /** Unix seconds, interpolated from sampled block timestamps. */
  firstTs: number | null;
  lastTs: number | null;
  /** Transaction hashes of the largest, first and last deposit. */
  largestTx: Hex | null;
  firstTx: Hex | null;
  lastTx: Hex | null;
}

export interface RankingTotals {
  depositors: number;
  deposits: number;
  withdrawals: number;
  depositedUsdc: string;
  withdrawnUsdc: string;
  netUsdc: string;
  rewardsClaimed18: string;
  claims: number;
  rewardsPending18: string;
}

interface Agg {
  address: Hex;
  proxy: Hex | null;
  deposited: bigint;
  withdrawn: bigint;
  depositCount: number;
  withdrawCount: number;
  largest: bigint;
  firstBlock: number;
  lastBlock: number;
  largestTx: Hex | null;
  firstTx: Hex | null;
  lastTx: Hex | null;
}

export function aggregate(events: Iterable<ExchangeEvent>): Map<Hex, Agg> {
  const m = new Map<Hex, Agg>();
  for (const e of events) {
    let a = m.get(e.user);
    if (!a) {
      a = { address: e.user, proxy: null, deposited: 0n, withdrawn: 0n, depositCount: 0, withdrawCount: 0, largest: 0n, firstBlock: Infinity, lastBlock: -Infinity, largestTx: null, firstTx: null, lastTx: null };
      m.set(e.user, a);
    }
    if (e.kind === "deposit") {
      a.proxy ??= e.proxy;
      a.deposited += e.amountUsdc;
      a.depositCount += 1;
      if (e.amountUsdc > a.largest) { a.largest = e.amountUsdc; a.largestTx = e.txHash; }
      if (e.block < a.firstBlock) { a.firstBlock = e.block; a.firstTx = e.txHash; }
      if (e.block >= a.lastBlock) { a.lastBlock = e.block; a.lastTx = e.txHash; }
    } else {
      a.withdrawn += e.amountUsdc;
      a.withdrawCount += 1;
    }
  }
  return m;
}

function cmpBig(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sortRows(rows: DepositorRow[], key: SortKey): DepositorRow[] {
  const by: Record<SortKey, (a: DepositorRow, b: DepositorRow) => number> = {
    deposited: (a, b) => cmpBig(BigInt(b.depositedUsdc), BigInt(a.depositedUsdc)),
    net: (a, b) => cmpBig(BigInt(b.netUsdc), BigInt(a.netUsdc)),
    count: (a, b) => b.depositCount - a.depositCount,
    latest: (a, b) => b.lastBlock - a.lastBlock,
    largest: (a, b) => cmpBig(BigInt(b.largestUsdc), BigInt(a.largestUsdc)),
    paper: (a, b) => cmpBig(BigInt(b.paper18 ?? -1), BigInt(a.paper18 ?? -1)),
    pnl: (a, b) => (a.pnl18 == null ? 1 : 0) - (b.pnl18 == null ? 1 : 0) || cmpBig(BigInt(b.pnl18 ?? 0), BigInt(a.pnl18 ?? 0)),
    rewards: (a, b) => cmpBig(BigInt(b.rewardsClaimed18) + BigInt(b.rewardsPending18), BigInt(a.rewardsClaimed18) + BigInt(a.rewardsPending18)),
    netPnl: (a, b) => (a.netPnl18 == null ? 1 : 0) - (b.netPnl18 == null ? 1 : 0) || cmpBig(BigInt(b.netPnl18 ?? 0), BigInt(a.netPnl18 ?? 0)),
    balance: (a, b) => (a.balance18 == null ? 1 : 0) - (b.balance18 == null ? 1 : 0) || cmpBig(BigInt(b.balance18 ?? 0), BigInt(a.balance18 ?? 0)),
  };
  const sorted = [...rows].sort((a, b) => by[key](a, b) || a.firstBlock - b.firstBlock || a.address.localeCompare(b.address));
  return sorted.map((r, i) => ({ ...r, rank: i + 1 }));
}

export interface BuildOptions {
  sortBy?: SortKey;
  tsOf?: (block: number) => number | null;
  names?: ReadonlyMap<string, string>;
  hlNames?: ReadonlyMap<string, string>;
  /** Address -> figures from the official leaderboard. */
  stats?: ReadonlyMap<string, LeaderboardStats>;
  /** PaperStaking Claimed events. */
  claims?: Iterable<ClaimEvent>;
  /** Address -> unclaimed rewards (18 decimals). */
  pending?: ReadonlyMap<string, bigint>;
}

export function buildRanking(events: Iterable<ExchangeEvent>, opts: BuildOptions = {}): { rows: DepositorRow[]; totals: RankingTotals } {
  const tsOf = opts.tsOf ?? (() => null);
  const rows: DepositorRow[] = [];
  let deposited = 0n, withdrawn = 0n, deposits = 0, withdrawals = 0, claimed = 0n, claimTotal = 0, pendingTotal = 0n;
  const claimedBy = new Map<string, { amount: bigint; count: number }>();
  for (const c of opts.claims ?? []) {
    const x = claimedBy.get(c.user) ?? { amount: 0n, count: 0 };
    x.amount += c.amount18;
    x.count += 1;
    claimedBy.set(c.user, x);
    claimed += c.amount18;
    claimTotal += 1;
  }
  for (const a of aggregate(events).values()) {
    deposited += a.deposited;
    withdrawn += a.withdrawn;
    deposits += a.depositCount;
    withdrawals += a.withdrawCount;
    if (a.depositCount === 0) continue; // withdraw-only rows cannot exist on-chain, but keep the ranking to depositors
    pendingTotal += opts.pending?.get(a.address) ?? 0n;
    rows.push({
      rank: 0,
      address: a.address,
      proxy: a.proxy,
      name: opts.names?.get(a.address) ?? null,
      hlName: opts.hlNames?.get(a.address) ?? null,
      paper18: opts.stats?.get(a.address)?.paper18 ?? null,
      pnl18: opts.stats?.get(a.address)?.pnl18 ?? null,
      realizedPnl18: opts.stats?.get(a.address)?.realizedPnl18 ?? null,
      unrealizedPnl18: opts.stats?.get(a.address)?.unrealizedPnl18 ?? null,
      freeBalance18: opts.stats?.get(a.address)?.balance18 ?? null,
      balance18: (() => {
        const s = opts.stats?.get(a.address);
        if (!s) return null;
        // 8-decimal USDC flows -> 18 decimals.
        return ((a.deposited - a.withdrawn) * 10n ** 10n + BigInt(s.pnl18) + (claimedBy.get(a.address)?.amount ?? 0n)).toString();
      })(),
      rewardsClaimed18: (claimedBy.get(a.address)?.amount ?? 0n).toString(),
      claimCount: claimedBy.get(a.address)?.count ?? 0,
      rewardsPending18: (opts.pending?.get(a.address) ?? 0n).toString(),
      netPnl18: (() => {
        const s = opts.stats?.get(a.address);
        return s ? (BigInt(s.pnl18) + (claimedBy.get(a.address)?.amount ?? 0n) + (opts.pending?.get(a.address) ?? 0n)).toString() : null;
      })(),
      depositedUsdc: a.deposited.toString(),
      withdrawnUsdc: a.withdrawn.toString(),
      netUsdc: (a.deposited - a.withdrawn).toString(),
      depositCount: a.depositCount,
      withdrawCount: a.withdrawCount,
      largestUsdc: a.largest.toString(),
      firstBlock: a.firstBlock,
      lastBlock: a.lastBlock,
      firstTs: tsOf(a.firstBlock),
      lastTs: tsOf(a.lastBlock),
      largestTx: a.largestTx,
      firstTx: a.firstTx,
      lastTx: a.lastTx,
    });
  }
  return {
    rows: sortRows(rows, opts.sortBy ?? "deposited"),
    totals: {
      depositors: rows.length,
      deposits,
      withdrawals,
      depositedUsdc: deposited.toString(),
      withdrawnUsdc: withdrawn.toString(),
      netUsdc: (deposited - withdrawn).toString(),
      rewardsClaimed18: claimed.toString(),
      claims: claimTotal,
      rewardsPending18: pendingTotal.toString(),
    },
  };
}

/**
 * Linear interpolation over sampled (block, unix seconds) pairs. Blocks outside
 * the sampled range clamp to the nearest sample. Returns null with no samples.
 */
export function makeTimestampInterpolator(samples: ReadonlyArray<readonly [number, number]>): (block: number) => number | null {
  const s = [...samples].sort((a, b) => a[0] - b[0]);
  if (s.length === 0) return () => null;
  return (block) => {
    if (block <= s[0][0]) return s[0][1];
    if (block >= s[s.length - 1][0]) return s[s.length - 1][1];
    let lo = 0, hi = s.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (s[mid][0] <= block) lo = mid; else hi = mid;
    }
    const [b0, t0] = s[lo], [b1, t1] = s[hi];
    if (b1 === b0) return t0;
    return Math.round(t0 + ((t1 - t0) * (block - b0)) / (b1 - b0));
  };
}
