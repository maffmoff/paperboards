// Protocol-level PAPER figures from GET /query/protocol/history (hourly columns), for the
// site's overview: supply growth (inflation), staking ratio and the trailing reward rate.
//
// The series is zero before PAPER started minting (2026-10-10 14:00 UTC on the first
// read), so the trailing window is the last 24h or the populated part of it, whichever is
// shorter, and the window length is reported with the figures.

export interface ProtocolHistory {
  startMs: number;
  intervalMs: number;
  /** Column -> one value per interval; units as served (PAPER, USDC), not fixed-point. */
  columns: Record<string, number[]>;
}

export interface ProtocolStats {
  asOfMs: number;
  paperSupply: number;
  paperStaked: number;
}

const DAY_MS = 86_400_000;
const YEAR_MS = 365 * DAY_MS;

export interface WindowRates {
  windowHours: number | null;
  inflation: number | null;
  rewards: number | null;
  rewardPerPaperYear: number | null;
  /** -(cumulative trader pnl) / PAPER supply: what traders as a whole paid per PAPER. */
  avgCost: number | null;
  /** rewardPerPaperYear / avgCost: the protocol-wide staking APR at the average cost basis. */
  apr: number | null;
}

/** Rates over the trailing window ending at index `last` (<= 24h, starting at the first populated point). */
function ratesAt(h: ProtocolHistory, last: number): WindowRates {
  const supply = h.columns.paperSupply ?? [], staked = h.columns.paperStaked ?? [], rewards = h.columns.stakingRewards ?? [], pnl = h.columns.traderPnl ?? [];
  let from = Math.max(0, last - Math.round(DAY_MS / h.intervalMs));
  while (from < last && !(supply[from] > 0)) from++;
  const avgCost = supply[last] > 0 && pnl[last] != null && -pnl[last] > 0 ? -pnl[last] / supply[last] : null;
  if (from >= last) return { windowHours: null, inflation: null, rewards: null, rewardPerPaperYear: null, avgCost, apr: null };
  const windowMs = (last - from) * h.intervalMs;
  let meanStaked = 0;
  for (let i = from; i <= last; i++) meanStaked += staked[i];
  meanStaked /= last - from + 1;
  const got = rewards[last] - rewards[from];
  const rewardPerPaperYear = meanStaked > 0 ? (got / meanStaked) * (YEAR_MS / windowMs) : null;
  return {
    windowHours: windowMs / 3_600_000,
    inflation: supply[last] / supply[from] - 1,
    rewards: got,
    rewardPerPaperYear,
    avgCost,
    apr: rewardPerPaperYear !== null && avgCost ? rewardPerPaperYear / avgCost : null,
  };
}

export function protocolStats(h: ProtocolHistory): (ProtocolStats & WindowRates) | null {
  const supply = h.columns.paperSupply ?? [], staked = h.columns.paperStaked ?? [], rewards = h.columns.stakingRewards ?? [];
  const n = Math.min(supply.length, staked.length, rewards.length);
  if (n === 0) return null;
  const last = n - 1;
  return { asOfMs: h.startMs + last * h.intervalMs, paperSupply: supply[last], paperStaked: staked[last], ...ratesAt(h, last) };
}

export interface ProtocolSeries {
  /** Time of the first point (first interval with PAPER supply); points are intervalMs apart. */
  startMs: number;
  intervalMs: number;
  supply: number[];
  stakedPct: (number | null)[];
  /** Growth of supply over each interval (null for the first point). */
  inflationPerInterval: (number | null)[];
  /** USDC to stakers during each interval (null for the first point). */
  rewardsPerInterval: (number | null)[];
  /** Same trailing-window definitions as the headline figures, evaluated at every point. */
  apr: (number | null)[];
  avgCost: (number | null)[];
}

/** Every populated interval, for the site's history charts. */
export function protocolSeries(h: ProtocolHistory): ProtocolSeries | null {
  const supply = h.columns.paperSupply ?? [], staked = h.columns.paperStaked ?? [], rewards = h.columns.stakingRewards ?? [];
  const n = Math.min(supply.length, staked.length, rewards.length);
  let first = 0;
  while (first < n && !(supply[first] > 0)) first++;
  if (first >= n) return null;
  const out: ProtocolSeries = { startMs: h.startMs + first * h.intervalMs, intervalMs: h.intervalMs, supply: [], stakedPct: [], inflationPerInterval: [], rewardsPerInterval: [], apr: [], avgCost: [] };
  for (let i = first; i < n; i++) {
    const r = ratesAt(h, i);
    out.supply.push(supply[i]);
    out.stakedPct.push(supply[i] > 0 ? staked[i] / supply[i] : null);
    out.inflationPerInterval.push(i > first && supply[i - 1] > 0 ? supply[i] / supply[i - 1] - 1 : null);
    out.rewardsPerInterval.push(i > first ? rewards[i] - rewards[i - 1] : null);
    out.apr.push(r.apr);
    out.avgCost.push(r.avgCost);
  }
  return out;
}
