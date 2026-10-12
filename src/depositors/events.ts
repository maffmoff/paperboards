// Papertrade Exchange events relevant to deposits.
//
// The Exchange ABI is not published. The topic hashes below were observed on
// HyperEVM mainnet (2026-10-09) and confirmed to be PUSH32 constants in the
// Exchange implementation bytecode. Their field layout was read from live
// transaction receipts, not from a source file, so the names are descriptive
// labels rather than the contract's own event names.

export type Hex = `0x${string}`;

/**
 * Emitted by the Exchange when a deposit that arrived through the user's
 * DepositProxy is registered.
 *   topics[1] = user, topics[2] = proxy
 *   data      = (amount in USDC with 8 decimals, second amount slot, block number)
 * Almost every deposit fills the first slot and leaves the second 0; a few
 * (46 of 31,849 by 2026-10-12, e.g. tx 0x47cd4334…) carry the amount in the
 * second slot with the first 0, and none fill both. The amount is their sum.
 * The 8-decimal scale is HyperCore's USDC scale; it matches the official
 * leaderboard balances (18 decimals) exactly once rescaled.
 */
export const DEPOSIT_TOPIC: Hex = "0x02d61879cd72906e0951e3a96096407dd2b1f2cd2d063dae983bb20216cf3025";

/**
 * Emitted by the Exchange when a withdrawToCore is executed.
 *   topics[1] = user
 *   data      = (amount debited from the account, 18dp; amount paid out, USDC 8dp)
 * The payout is the debit less the withdrawal fee, usually $1 (tx 0xde327ffe…:
 * 51.177942e18 debited, 50.177942e8 paid), sometimes 0. The account balance
 * moves by the debit, so that is the amount recorded.
 */
export const WITHDRAW_TOPIC: Hex = "0x95d1a93901f24eeaa294588802f66fa008f9f3741060c9f79e5dab4709de5e75";

export interface RawLog {
  address: Hex;
  topics: Hex[];
  data: Hex;
  blockNumber: Hex;
  transactionHash: Hex;
  logIndex: Hex;
}

export interface DepositEvent {
  kind: "deposit";
  user: Hex;
  proxy: Hex;
  /** USDC with 8 decimals (HyperCore scale), as emitted. */
  amountUsdc: bigint;
  block: number;
  txHash: Hex;
  logIndex: number;
}

export interface WithdrawEvent {
  kind: "withdraw";
  user: Hex;
  amountUsdc: bigint;
  block: number;
  txHash: Hex;
  logIndex: number;
}

export type ExchangeEvent = DepositEvent | WithdrawEvent;

export function topicToAddress(topic: Hex): Hex {
  return `0x${topic.slice(-40).toLowerCase()}` as Hex;
}

export function dataWords(data: Hex): bigint[] {
  const body = data.slice(2);
  const out: bigint[] = [];
  for (let i = 0; i + 64 <= body.length; i += 64) out.push(BigInt(`0x${body.slice(i, i + 64)}`));
  return out;
}

/** Returns null for logs that are not one of the two tracked events. */
export function decodeExchangeLog(log: RawLog): ExchangeEvent | null {
  const topic0 = log.topics[0]?.toLowerCase();
  const block = Number(BigInt(log.blockNumber));
  const logIndex = Number(BigInt(log.logIndex));
  const words = dataWords(log.data);
  if (topic0 === DEPOSIT_TOPIC && log.topics.length === 3 && words.length >= 1) {
    return {
      kind: "deposit",
      user: topicToAddress(log.topics[1]),
      proxy: topicToAddress(log.topics[2]),
      amountUsdc: words[0] + (words[1] ?? 0n),
      block,
      txHash: log.transactionHash,
      logIndex,
    };
  }
  if (topic0 === WITHDRAW_TOPIC && log.topics.length === 2 && words.length >= 2) {
    return {
      kind: "withdraw",
      user: topicToAddress(log.topics[1]),
      amountUsdc: words[0] / 10n ** 10n, // the 18dp debit at the 8dp scale of every other amount
      block,
      txHash: log.transactionHash,
      logIndex,
    };
  }
  return null;
}

/**
 * PaperStaking `Claimed(address,uint256)`: a staker claimed USDC rewards.
 *   topics[1] = user, data = (amount, USDC with 18 decimals)
 * The name was recovered by matching keccak256("Claimed(address,uint256)") to the
 * observed topic (2026-10-11); siblings on the same contract match Staked,
 * Unstaked and Distributed(uint256,uint256,uint256,uint256).
 */
export const CLAIMED_TOPIC: Hex = "0xd8138f8a3f377c5259ca548e70e4c2de94f129f5a11036a15b69513cba2b426a";

export interface ClaimEvent {
  user: Hex;
  amount18: bigint;
  block: number;
  txHash: Hex;
  logIndex: number;
}

/** Returns null unless the log is a Claimed event emitted by `staking`. */
export function decodeClaimLog(log: RawLog, staking: string): ClaimEvent | null {
  if (log.address.toLowerCase() !== staking.toLowerCase()) return null;
  if (log.topics[0]?.toLowerCase() !== CLAIMED_TOPIC || log.topics.length !== 2) return null;
  const words = dataWords(log.data);
  if (words.length < 1) return null;
  return { user: topicToAddress(log.topics[1]), amount18: words[0], block: Number(BigInt(log.blockNumber)), txHash: log.transactionHash, logIndex: Number(BigInt(log.logIndex)) };
}

export const serializeClaim = (e: ClaimEvent): Record<string, unknown> => ({ ...e, amount18: e.amount18.toString() });
export const deserializeClaim = (o: Record<string, unknown>): ClaimEvent => ({ ...(o as object), amount18: BigInt(o.amount18 as string) }) as ClaimEvent;

/**
 * Exchange dev-fee claim (2026-10-11, from the receipts of the dev fee recipient's
 * "Claim Dev Fees" calls, selector 0x88f2aea5): the owner-set recipient moved the
 * accumulated dev half of trading fees (docs: half of each 2% fee goes to stakers,
 * half to the dev fee recipient) into its Exchange balance.
 *   topics[1] = recipient, data = (amount 18dp, amount 18dp)
 * The event name is not published; the topic is a PUSH32 constant in the
 * Exchange implementation like the others here.
 */
export const DEV_FEE_CLAIMED_TOPIC: Hex = "0x8163d4e6d566c87ca3ced41f12809febe576911226e4d7165eb7178e74557a6f";

export interface DevFeeClaimEvent {
  recipient: Hex;
  amount18: bigint;
  block: number;
  txHash: Hex;
  logIndex: number;
}

/** Returns null unless the log is a dev-fee claim emitted by `exchange`. */
export function decodeDevFeeClaimLog(log: RawLog, exchange: string): DevFeeClaimEvent | null {
  if (log.address.toLowerCase() !== exchange.toLowerCase()) return null;
  if (log.topics[0]?.toLowerCase() !== DEV_FEE_CLAIMED_TOPIC || log.topics.length !== 2) return null;
  const words = dataWords(log.data);
  if (words.length < 1) return null;
  return { recipient: topicToAddress(log.topics[1]), amount18: words[0], block: Number(BigInt(log.blockNumber)), txHash: log.transactionHash, logIndex: Number(BigInt(log.logIndex)) };
}

export const serializeDevFeeClaim = (e: DevFeeClaimEvent): Record<string, unknown> => ({ ...e, amount18: e.amount18.toString() });
export const deserializeDevFeeClaim = (o: Record<string, unknown>): DevFeeClaimEvent => ({ ...(o as object), amount18: BigInt(o.amount18 as string) }) as DevFeeClaimEvent;

export function eventKey(e: ExchangeEvent | ClaimEvent | DevFeeClaimEvent): string {
  return `${e.txHash}:${e.logIndex}`;
}

/** JSON helpers: bigint <-> decimal string. */
export function serializeEvent(e: ExchangeEvent): Record<string, unknown> {
  return { ...e, amountUsdc: e.amountUsdc.toString() };
}

export function deserializeEvent(o: Record<string, unknown>): ExchangeEvent {
  return { ...(o as object), amountUsdc: BigInt(o.amountUsdc as string) } as ExchangeEvent;
}
