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

/**
 * Inputs of the official reward-curve chart (frontend selectors bundle, 2026-10-11), from
 * /query/protocol/summary. USD and PAPER as plain numbers.
 *   currentLp = balances.lp + balances.reserve - balances.queue
 *   staker share of realized losses: 0% when currentLp < 0, 99% when currentLp >= cap, else 1%
 */
export interface CurveParams {
  atMs: number;
  flatRate: number;
  /** paper.cliff: below this LP the mint rate is flat ("mint decay" marker). */
  threshold: number;
  /** paper.decay: D in rate = flat * (D / (D + tailProgress))^2. */
  decayScale: number;
  tailProgress: number;
  trackedLp: number;
  /** paper.cap: LP at which stakers receive 99% ("staker threshold" marker). */
  stakerCap: number;
  currentLp: number;
  supplyPaper: number;
}

export function curveParams(summary: any): CurveParams | null {
  const p = summary?.paper, b = summary?.balances;
  if (!p || !b) return null;
  const n = (v: unknown) => Number(BigInt(String(v))) / 1e18;
  return {
    atMs: Number(summary.source?.at ?? 0),
    flatRate: n(p.rate),
    threshold: n(p.cliff),
    decayScale: n(p.decay),
    tailProgress: n(p.tailProgress),
    trackedLp: n(p.trackedLp),
    stakerCap: n(p.cap),
    currentLp: n(b.lp) + n(b.reserve) - n(b.queue),
    supplyPaper: n(p.supply),
  };
}

/** PAPER per $1 of realized loss if the LP balance were `lp` (the official chart's function). */
export function mintRateAtLp(lp: number, c: CurveParams): number {
  if (lp < c.threshold) return c.flatRate;
  if (c.decayScale <= 0) return 0;
  const progress = c.tailProgress + Math.max(0, lp - Math.max(c.trackedLp, c.threshold));
  const r = c.decayScale / (c.decayScale + progress);
  return c.flatRate * r * r;
}

/** Share of realized user losses paid to stakers at LP balance `lp`, in percent. */
export function stakerSharePct(lp: number, c: Pick<CurveParams, "stakerCap">): number {
  return lp < 0 ? 0 : c.stakerCap > 0 && lp >= c.stakerCap ? 99 : 1;
}
