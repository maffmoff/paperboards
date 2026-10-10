import { describe, expect, it } from "vitest";
import { decodeFunctionData, encodeAbiParameters, encodeFunctionResult, parseAbi } from "viem";
import { decodePendingBatch, encodePendingBatch } from "./pending.js";

const STAKING = "0xaad6c7b0cc3014fc80ffedae0ed7ce5967b0f016";
const A = "0x000000000000000000000000000000000000000a", B = "0x000000000000000000000000000000000000000b";
const multicallAbi = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) payable returns (Result[] returnData)",
]);

describe("pending reward batch", () => {
  it("encodes one pendingReward(address) call per user against the staking contract", () => {
    const { args } = decodeFunctionData({ abi: multicallAbi, data: encodePendingBatch(STAKING, [A, B]) });
    const calls = args[0] as readonly { target: string; allowFailure: boolean; callData: string }[];
    expect(calls.map((c) => c.target.toLowerCase())).toEqual([STAKING, STAKING]);
    expect(calls.every((c) => c.allowFailure && c.callData.startsWith("0xf40f0f52"))).toBe(true);
    expect(calls[1].callData.endsWith("b")).toBe(true);
  });

  it("decodes amounts and maps failed calls to null", () => {
    const data = encodeFunctionResult({
      abi: multicallAbi,
      functionName: "aggregate3",
      result: [
        { success: true, returnData: encodeAbiParameters([{ type: "uint256" }], [123n]) },
        { success: false, returnData: "0x" },
      ],
    });
    expect(decodePendingBatch(data)).toEqual([123n, null]);
  });
});
