// /query/protocol/summary: the live mint-curve state and the solvency buckets, read-only.
//   npx tsx src/summary.ts            prints the current regime once
//
// Shape (frontend schema Km in the summary bundle; values are 18 dp integer strings):
//   source.block / at / genesis, balances.{tvl,margin,lp,reserve,queue}, activity, fees,
//   paper.{supply,staked,trackedLp,accumulator,tailProgress,reserve,unallocated,pendingRewards,cliff,cap,rate,decay}
//
// The mint rate is NOT a field: paper.rate is the flat-region constant (100e18). The live PAPER/$ follows
// docs how/mint-curve: flat `rate` while trackedLp < cliff (including negative), otherwise
// rate · (decay / (decay + tailProgress))². tailProgress is a one-way high-water mark; trackedLp itself moves
// both ways (losses credit it, wins and staker sweeps debit it), so the regime can fall back to flat.

import { ORIGIN } from "./config.js";

const big = (v: unknown): bigint => {
  if (typeof v === "string" && /^-?\d+$/.test(v)) return BigInt(v);
  if (typeof v === "number" && Number.isSafeInteger(v)) return BigInt(v);
  throw new Error(`Expected integer string, got ${JSON.stringify(v)}`);
};

export interface ProtocolSummary {
  block: number;
  atMs: number;
  genesisMs: number;
  balances: { tvlRaw: bigint; marginRaw: bigint; lpRaw: bigint; reserveRaw: bigint; queueRaw: bigint };
  paper: {
    supplyRaw: bigint;
    stakedRaw: bigint;
    /** Signed: the docs' "insolvent region" is a negative tracked LP. */
    trackedLpRaw: bigint;
    tailProgressRaw: bigint;
    cliffRaw: bigint;
    capRaw: bigint;
    /** Flat-region constant (PAPER per $1 of mint basis, 18 dp). */
    flatRateRaw: bigint;
    decayRaw: bigint;
  };
}

export function parseProtocolSummary(json: any): ProtocolSummary {
  if (!json || typeof json !== "object" || !json.source || !json.balances || !json.paper) throw new Error("summary: unexpected shape");
  const b = json.balances;
  const p = json.paper;
  return {
    block: Number(big(json.source.block)),
    atMs: Number(json.source.at),
    genesisMs: Number(json.source.genesis),
    balances: { tvlRaw: big(b.tvl), marginRaw: big(b.margin), lpRaw: big(b.lp), reserveRaw: big(b.reserve), queueRaw: big(b.queue) },
    paper: {
      supplyRaw: big(p.supply),
      stakedRaw: big(p.staked),
      trackedLpRaw: big(p.trackedLp),
      tailProgressRaw: big(p.tailProgress),
      cliffRaw: big(p.cliff),
      capRaw: big(p.cap),
      flatRateRaw: big(p.rate),
      decayRaw: big(p.decay),
    },
  };
}

export interface MintRegime {
  /** flat: trackedLp < cliff (docs: "including negative"). tail: the ratchet region. */
  regime: "flat" | "tail";
  /** Live PAPER per $1 of mint basis, from the docs' closed form. */
  ratePerUsd: number;
  flatRate: number;
  trackedLpUsd: number;
  tailProgressUsd: number;
  cliffUsd: number;
  decayUsd: number;
  /** balances.queue: total queued payouts. > 0 means the loss fee is waived and wins are queued. */
  queueUsd: number;
  lpUsd: number;
  block: number;
  atMs: number;
}

const usd = (raw: bigint): number => Number(raw) / 1e18;

/** The docs' mint curve evaluated on a summary. Pure. */
export function mintRegime(s: ProtocolSummary): MintRegime {
  const flatRate = usd(s.paper.flatRateRaw);
  const tail = usd(s.paper.tailProgressRaw);
  const decay = usd(s.paper.decayRaw);
  const flat = s.paper.trackedLpRaw < s.paper.cliffRaw;
  const ratePerUsd = flat || decay <= 0 ? flatRate : flatRate * (decay / (decay + tail)) ** 2;
  return {
    regime: flat ? "flat" : "tail",
    ratePerUsd,
    flatRate,
    trackedLpUsd: usd(s.paper.trackedLpRaw),
    tailProgressUsd: tail,
    cliffUsd: usd(s.paper.cliffRaw),
    decayUsd: decay,
    queueUsd: usd(s.balances.queueRaw),
    lpUsd: usd(s.balances.lpRaw),
    block: s.block,
    atMs: s.atMs,
  };
}

const money = (x: number) => `$${x.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

export function describeRegime(r: MintRegime): string {
  return `rate ${r.ratePerUsd.toFixed(1)} PAPER/$ (${r.regime}; tracked LP ${money(r.trackedLpUsd)} vs cliff ${money(r.cliffUsd)}, tail ${money(r.tailProgressUsd)}, LP cash ${money(r.lpUsd)}, queue ${money(r.queueUsd)}, block ${r.block})`;
}

/** The regime plus the raw inputs, so a reader can recompute it. */
export function regimeLogFields(r: MintRegime) {
  return { regime: r.regime, ratePerUsd: Math.round(r.ratePerUsd * 100) / 100, trackedLpUsd: r.trackedLpUsd, tailProgressUsd: r.tailProgressUsd, queueUsd: r.queueUsd, lpUsd: r.lpUsd, block: r.block, atMs: r.atMs };
}

export async function fetchProtocolSummary(origin = ORIGIN, fetchImpl: typeof fetch = fetch): Promise<ProtocolSummary> {
  const res = await fetchImpl(`${origin}/query/protocol/summary`, { headers: { Accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw new Error(`/query/protocol/summary HTTP ${res.status}`);
  return parseProtocolSummary(await res.json());
}

/** Read-only, never throws. Returns null and reports the error. */
export async function readRegime(origin: string, onError?: (e: unknown) => void): Promise<MintRegime | null> {
  try { return mintRegime(await fetchProtocolSummary(origin)); } catch (e) { onError?.(e); return null; }
}

if (process.argv[1] && /summary\.ts$/.test(process.argv[1])) {
  fetchProtocolSummary().then((s) => console.log(describeRegime(mintRegime(s)))).catch((e) => { console.error(`FAILED: ${e?.message ?? e}`); process.exit(1); });
}
