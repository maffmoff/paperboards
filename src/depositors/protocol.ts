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

export interface PeriodRates {
  /** Hours the period actually covers; shorter than asked when PAPER history is younger ("clamped"). */
  hours: number;
  clamped: boolean;
  /** supply(end) / supply(start) - 1. */
  inflation: number | null;
  /** USDC to stakers during the period. */
  rewards: number | null;
  /** rewards / mean staked PAPER, scaled to a year. */
  rewardPerPaperYear: number | null;
  /** rewardPerPaperYear / all-time average cost per PAPER (the cost basis of a held PAPER). */
  apr: number | null;
  /** Net cost per PAPER minted in the period: -(change in trader pnl) / (change in supply). */
  costPerPaper: number | null;
}

export const PERIODS = { "1h": 1, "1d": 24, "7d": 168, "30d": 720, all: null } as const;
export type PeriodKey = keyof typeof PERIODS;

/** The overview's period metrics for 1H / 1D / 7D / 30D / all, each over the trailing period ending now. */
export function periodRates(h: ProtocolHistory): Record<PeriodKey, PeriodRates | null> | null {
  const supply = h.columns.paperSupply ?? [], staked = h.columns.paperStaked ?? [], rewards = h.columns.stakingRewards ?? [], pnl = h.columns.traderPnl ?? [];
  const n = Math.min(supply.length, staked.length, rewards.length);
  if (n === 0 || h.intervalMs <= 0) return null;
  const last = n - 1;
  let first = 0;
  while (first < last && !(supply[first] > 0)) first++;
  const perHour = 3_600_000 / h.intervalMs;
  const avgCost = supply[last] > 0 && pnl[last] != null && -pnl[last] > 0 ? -pnl[last] / supply[last] : null;
  // A period longer than the minted history covers all of it: rewards then include the first minted hour,
  // and the cost runs from the start of the history so "all" equals the cumulative average (-pnl / supply).
  const one = (hours: number | null): PeriodRates | null => {
    const want = hours === null ? Infinity : Math.max(1, Math.round(hours * perHour));
    const whole = last - want < first;
    const rateFrom = whole ? first : last - want;
    const rewFrom = whole ? Math.max(0, first - 1) : rateFrom;
    const costFrom = whole ? 0 : rateFrom;
    if (rewFrom >= last) return null;
    const span = last - rewFrom, spanMs = span * h.intervalMs;
    let meanStaked = 0, k = 0;
    for (let i = Math.max(rewFrom, first); i <= last; i++) { meanStaked += staked[i]; k++; }
    meanStaked = k ? meanStaked / k : 0;
    const got = rewards[last] - rewards[rewFrom];
    const ppy = meanStaked > 0 ? (got / meanStaked) * (YEAR_MS / spanMs) : null;
    const minted = supply[last] - supply[costFrom];
    return {
      hours: spanMs / 3_600_000,
      clamped: hours !== null && whole,
      inflation: rateFrom < last && supply[rateFrom] > 0 ? supply[last] / supply[rateFrom] - 1 : null,
      rewards: got,
      rewardPerPaperYear: ppy,
      apr: ppy !== null && avgCost ? ppy / avgCost : null,
      costPerPaper: minted > 0 && pnl[last] != null && pnl[costFrom] != null ? (pnl[costFrom] - pnl[last]) / minted : null,
    };
  };
  return Object.fromEntries(Object.entries(PERIODS).map(([k, v]) => [k, one(v)])) as Record<PeriodKey, PeriodRates | null>;
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

/**
 * Protocol activity since genesis (every hourly point, not only since PAPER began): TVL, volume and trades
 * per interval, cumulative staker rewards, users and cumulative trader pnl. The history's volume, trades,
 * stakingRewards, users and traderPnl columns are cumulative; per-interval values are their differences.
 */
export interface MarketSeries {
  startMs: number;
  intervalMs: number;
  tvl: number[];
  volumePerInterval: (number | null)[];
  tradesPerInterval: (number | null)[];
  stakingRewards: number[];
  users: number[];
  traderPnl: number[];
  paperSupply: number[];
  /** Per-interval differences of the cumulative columns (null for the first point). */
  rewardsPerInterval: (number | null)[];
  pnlPerInterval: (number | null)[];
  paperMintedPerInterval: (number | null)[];
  newUsersPerInterval: (number | null)[];
}

export function marketSeries(h: ProtocolHistory): MarketSeries | null {
  const c = h.columns, n = (c.tvl ?? []).length;
  if (n < 2) return null;
  const col = (k: string) => (c[k] ?? []).slice(0, n).map((v) => (Number.isFinite(v) ? v : 0));
  const diff = (v: number[]) => v.map((x, i) => (i === 0 ? null : x - v[i - 1]));
  return {
    startMs: h.startMs,
    intervalMs: h.intervalMs,
    tvl: col("tvl"),
    volumePerInterval: diff(col("volume")),
    tradesPerInterval: diff(col("trades")),
    stakingRewards: col("stakingRewards"),
    users: col("users"),
    traderPnl: col("traderPnl"),
    paperSupply: col("paperSupply"),
    rewardsPerInterval: diff(col("stakingRewards")),
    pnlPerInterval: diff(col("traderPnl")),
    paperMintedPerInterval: diff(col("paperSupply")),
    newUsersPerInterval: diff(col("users")),
  };
}

/** Totals over a trailing period: what happened in it (sums of the per-interval flows). */
export interface PeriodFlows {
  /** Hours covered; shorter than asked when the history is younger ("clamped"). */
  hours: number;
  clamped: boolean;
  volume: number;
  trades: number;
  /** Change in cumulative trader pnl: negative = traders lost money over the period. */
  pnlChange: number;
  rewards: number;
  paperMinted: number;
  newUsers: number;
}

/** 1H / 1D / 7D / 30D / all flows from the hourly history, counted from the start of the history (genesis). */
export function periodFlows(h: ProtocolHistory): Record<PeriodKey, PeriodFlows | null> | null {
  const c = h.columns, n = (c.volume ?? []).length;
  if (n < 2 || h.intervalMs <= 0) return null;
  const last = n - 1, perHour = 3_600_000 / h.intervalMs;
  const at = (k: string, i: number) => { const v = (c[k] ?? [])[i]; return Number.isFinite(v) ? v : 0; };
  const d = (k: string, from: number) => at(k, last) - at(k, from);
  const one = (hours: number | null): PeriodFlows | null => {
    const want = hours === null ? last : Math.max(1, Math.round(hours * perHour));
    const from = Math.max(0, last - want);
    if (from >= last) return null;
    return {
      hours: ((last - from) * h.intervalMs) / 3_600_000,
      clamped: hours !== null && last - want < 0,
      volume: d("volume", from),
      trades: d("trades", from),
      pnlChange: d("traderPnl", from),
      rewards: d("stakingRewards", from),
      paperMinted: d("paperSupply", from),
      newUsers: d("users", from),
    };
  };
  return Object.fromEntries(Object.entries(PERIODS).map(([k, v]) => [k, one(v)])) as Record<PeriodKey, PeriodFlows | null>;
}

/**
 * Open interest from GET /query/house/history?interval=1h (the official stats page's Open Interest chart):
 * entry notional of open positions in USD per side, bl/bs = BTC long/short, el/es = ETH long/short.
 * Points carry their own times (baseTimeMs + timeOffsetsMs); gap indices are dropped.
 */
export interface HouseHistory {
  baseTimeMs: number;
  timeOffsetsMs: number[];
  gapIndices?: number[];
  columns: Record<string, number[]>;
}

export interface OpenInterestSeries {
  times: number[];
  btcLong: number[];
  btcShort: number[];
  ethLong: number[];
  ethShort: number[];
  total: number[];
}

export function openInterestSeries(h: HouseHistory): OpenInterestSeries | null {
  const c = h.columns ?? {}, n = (h.timeOffsetsMs ?? []).length;
  if (n === 0 || !c.bl || !c.bs || !c.el || !c.es) return null;
  const gaps = new Set(h.gapIndices ?? []);
  const out: OpenInterestSeries = { times: [], btcLong: [], btcShort: [], ethLong: [], ethShort: [], total: [] };
  for (let i = 0; i < n; i++) {
    if (gaps.has(i)) continue;
    const v = [c.bl[i], c.bs[i], c.el[i], c.es[i]];
    if (!v.every(Number.isFinite)) continue;
    out.times.push(h.baseTimeMs + h.timeOffsetsMs[i]);
    out.btcLong.push(v[0]); out.btcShort.push(v[1]); out.ethLong.push(v[2]); out.ethShort.push(v[3]);
    out.total.push(v[0] + v[1] + v[2] + v[3]);
  }
  return out.times.length ? out : null;
}
