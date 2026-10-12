import { describe, expect, it } from "vitest";
import { CLAIMED_TOPIC, DEPOSIT_TOPIC, WITHDRAW_TOPIC, decodeClaimLog, decodeExchangeLog, deserializeClaim, deserializeEvent, serializeClaim, serializeEvent, type RawLog } from "./events.js";

// Real mainnet logs observed on 2026-10-09 (tx hashes are public on hyperevmscan).
const word = (n: bigint) => n.toString(16).padStart(64, "0");

const depositLog: RawLog = {
  address: "0x6cd5661646289fb6e65ea5c032310fded797d0a2",
  topics: [DEPOSIT_TOPIC, "0x0000000000000000000000008b2066168b710d06978e08dd5fb98577ddcf9713", "0x0000000000000000000000001aa973c9c1a19330f483c25e018ecf5e55d17a8e"],
  data: `0x${word(28_580_000_000n)}${word(0n)}${word(48090652n)}`,
  blockNumber: "0x2ddce1c",
  transactionHash: "0x531910b4501387c024114cd898a93c577edaa3643a2b68c86775afa295d14693",
  logIndex: "0x1",
};

const withdrawLog: RawLog = {
  address: "0x6cd5661646289fb6e65ea5c032310fded797d0a2",
  topics: [WITHDRAW_TOPIC, "0x0000000000000000000000003642c47881295c1c82b9702e9ba730ba7116ab60"],
  data: `0x${word(15_000_000_000_000_000_000n)}${word(1_500_000_000n)}`,
  blockNumber: "0x2ddce71",
  transactionHash: "0x7a7d6ebe010f05a8418cace48f1a7c3beb41837e202eb3a6db2e4c88be99ff69",
  logIndex: "0x1",
};

describe("decodeExchangeLog", () => {
  it("decodes a deposit: user, proxy, 8dp USDC amount, block", () => {
    const e = decodeExchangeLog(depositLog);
    expect(e).toEqual({
      kind: "deposit",
      user: "0x8b2066168b710d06978e08dd5fb98577ddcf9713",
      proxy: "0x1aa973c9c1a19330f483c25e018ecf5e55d17a8e",
      amountUsdc: 28_580_000_000n, // 285.8 USDC at 8 decimals (credited as 285.8e18 in the next block)
      block: 48090652,
      txHash: depositLog.transactionHash,
      logIndex: 1,
    });
  });

  it("decodes a withdrawal as the amount debited (first data word, 18dp, rescaled to 8dp)", () => {
    const e = decodeExchangeLog(withdrawLog);
    expect(e).toMatchObject({ kind: "withdraw", user: "0x3642c47881295c1c82b9702e9ba730ba7116ab60", amountUsdc: 1_500_000_000n, block: 48090737 });
  });

  it("counts the $1 withdrawal fee as withdrawn (debit 51.177942, paid 50.177942; tx 0xde327ffe…)", () => {
    const e = decodeExchangeLog({ ...withdrawLog, data: `0x${word(51_177_942_000_000_000_000n)}${word(5_017_794_200n)}` });
    expect(e).toMatchObject({ kind: "withdraw", amountUsdc: 5_117_794_200n });
  });

  it("reads a deposit whose amount is in the second slot (tx 0xd69904b4…: data 0, 499e6, block)", () => {
    const e = decodeExchangeLog({ ...depositLog, data: `0x${word(0n)}${word(499_000_000n)}${word(48163781n)}` });
    expect(e).toMatchObject({ kind: "deposit", amountUsdc: 499_000_000n });
  });

  it("ignores other events", () => {
    expect(decodeExchangeLog({ ...depositLog, topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", depositLog.topics[1], depositLog.topics[2]] })).toBeNull();
    expect(decodeExchangeLog({ ...depositLog, topics: [DEPOSIT_TOPIC, depositLog.topics[1]] })).toBeNull();
  });

  it("round-trips through JSON", () => {
    const e = decodeExchangeLog(depositLog)!;
    expect(deserializeEvent(JSON.parse(JSON.stringify(serializeEvent(e))))).toEqual(e);
  });
});

describe("decodeClaimLog", () => {
  const STAKING = "0xaad6c7b0cc3014fc80ffedae0ed7ce5967b0f016";
  // Shape of a PaperStaking Claimed log observed on 2026-10-11 (amount 223.53 USDC, 18 decimals).
  const claimLog: RawLog = {
    address: STAKING,
    topics: [CLAIMED_TOPIC, "0x0000000000000000000000004494bb85471aad4a1839981a2ae723716d3c6483"],
    data: `0x${word(223_532_714_230_781_783_076n)}`,
    blockNumber: "0x2df4e00",
    transactionHash: "0x4e5c58b2dd000000000000000000000000000000000000000000000000000000",
    logIndex: "0x3",
  };

  it("decodes user and 18-decimal amount", () => {
    expect(decodeClaimLog(claimLog, STAKING)).toMatchObject({ user: "0x4494bb85471aad4a1839981a2ae723716d3c6483", amount18: 223_532_714_230_781_783_076n, logIndex: 3 });
  });

  it("ignores the same topic from another contract and other topics", () => {
    expect(decodeClaimLog({ ...claimLog, address: "0x6cd5661646289fb6e65ea5c032310fded797d0a2" }, STAKING)).toBeNull();
    expect(decodeClaimLog({ ...claimLog, topics: [DEPOSIT_TOPIC, claimLog.topics[1]] }, STAKING)).toBeNull();
  });

  it("round-trips through JSON helpers", () => {
    const c = decodeClaimLog(claimLog, STAKING)!;
    expect(deserializeClaim(JSON.parse(JSON.stringify(serializeClaim(c))))).toEqual(c);
  });
});
