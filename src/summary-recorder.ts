// Read-only recorder of /query/protocol/summary, and the report that turns the recording into the
// numbers the dilution estimate needs (tracked-LP dips below the cliff, tail speed, flat-region emission).
//
//   node --import tsx src/summary-recorder.ts [--origin https://exchange.papertrade.xyz]
//     [--interval-ms 60000] [--rounds 0] [--out data/summary.jsonl]
//   node --import tsx src/summary-recorder.ts --report [--out data/summary.jsonl]
//
// One GET per interval, `Accept: application/json`, no wallet, no cookie, no key: nothing here can sign or
// send. Every sample is appended as one JSON line with the raw 18 dp integer strings (exact) and the USD /
// PAPER floats derived from them, plus the mint regime from src/summary.ts. A refusal is recorded as an
// `error` line (status and edge verdict only, never the body) and the next request waits for `Retry-After`,
// or a 60 s → 10 min backoff on an edge refusal; it never polls faster than `--interval-ms` (min 5 s).
//
// Why this exists (2026-10-10): the limit of the PAPER supply is closed-form in tailProgress, but every
// time tracked LP falls below the cliff the curve returns to 100 PAPER/$ with no cap, and tailProgress does
// not advance there (docs how/mint-curve). The dips' count and depth are the
// only input that narrows the lower bound of the estimate, and summary has no history endpoint.

import { readFileSync } from "node:fs";
import { parseArgs } from "./args.js";
import { ORIGIN } from "./config.js";
import { classifyEdge, isEdgeRefusal, type EdgeKind } from "./edge.js";
import { logLine } from "./logging.js";
import { parseRetryAfterMs } from "./state.js";
import { mintRegime, parseProtocolSummary, type ProtocolSummary } from "./summary.js";

export interface RecorderOptions {
  origin: string;
  intervalMs: number;
  /** 0 = run until stopped. */
  rounds: number;
  out: string;
  report: boolean;
}

export function parseRecorderArgs(argv: string[]): RecorderOptions {
  const a = parseArgs(argv);
  const num = (k: string, d: number, min: number) => { const v = a[k] === undefined ? d : Number(a[k]); if (!Number.isFinite(v) || v < min) throw new Error(`--${k} must be a number ≥ ${min}`); return v; };
  return {
    origin: (a.origin ?? ORIGIN).replace(/\/+$/, ""),
    intervalMs: num("interval-ms", 60_000, 5_000),
    rounds: num("rounds", 0, 0),
    out: a.out ?? "data/summary.jsonl",
    report: a.report === "true",
  };
}

const usd = (raw: bigint): number => Number(raw) / 1e18;

/** One recorded sample. Raw strings are exact; the floats are for reading and for the report. */
export interface SummaryRecord {
  kind: "summary";
  block: number;
  at: string;
  raw: { supply: string; staked: string; trackedLp: string; tailProgress: string; lp: string; queue: string; tvl: string; margin: string; cliff: string; cap: string; rate: string; decay: string };
  supplyPaper: number;
  stakedPaper: number;
  trackedLpUsd: number;
  tailProgressUsd: number;
  lpUsd: number;
  queueUsd: number;
  tvlUsd: number;
  marginUsd: number;
  cliffUsd: number;
  capUsd: number;
  decayUsd: number;
  flatRate: number;
  regime: "flat" | "tail";
  ratePerUsd: number;
}

export function toRecord(s: ProtocolSummary): SummaryRecord {
  const r = mintRegime(s);
  const str = (v: bigint) => v.toString();
  return {
    kind: "summary",
    block: s.block,
    at: new Date(s.atMs).toISOString(),
    raw: {
      supply: str(s.paper.supplyRaw), staked: str(s.paper.stakedRaw), trackedLp: str(s.paper.trackedLpRaw), tailProgress: str(s.paper.tailProgressRaw),
      lp: str(s.balances.lpRaw), queue: str(s.balances.queueRaw), tvl: str(s.balances.tvlRaw), margin: str(s.balances.marginRaw),
      cliff: str(s.paper.cliffRaw), cap: str(s.paper.capRaw), rate: str(s.paper.flatRateRaw), decay: str(s.paper.decayRaw),
    },
    supplyPaper: usd(s.paper.supplyRaw),
    stakedPaper: usd(s.paper.stakedRaw),
    trackedLpUsd: r.trackedLpUsd,
    tailProgressUsd: r.tailProgressUsd,
    lpUsd: r.lpUsd,
    queueUsd: r.queueUsd,
    tvlUsd: usd(s.balances.tvlRaw),
    marginUsd: usd(s.balances.marginRaw),
    cliffUsd: r.cliffUsd,
    capUsd: usd(s.paper.capRaw),
    decayUsd: r.decayUsd,
    flatRate: r.flatRate,
    regime: r.regime,
    ratePerUsd: Math.round(r.ratePerUsd * 1000) / 1000,
  };
}

export interface ErrorRecord { kind: "error"; status: number | null; edge: EdgeKind | "network"; retryAfterMs: number; message: string }

export interface SampleDeps { fetchImpl?: typeof fetch; timeoutMs?: number }

/** One GET. Never throws; a refusal or a network failure becomes an ErrorRecord. */
export async function sampleOnce(origin: string, deps: SampleDeps = {}): Promise<SummaryRecord | ErrorRecord> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(`${origin}/query/protocol/summary`, { headers: { accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(deps.timeoutMs ?? 5_000) });
    const text = await res.text();
    if (!res.ok) {
      const edge = classifyEdge(res.status, res.headers, text);
      return { kind: "error", status: res.status, edge: edge.kind, retryAfterMs: parseRetryAfterMs(res.headers.get("retry-after")), message: `HTTP ${res.status}${isEdgeRefusal(edge) ? ` (${edge.kind})` : ""}` };
    }
    return toRecord(parseProtocolSummary(JSON.parse(text)));
  } catch (e) {
    return { kind: "error", status: null, edge: "network", retryAfterMs: 0, message: (e as Error)?.name === "TimeoutError" ? "timeout" : "network-or-parse" };
  }
}

/**
 * Delay before the next request. Normal: the interval. 429/Retry-After: at least that (≤ 10 min).
 * Edge refusal without Retry-After: 60 s doubling to 10 min per consecutive refusal. Never below the interval.
 */
export function nextDelayMs(r: SummaryRecord | ErrorRecord, intervalMs: number, consecutiveErrors: number): number {
  if (r.kind === "summary") return intervalMs;
  const cap = 600_000;
  let d = intervalMs;
  if (r.retryAfterMs > 0) d = Math.max(d, Math.min(r.retryAfterMs, cap));
  else if (r.edge !== "network" && r.edge !== "origin" && r.edge !== "none") d = Math.max(d, Math.min(60_000 * 2 ** Math.max(0, consecutiveErrors - 1), cap));
  return d;
}

export interface RecorderDeps extends SampleDeps { sleep?: (ms: number) => Promise<void>; out?: (line: string) => void; record?: (file: string, r: Record<string, unknown>) => void }

export async function runRecorder(o: RecorderOptions, deps: RecorderDeps = {}): Promise<{ samples: number; errors: number }> {
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const out = deps.out ?? ((l) => console.log(l));
  const record = deps.record ?? ((file, r) => { logLine(file, r); });
  let samples = 0, errors = 0, consecutiveErrors = 0;
  for (let i = 0; o.rounds === 0 || i < o.rounds; i++) {
    const r = await sampleOnce(o.origin, deps);
    record(o.out, { ...r });
    if (r.kind === "summary") {
      samples++; consecutiveErrors = 0;
      out(`${r.at} block ${r.block}  supply ${fmtM(r.supplyPaper)} PAPER  tracked LP $${fmtM(r.trackedLpUsd)}  tail $${fmtM(r.tailProgressUsd)}  queue $${fmtM(r.queueUsd)}  ${r.regime} ${r.ratePerUsd}/$`);
    } else {
      errors++; consecutiveErrors++;
      out(`${new Date().toISOString()} ${r.message}`);
    }
    if (o.rounds === 0 || i + 1 < o.rounds) await sleep(nextDelayMs(r, o.intervalMs, consecutiveErrors));
  }
  return { samples, errors };
}

const fmtM = (x: number) => x >= 1e6 ? `${(x / 1e6).toFixed(2)}M` : x.toLocaleString("en-US", { maximumFractionDigits: 0 });

// ---------------------------------------------------------------------------------------------------------
// Report: what the recording says about the dilution inputs.

export interface Dip { fromAt: string; toAt: string | null; minLpUsd: number; depthUsd: number; samples: number }

export interface SummaryReport {
  samples: number;
  fromAt: string | null;
  toAt: string | null;
  spanHours: number;
  trackedLpMinUsd: number;
  trackedLpMaxUsd: number;
  /** Stretches of consecutive flat samples (tracked LP < cliff). depthUsd = cliff − min LP in the dip. */
  dips: Dip[];
  /** Σ depth: the flat-region loss the recording saw, i.e. ~100 PAPER/$ emission with no tail progress. */
  dipDepthUsd: number;
  tailProgressStartUsd: number;
  tailProgressEndUsd: number;
  tailSpeedUsdPerHour: number;
  supplyStartPaper: number;
  supplyEndPaper: number;
  /** Supply the tail curve alone explains at the last sample (voluntary-close basis; liquidations mint up to 2% more). */
  tailEmissionPaper: number;
  /** supplyEnd − tailEmission: emission outside the tail curve (initial fill to the cliff plus every dip). */
  flatEmissionPaper: number;
  /** flatRate · decay² / (decay + tail): what the tail curve can still mint with no further dip. */
  remainingTailPaper: number;
  limitSupplyPaper: number;
  /** Mid-sample gaps longer than 3× the median gap, so a reader knows where dips may have been missed. */
  gaps: { fromAt: string; toAt: string; hours: number }[];
}

export function analyze(records: SummaryRecord[]): SummaryReport {
  const rs = [...records].filter((r) => r.kind === "summary").sort((a, b) => a.block - b.block || a.at.localeCompare(b.at));
  const dips: Dip[] = [];
  let cur: Dip | null = null;
  for (const r of rs) {
    if (r.trackedLpUsd < r.cliffUsd) {
      if (!cur) { cur = { fromAt: r.at, toAt: null, minLpUsd: r.trackedLpUsd, depthUsd: 0, samples: 0 }; dips.push(cur); }
      cur.samples++;
      cur.minLpUsd = Math.min(cur.minLpUsd, r.trackedLpUsd);
      cur.depthUsd = r.cliffUsd - cur.minLpUsd;
    } else if (cur) { cur.toAt = r.at; cur = null; }
  }
  const first = rs[0], last = rs[rs.length - 1];
  const hours = first && last ? (Date.parse(last.at) - Date.parse(first.at)) / 3_600_000 : 0;
  const gaps: SummaryReport["gaps"] = [];
  if (rs.length >= 3) {
    const ds = rs.slice(1).map((r, i) => Date.parse(r.at) - Date.parse(rs[i].at)).sort((a, b) => a - b);
    const median = ds[Math.floor(ds.length / 2)];
    for (let i = 1; i < rs.length; i++) {
      const d = Date.parse(rs[i].at) - Date.parse(rs[i - 1].at);
      if (median > 0 && d > 3 * median) gaps.push({ fromAt: rs[i - 1].at, toAt: rs[i].at, hours: Math.round(d / 36_000) / 100 });
    }
  }
  const T = last?.tailProgressUsd ?? 0;
  const curve = last ? curveAt(last) : { tailEmissionPaper: 0, remainingTailPaper: 0, limitSupplyPaper: 0, flatEmissionPaper: 0 };
  return {
    samples: rs.length,
    fromAt: first?.at ?? null,
    toAt: last?.at ?? null,
    spanHours: Math.round(hours * 100) / 100,
    trackedLpMinUsd: rs.length ? Math.min(...rs.map((r) => r.trackedLpUsd)) : 0,
    trackedLpMaxUsd: rs.length ? Math.max(...rs.map((r) => r.trackedLpUsd)) : 0,
    dips,
    dipDepthUsd: dips.reduce((s, d) => s + d.depthUsd, 0),
    tailProgressStartUsd: first?.tailProgressUsd ?? 0,
    tailProgressEndUsd: T,
    tailSpeedUsdPerHour: hours > 0 && first ? (T - first.tailProgressUsd) / hours : 0,
    supplyStartPaper: first?.supplyPaper ?? 0,
    supplyEndPaper: last?.supplyPaper ?? 0,
    tailEmissionPaper: curve.tailEmissionPaper,
    flatEmissionPaper: curve.flatEmissionPaper,
    remainingTailPaper: curve.remainingTailPaper,
    limitSupplyPaper: curve.limitSupplyPaper,
    gaps,
  };
}

// ---------------------------------------------------------------------------------------------------------
// paperboards (site/): the headline and the chart series the depositors indexer writes into ranking.json.
// The indexer appends one sample per run (every 10 min on GitHub Actions) to the same file the recorder
// writes, so the site's resolution is whichever process sampled; short dips between samples are missed.

/** Default file shared by the recorder and the indexer. */
export const SUMMARY_LOG_PATH = "data/summary.jsonl";

/** The closed-form curve numbers at one sample (voluntary-close basis; liquidations mint up to 2% more). */
export function curveAt(r: SummaryRecord): { tailEmissionPaper: number; remainingTailPaper: number; limitSupplyPaper: number; flatEmissionPaper: number } {
  const D = r.decayUsd, T = r.tailProgressUsd, R = r.flatRate;
  const tailEmission = D + T > 0 ? R * D * T / (D + T) : 0;
  const remaining = D + T > 0 ? R * D * D / (D + T) : 0;
  return { tailEmissionPaper: tailEmission, remainingTailPaper: remaining, limitSupplyPaper: r.supplyPaper + remaining, flatEmissionPaper: r.supplyPaper - tailEmission };
}

export interface MintHeadline {
  block: number;
  atMs: number;
  regime: "flat" | "tail";
  ratePerUsd: number;
  flatRate: number;
  trackedLpUsd: number;
  tailProgressUsd: number;
  cliffUsd: number;
  capUsd: number;
  decayUsd: number;
  queueUsd: number;
  supplyPaper: number;
  tailEmissionPaper: number;
  remainingTailPaper: number;
  limitSupplyPaper: number;
  flatEmissionPaper: number;
}

export function mintHeadline(r: SummaryRecord): MintHeadline {
  return {
    block: r.block, atMs: Date.parse(r.at), regime: r.regime, ratePerUsd: r.ratePerUsd, flatRate: r.flatRate,
    trackedLpUsd: r.trackedLpUsd, tailProgressUsd: r.tailProgressUsd, cliffUsd: r.cliffUsd, capUsd: r.capUsd, decayUsd: r.decayUsd, queueUsd: r.queueUsd,
    supplyPaper: r.supplyPaper, ...curveAt(r),
  };
}

export interface MintSeries {
  startMs: number;
  intervalMs: number;
  /** One value per bin (the bin's last sample), null where nothing was sampled. */
  trackedLpUsd: (number | null)[];
  tailProgressUsd: (number | null)[];
  ratePerUsd: (number | null)[];
  limitSupplyPaper: (number | null)[];
}

/** Samples binned onto a fixed grid so the site can draw them like the hourly history. */
export function mintSeries(records: SummaryRecord[], intervalMs = 600_000): MintSeries | null {
  const rs = records.filter((r) => r.kind === "summary").map((r) => ({ r, t: Date.parse(r.at) })).filter((x) => Number.isFinite(x.t)).sort((a, b) => a.t - b.t);
  if (!rs.length || intervalMs <= 0) return null;
  const startMs = Math.floor(rs[0].t / intervalMs) * intervalMs;
  const n = Math.floor((rs[rs.length - 1].t - startMs) / intervalMs) + 1;
  const out: MintSeries = { startMs, intervalMs, trackedLpUsd: Array(n).fill(null), tailProgressUsd: Array(n).fill(null), ratePerUsd: Array(n).fill(null), limitSupplyPaper: Array(n).fill(null) };
  for (const { r, t } of rs) {
    const i = Math.floor((t - startMs) / intervalMs);
    out.trackedLpUsd[i] = r.trackedLpUsd;
    out.tailProgressUsd[i] = r.tailProgressUsd;
    out.ratePerUsd[i] = r.ratePerUsd;
    out.limitSupplyPaper[i] = curveAt(r).limitSupplyPaper;
  }
  return out;
}

export function readRecords(file: string): SummaryRecord[] {
  const out: SummaryRecord[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (r?.kind === "summary" && typeof r.block === "number") out.push(r as SummaryRecord); } catch { /* a torn line from an interrupted write; the sample is lost, the rest of the file is not */ }
  }
  return out;
}

export function renderReport(p: SummaryReport): string {
  const m = (x: number) => `$${(x / 1e6).toFixed(2)}M`;
  const b = (x: number) => `${(x / 1e9).toFixed(2)}B`;
  const L: string[] = [];
  L.push(`samples ${p.samples}  ${p.fromAt ?? "-"} → ${p.toAt ?? "-"}  (${p.spanHours} h)`);
  if (p.gaps.length) L.push(`gaps (dips may be missed): ${p.gaps.map((g) => `${g.fromAt}→${g.toAt} ${g.hours} h`).join(", ")}`);
  L.push(`tracked LP  min ${m(p.trackedLpMinUsd)}  max ${m(p.trackedLpMaxUsd)}`);
  L.push(`dips below cliff: ${p.dips.length}  total depth ${m(p.dipDepthUsd)}${p.dips.length ? "  " + p.dips.map((d) => `[${d.fromAt}→${d.toAt ?? "open"} min ${m(d.minLpUsd)} depth ${m(d.depthUsd)}]`).join(" ") : ""}`);
  L.push(`tailProgress ${m(p.tailProgressStartUsd)} → ${m(p.tailProgressEndUsd)}  speed ${m(p.tailSpeedUsdPerHour)}/h`);
  L.push(`supply ${b(p.supplyStartPaper)} → ${b(p.supplyEndPaper)} PAPER  tail-curve explains ${b(p.tailEmissionPaper)}  outside the curve ${b(p.flatEmissionPaper)}`);
  L.push(`remaining tail emission ${b(p.remainingTailPaper)}  limit supply with no further dip ${b(p.limitSupplyPaper)}`);
  return L.join("\n");
}

if (process.argv[1] && /summary-recorder\.ts$/.test(process.argv[1])) {
  const o = parseRecorderArgs(process.argv.slice(2));
  if (o.report) {
    console.log(renderReport(analyze(readRecords(o.out))));
  } else {
    console.log(`recording ${o.origin}/query/protocol/summary every ${o.intervalMs / 1000} s → ${o.out}${o.rounds ? ` (${o.rounds} rounds)` : ""}`);
    runRecorder(o).then((r) => console.log(`done: ${r.samples} samples, ${r.errors} errors`)).catch((e) => { console.error(`FAILED: ${e?.message ?? e}`); process.exit(1); });
  }
}
