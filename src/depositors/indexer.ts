// Scans Papertrade Exchange deposit/withdraw events on HyperEVM and writes the
// depositor ranking consumed by site/.
//
//   npx tsx src/depositors/indexer.ts [--from 47854413] [--to <block>] [--no-names]
//
// Resumable: data/depositors/checkpoint.json keeps every decoded event and the
// block scanned so far, so re-running only fetches new blocks.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { EXCHANGE, ORIGIN, PAPER_STAKING, RPC_URL } from "../config.js";
import { decodeFunctionResult, encodeFunctionData, parseAbi } from "viem";
import {
  CLAIMED_TOPIC,
  DEV_FEE_CLAIMED_TOPIC,
  decodeClaimLog,
  decodeDevFeeClaimLog,
  deserializeDevFeeClaim,
  serializeDevFeeClaim,
  type DevFeeClaimEvent,
  deserializeClaim,
  serializeClaim,
  type ClaimEvent,
  DEPOSIT_TOPIC,
  WITHDRAW_TOPIC,
  decodeExchangeLog,
  deserializeEvent,
  eventKey,
  serializeEvent,
  type ExchangeEvent,
  type Hex,
  type RawLog,
} from "./events.js";
import { buildRanking, makeTimestampInterpolator, type LeaderboardStats } from "./rank.js";
import { curveParams, marketSeries, openInterestSeries, periodFlows, periodRates, protocolSeries, protocolStats, type CurveParams, type HouseHistory, type ProtocolHistory } from "./protocol.js";
import { costWindows } from "./cost-windows.js";
import { MULTICALL3, PENDING_BATCH, decodePendingBatch, encodePendingBatch } from "./pending.js";
import { appendDevFeeSample, devFeeSummary, type DevFeeSample, type DevFeeSummary } from "./devfee.js";
import { logLine } from "../logging.js";
import { SUMMARY_LOG_PATH, analyze, mintHeadline, mintSeries, readRecords, sampleOnce } from "../summary-recorder.js";

/**
 * First HyperEVM block at or after the protocol genesis reported by
 * GET /query/protocol/summary (genesis = 1791326520000 ms, 2026-10-06 22:42:00 UTC).
 * Located by binary search over block timestamps on 2026-10-09.
 */
export const GENESIS_BLOCK = 47854413;

/** Public RPC rejects eth_getLogs ranges wider than 1000 blocks. */
export const MAX_LOG_RANGE = 1000;

export const CHECKPOINT_PATH = "data/depositors/checkpoint.json";
export const RANKING_PATH = "site/data/ranking.json";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Endpoints are used round-robin; a rate-limited reply moves to the next one.
 * Override with PAPERTRADE_RPCS="https://a,https://b". Every endpoint must
 * serve chain 999 and accept 1000-block eth_getLogs ranges.
 */
export const RPC_ENDPOINTS: string[] = (process.env.PAPERTRADE_RPCS || `${RPC_URL},https://rpc.hypurrscan.io`).split(",").map((s) => s.trim()).filter(Boolean);
let rpcCursor = 0;

/** One block timestamp is sampled every TS_SAMPLE_WINDOWS windows for interpolation. */
export const TS_SAMPLE_WINDOWS = 5;

export function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const [k, v] = a.slice(2).split("=", 2);
    out[k] = v ?? (argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true");
  }
  return out;
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  let lastError = "";
  for (let attempt = 0; attempt < 12; attempt++) {
    const url = RPC_ENDPOINTS[rpcCursor++ % RPC_ENDPOINTS.length];
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }).catch((e: Error) => e);
    if (res instanceof Error) {
      lastError = res.message;
    } else {
      const body = (await res.json().catch(() => null)) as { result?: T; error?: { message?: string } } | null;
      if (body && body.result !== undefined) return body.result;
      lastError = body?.error?.message ?? `HTTP ${res.status}`;
      if (!/rate limit|429|timeout|busy/i.test(lastError) && res.status !== 429 && res.status < 500) {
        throw new Error(`${method}: ${lastError}`);
      }
    }
    // Try the next endpoint right away; back off only once every endpoint has refused.
    await sleep(attempt % RPC_ENDPOINTS.length === RPC_ENDPOINTS.length - 1 ? 1000 * (attempt + 1) : 100);
  }
  throw new Error(`${method}: gave up (${lastError})`);
}

/**
 * Bumped when the decoding of stored Exchange events changes; a checkpoint with an older value rescans the Exchange
 * events from fromBlock once (claims and dev fees are deduplicated, so they are kept).
 *   2 (2026-10-12): deposits sum both amount slots; withdrawals record the debit including the fee.
 */
const EVENTS_VERSION = 2;

export interface Checkpoint {
  version: 1;
  eventsVersion?: number;
  chainId: 999;
  exchange: Hex;
  fromBlock: number;
  /** Inclusive. */
  scannedThrough: number;
  events: ExchangeEvent[];
  /** PaperStaking Claimed events, and the block they are scanned through (inclusive). */
  claims: ClaimEvent[];
  claimsThrough: number;
  /** Exchange dev-fee claim events (src/depositors/devfee.ts), and the block they are scanned through (inclusive). */
  devFees: DevFeeClaimEvent[];
  devFeesThrough: number;
  /** One accrual reading per index run (src/depositors/devfee.ts), last 30 days. */
  devFeeSamples: DevFeeSample[];
  /** Sampled [block, unix seconds] pairs used for interpolation. */
  blockTimestamps: [number, number][];
}

function loadCheckpoint(fromBlock: number): Checkpoint {
  if (existsSync(CHECKPOINT_PATH)) {
    const raw = JSON.parse(readFileSync(CHECKPOINT_PATH, "utf8"));
    if (raw.exchange === EXCHANGE && raw.fromBlock === fromBlock) {
      if (raw.eventsVersion !== EVENTS_VERSION) {
        console.error(`checkpoint events decoded by an older version (${raw.eventsVersion ?? 1}): rescanning the exchange events from ${fromBlock}`);
        raw.events = [];
        raw.blockTimestamps = [];
        raw.scannedThrough = fromBlock - 1;
        raw.eventsVersion = EVENTS_VERSION;
      }
      // Checkpoints written before claims were tracked start their claim scan at fromBlock.
      return { ...raw, events: raw.events.map(deserializeEvent), claims: (raw.claims ?? []).map(deserializeClaim), claimsThrough: raw.claimsThrough ?? fromBlock - 1, devFees: (raw.devFees ?? []).map(deserializeDevFeeClaim), devFeesThrough: raw.devFeesThrough ?? fromBlock - 1, devFeeSamples: raw.devFeeSamples ?? [] };
    }
    console.error(`checkpoint ignored: exchange/fromBlock differ (${raw.exchange}, ${raw.fromBlock})`);
  }
  return { version: 1, eventsVersion: EVENTS_VERSION, chainId: 999, exchange: EXCHANGE, fromBlock, scannedThrough: fromBlock - 1, events: [], claims: [], claimsThrough: fromBlock - 1, devFees: [], devFeesThrough: fromBlock - 1, devFeeSamples: [], blockTimestamps: [] };
}

function writeJsonAtomic(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
  renameSync(tmp, path);
}

function saveCheckpoint(cp: Checkpoint) {
  writeJsonAtomic(CHECKPOINT_PATH, { ...cp, events: cp.events.map(serializeEvent), claims: cp.claims.map(serializeClaim), devFees: cp.devFees.map(serializeDevFeeClaim) });
}

async function blockTimestamp(block: number): Promise<number> {
  const b = await rpc<{ timestamp: Hex }>("eth_getBlockByNumber", [`0x${block.toString(16)}`, false]);
  return Number(BigInt(b.timestamp));
}

export interface LeaderboardData {
  names: Map<string, string>;
  /** Address -> PAPER, PnL and balance (18 decimals). */
  stats: Map<string, LeaderboardStats>;
  uniqueAccounts: number | null;
  trackedBalance: string | null;
  trackedPaper: string | null;
}

export const emptyLeaderboard = (): LeaderboardData => ({ names: new Map(), stats: new Map(), uniqueAccounts: null, trackedBalance: null, trackedPaper: null });

/** Fetches display names, PAPER, PnL and balance from the official leaderboard. Fails soft. */
export async function fetchLeaderboard(): Promise<LeaderboardData> {
  const out = emptyLeaderboard();
  try {
    // 200 is refused by the server (HTTP 400); 100 was accepted on 2026-10-11.
    for (const pageSize of [200, 100, 25]) {
      out.names.clear();
      out.stats.clear();
      let totalPages = 1;
      let ok = true;
      for (let page = 0; page < totalPages; page++) {
        // The server requires parameters sorted by name, each once. Address order does not
        // move while paging, unlike balance order, so no account is skipped or seen twice.
        const q = new URLSearchParams({ page: String(page), pageSize: String(pageSize), sortDir: "asc", sortKey: "address", window: "all" });
        const res = await fetch(`${ORIGIN}/state/leaderboard/accounts?${q}`, { headers: { accept: "application/json" } });
        if (res.status === 429) {
          await sleep(Number(res.headers.get("retry-after") ?? "2") * 1000);
          page--;
          continue;
        }
        if (!res.ok) { ok = false; break; }
        const body = (await res.json()) as {
          ok: boolean;
          summary?: { uniqueAccounts: number; trackedBalance: string; trackedPaper?: string };
          accounts: { address: string; leaderboardName: string | null; paperTotal?: string; totalWindowedPnl?: string; realizedPnl?: string; currentUnrealizedPnl?: string; currentBalance?: string }[];
          pageInfo: { totalPages: number };
        };
        if (!body.ok) { ok = false; break; }
        out.uniqueAccounts = body.summary?.uniqueAccounts ?? out.uniqueAccounts;
        out.trackedBalance = body.summary?.trackedBalance ?? out.trackedBalance;
        out.trackedPaper = body.summary?.trackedPaper ?? out.trackedPaper;
        totalPages = body.pageInfo.totalPages;
        for (const a of body.accounts) {
          const address = a.address.toLowerCase();
          if (a.leaderboardName) out.names.set(address, a.leaderboardName);
          if (a.paperTotal || a.currentBalance) {
            out.stats.set(address, {
              paper18: a.paperTotal ?? "0", pnl18: a.totalWindowedPnl ?? "0", realizedPnl18: a.realizedPnl ?? "0",
              unrealizedPnl18: a.currentUnrealizedPnl ?? "0", balance18: a.currentBalance ?? "0",
            });
          }
        }
        await sleep(120);
      }
      if (ok) break;
    }
  } catch (e) {
    console.error(`leaderboard unavailable: ${(e as Error).message}`);
  }
  return out;
}

/** Display names from the Hyperliquid leaderboard (public JSON, ~40 MB). Fails soft. */
export async function fetchHyperliquidNames(): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  try {
    const res = await fetch("https://stats-data.hyperliquid.xyz/Mainnet/leaderboard", { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { leaderboardRows?: { ethAddress: string; displayName: string | null }[] };
    for (const r of body.leaderboardRows ?? []) if (r.displayName) names.set(r.ethAddress.toLowerCase(), r.displayName);
  } catch (e) {
    console.error(`hyperliquid names unavailable: ${(e as Error).message}`);
  }
  return names;
}

/** TVL and the reward-curve inputs from one /query/protocol/summary read. Fails soft. */
async function fetchProtocolSummaryFigures(): Promise<{ tvl: string | null; curve: CurveParams | null }> {
  try {
    const res = await fetch(`${ORIGIN}/query/protocol/summary`, { headers: { accept: "application/json" } });
    if (!res.ok) return { tvl: null, curve: null };
    const body = (await res.json()) as { ok: boolean; balances?: { tvl: string } };
    if (!body.ok) return { tvl: null, curve: null };
    return { tvl: body.balances?.tvl ?? null, curve: curveParams(body) };
  } catch {
    return { tvl: null, curve: null };
  }
}

/** Hourly open interest per market and side (/query/house/history, the official Open Interest chart). Fails soft. */
async function fetchOpenInterest() {
  try {
    const res = await fetch(`${ORIGIN}/query/house/history?interval=1h`, { headers: { accept: "application/json" } });
    if (!res.ok) return null;
    return openInterestSeries((await res.json()) as HouseHistory);
  } catch (e) {
    console.error(`open interest history unavailable: ${(e as Error).message}`);
    return null;
  }
}

/** Hourly protocol history (supply, staked, staking rewards). Fails soft. */
async function fetchProtocolStats() {
  try {
    const res = await fetch(`${ORIGIN}/query/protocol/history?interval=1h`, { headers: { accept: "application/json" } });
    if (!res.ok) return null;
    const h = (await res.json()) as ProtocolHistory;
    const stats = protocolStats(h);
    return stats && { ...stats, series: protocolSeries(h), costWindows: costWindows(h), periods: periodRates(h, Date.now()), market: marketSeries(h), flows: periodFlows(h, Date.now()) };
  } catch (e) {
    console.error(`protocol history unavailable: ${(e as Error).message}`);
    return null;
  }
}

/**
 * One /query/protocol/summary sample per run, appended to data/summary.jsonl (the file src/summary-recorder.ts
 * writes), then the mint-curve headline, the cliff dips seen so far and the binned series for site/. The
 * history endpoint has no trackedLp / tailProgress columns, so this file is the only history of the curve.
 * Fails soft; a refusal is recorded without its body.
 */
export async function fetchMintStats() {
  try {
    const sample = await sampleOnce(ORIGIN);
    logLine(SUMMARY_LOG_PATH, { ...sample });
    if (sample.kind === "error") console.error(`protocol summary unavailable: ${sample.message}`);
    const records = existsSync(SUMMARY_LOG_PATH) ? readRecords(SUMMARY_LOG_PATH) : [];
    if (!records.length) return null;
    const last = records.reduce((a, b) => (b.block >= a.block ? b : a));
    const a = analyze(records);
    return {
      /** The latest sample and the curve's closed forms at it (block, atMs, regime, ratePerUsd, trackedLpUsd, tailProgressUsd, limitSupplyPaper, …). */
      ...mintHeadline(last),
      samples: a.samples,
      sampledFromMs: a.fromAt ? Date.parse(a.fromAt) : null,
      /** Stretches of samples with tracked LP below the cliff: flat-region (100 PAPER/$) emission with no tail progress. */
      dips: a.dips,
      dipDepthUsd: a.dipDepthUsd,
      tailSpeedUsdPerHour: a.tailSpeedUsdPerHour,
      /** Samples binned onto a 10 min grid (null where nothing was sampled) for the charts. */
      series: mintSeries(records),
    };
  } catch (e) {
    console.error(`mint stats unavailable: ${(e as Error).message}`);
    return null;
  }
}

/** Unclaimed staking rewards per user (18 decimals), via Multicall3. Fails soft per batch. */
async function fetchPendingRewards(users: Hex[]): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  for (let i = 0; i < users.length; i += PENDING_BATCH) {
    const batch = users.slice(i, i + PENDING_BATCH);
    try {
      const data = await rpc<Hex>("eth_call", [{ to: MULTICALL3, data: encodePendingBatch(PAPER_STAKING, batch) }, "latest"]);
      decodePendingBatch(data).forEach((v, j) => { if (v !== null) out.set(batch[j], v); });
    } catch (e) {
      console.error(`pending rewards batch ${i / PENDING_BATCH} unavailable: ${(e as Error).message}`);
    }
    await sleep(100);
  }
  return out;
}

const exchangeAbi = parseAbi([
  "function devFeeRecipient() view returns (address)",
  "function devFeeAccumulator() view returns (uint256)",
  "function balances(address user) view returns (uint256)",
]);

/**
 * Live dev-fee state from the Exchange (getters found by name on 2026-10-11, ABI unpublished):
 * the owner-set recipient, the unclaimed accumulator and the recipient's Exchange balance
 * (claims credit that balance; it is where the dev share sits until withdrawn). Fails soft per call.
 */
async function fetchDevFeeLive(): Promise<{ recipient: Hex | null; unclaimed18: bigint | null; recipientBalance18: bigint | null }> {
  const call = async <F extends "devFeeRecipient" | "devFeeAccumulator" | "balances">(functionName: F, args: F extends "balances" ? [Hex] : []) => {
    try {
      const data = await rpc<Hex>("eth_call", [{ to: EXCHANGE, data: encodeFunctionData({ abi: exchangeAbi, functionName, args } as never) }, "latest"]);
      return decodeFunctionResult({ abi: exchangeAbi, functionName, data } as never) as F extends "devFeeRecipient" ? Hex : bigint;
    } catch (e) {
      console.error(`${functionName} unavailable: ${(e as Error).message}`);
      return null;
    }
  };
  const recipient = (await call("devFeeRecipient", [])) as Hex | null;
  const unclaimed18 = (await call("devFeeAccumulator", [])) as bigint | null;
  const recipientBalance18 = recipient ? ((await call("balances", [recipient])) as bigint | null) : null;
  return { recipient: recipient ? (recipient.toLowerCase() as Hex) : null, unclaimed18, recipientBalance18 };
}

export interface IndexOptions {
  fromBlock?: number;
  toBlock?: number;
  withNames?: boolean;
  log?: (line: string) => void;
}

export async function runIndexer(opts: IndexOptions = {}): Promise<{ scannedThrough: number; depositors: number }> {
  const log = opts.log ?? ((l: string) => console.error(l));
  const fromBlock = opts.fromBlock ?? GENESIS_BLOCK;
  const cp = loadCheckpoint(fromBlock);
  const head = opts.toBlock ?? Number(BigInt(await rpc<Hex>("eth_blockNumber", [])));
  const known = new Set(cp.events.map(eventKey));

  if (cp.blockTimestamps.length === 0) cp.blockTimestamps.push([fromBlock, await blockTimestamp(fromBlock)]);

  const knownClaims = new Set(cp.claims.map(eventKey));
  const addClaims = (logs: RawLog[]) => {
    for (const raw of logs) {
      const c = decodeClaimLog(raw, PAPER_STAKING);
      if (!c || knownClaims.has(eventKey(c))) continue;
      knownClaims.add(eventKey(c));
      cp.claims.push(c);
    }
  };

  // One-off backfill: blocks already scanned for Exchange events but not yet for claims.
  if (cp.claimsThrough < cp.scannedThrough) log(`claims backfill ${cp.claimsThrough + 1} -> ${cp.scannedThrough}`);
  while (cp.claimsThrough < cp.scannedThrough) {
    const s = cp.claimsThrough + 1, e = Math.min(s + MAX_LOG_RANGE - 1, cp.scannedThrough);
    addClaims(await rpc<RawLog[]>("eth_getLogs", [{ address: PAPER_STAKING, topics: [CLAIMED_TOPIC], fromBlock: `0x${s.toString(16)}`, toBlock: `0x${e.toString(16)}` }]));
    cp.claimsThrough = e;
    if ((e - fromBlock) % (MAX_LOG_RANGE * 20) < MAX_LOG_RANGE || e === cp.scannedThrough) {
      saveCheckpoint(cp);
      log(`claims through ${e}: ${cp.claims.length} total`);
    }
    await sleep(60);
  }

  const knownDevFees = new Set(cp.devFees.map(eventKey));
  const addDevFees = (logs: RawLog[]) => {
    for (const raw of logs) {
      const c = decodeDevFeeClaimLog(raw, EXCHANGE);
      if (!c || knownDevFees.has(eventKey(c))) continue;
      knownDevFees.add(eventKey(c));
      cp.devFees.push(c);
    }
  };

  // One-off backfill: blocks already scanned before dev-fee claims were tracked.
  if (cp.devFeesThrough < cp.scannedThrough) log(`dev-fee backfill ${cp.devFeesThrough + 1} -> ${cp.scannedThrough}`);
  while (cp.devFeesThrough < cp.scannedThrough) {
    const s = cp.devFeesThrough + 1, e = Math.min(s + MAX_LOG_RANGE - 1, cp.scannedThrough);
    addDevFees(await rpc<RawLog[]>("eth_getLogs", [{ address: EXCHANGE, topics: [DEV_FEE_CLAIMED_TOPIC], fromBlock: `0x${s.toString(16)}`, toBlock: `0x${e.toString(16)}` }]));
    cp.devFeesThrough = e;
    if ((e - fromBlock) % (MAX_LOG_RANGE * 20) < MAX_LOG_RANGE || e === cp.scannedThrough) {
      saveCheckpoint(cp);
      log(`dev-fee claims through ${e}: ${cp.devFees.length} total`);
    }
    await sleep(60);
  }

  let start = cp.scannedThrough + 1;
  let windows = 0;
  log(`scan ${start} -> ${head} (${Math.max(0, head - start + 1)} blocks)`);
  while (start <= head) {
    const end = Math.min(start + MAX_LOG_RANGE - 1, head);
    const logs = await rpc<RawLog[]>("eth_getLogs", [
      { address: [EXCHANGE, PAPER_STAKING], topics: [[DEPOSIT_TOPIC, WITHDRAW_TOPIC, CLAIMED_TOPIC, DEV_FEE_CLAIMED_TOPIC]], fromBlock: `0x${start.toString(16)}`, toBlock: `0x${end.toString(16)}` },
    ]);
    addClaims(logs);
    addDevFees(logs);
    let added = 0;
    for (const raw of logs) {
      const e = decodeExchangeLog(raw);
      if (!e) continue;
      const k = eventKey(e);
      if (known.has(k)) continue;
      known.add(k);
      cp.events.push(e);
      added++;
    }
    windows++;
    if (windows % TS_SAMPLE_WINDOWS === 0 || end === head) cp.blockTimestamps.push([end, await blockTimestamp(end)]);
    cp.scannedThrough = end;
    cp.claimsThrough = end;
    cp.devFeesThrough = end;
    if (windows % 10 === 0 || end === head) {
      saveCheckpoint(cp);
      log(`through ${end}: +${added} events this window, ${cp.events.length} total`);
    }
    start = end + 1;
    await sleep(60);
  }
  cp.events.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  saveCheckpoint(cp);

  const enrichment = opts.withNames === false ? emptyLeaderboard() : await fetchLeaderboard();
  const { tvl, curve } = await fetchProtocolSummaryFigures();
  const openInterest = await fetchOpenInterest();
  const protocol = await fetchProtocolStats();
  const depositors = [...new Set(cp.events.filter((e) => e.kind === "deposit").map((e) => e.user))];
  const pending = await fetchPendingRewards(depositors);
  log(`pending rewards read for ${pending.size}/${depositors.length} depositors`);
  const mint = await fetchMintStats();
  const devFeeLive = await fetchDevFeeLive();
  const claimedTotal18 = cp.devFees.reduce((s, c) => s + c.amount18, 0n);
  cp.devFeeSamples = appendDevFeeSample(cp.devFeeSamples, devFeeLive.unclaimed18 == null ? null : { ms: Date.now(), block: cp.scannedThrough, claimed18: claimedTotal18.toString(), unclaimed18: devFeeLive.unclaimed18.toString() });
  saveCheckpoint(cp);
  const devFee: DevFeeSummary = devFeeSummary(cp.devFees, devFeeLive, makeTimestampInterpolator(cp.blockTimestamps), Date.now(), cp.devFeeSamples);
  log(`dev fee: ${devFee.claimCount} claims, ${devFee.claimedTotal18} claimed (18dp), unclaimed ${devFee.unclaimed18 ?? "n/a"}`);
  const hlNames = opts.withNames === false ? new Map<string, string>() : await fetchHyperliquidNames();
  const tsOf = makeTimestampInterpolator(cp.blockTimestamps);
  const { rows, totals } = buildRanking(cp.events, { tsOf, names: enrichment.names, hlNames, stats: enrichment.stats, claims: cp.claims, pending });
  const toTs = cp.blockTimestamps.length ? cp.blockTimestamps[cp.blockTimestamps.length - 1][1] : null;
  writeJsonAtomic(RANKING_PATH, {
    generatedAt: new Date().toISOString(),
    chainId: 999,
    exchange: EXCHANGE,
    staking: PAPER_STAKING,
    explorer: "https://hyperevmscan.io",
    fromBlock,
    toBlock: cp.scannedThrough,
    toBlockTs: toTs,
    totals,
    /** From /query/protocol/history?interval=1h; PAPER and USDC as plain numbers. */
    protocol,
    /** Mint curve from the /query/protocol/summary samples in data/summary.jsonl (src/summary-recorder.ts); USD and PAPER as plain numbers. */
    mint,
    /** Dev half of trading fees (docs: half of each 2% fee to the dev fee recipient): every claim event since genesis, the live unclaimed accumulator and the recipient's Exchange balance (src/depositors/devfee.ts); 18dp strings and hourly USD bins. */
    devFee,
    /** Open interest in USD per market and side, hourly (/query/house/history?interval=1h). */
    openInterest,
    /** Reward-curve inputs from /query/protocol/summary (official chart definitions; src/depositors/protocol.ts). */
    curve,
    crossCheck: {
      /** 18-decimal strings from the official API, for comparison with totals.netUsdc (8 decimals). */
      apiTvl18: tvl,
      apiTrackedBalance18: enrichment.trackedBalance,
      apiUniqueAccounts: enrichment.uniqueAccounts,
      /** Sum of paperTotal over every leaderboard account (18 decimals), including non-depositors. */
      apiTrackedPaper18: enrichment.trackedPaper,
    },
    rows,
  });
  log(`ranking written: ${rows.length} depositors, ${totals.deposits} deposits, net ${totals.netUsdc} (8dp)`);
  return { scannedThrough: cp.scannedThrough, depositors: rows.length };
}

const isMain = process.argv[1] && /indexer\.(ts|js)$/.test(process.argv[1]);
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  runIndexer({
    fromBlock: args.from ? Number(args.from) : undefined,
    toBlock: args.to ? Number(args.to) : undefined,
    withNames: args["no-names"] !== "true",
  }).catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
