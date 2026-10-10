// Unclaimed staking rewards, read from PaperStaking through Multicall3 in batches.
//
// PaperStaking's ABI is not published. `pendingReward(address)` (0xf40f0f52) was found
// among the implementation's selectors (proxy 0xaad6…f016 -> impl 0xe6e3…bb15) and checked
// on 2026-10-11: it equals pendingBase + stakedBalance * accumulator / 1e27 - rewardDebt,
// the formula the official frontend uses for "Claimable Rewards". The similarly named
// `pendingRewards(address)` returns only the stored pendingBase part.

import { decodeFunctionResult, encodeFunctionData, parseAbi, type Hex } from "viem";

export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
export const PENDING_BATCH = 500;

const stakingAbi = parseAbi(["function pendingReward(address user) view returns (uint256)"]);
const multicallAbi = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) payable returns (Result[] returnData)",
]);

export function encodePendingBatch(staking: Hex, users: readonly Hex[]): Hex {
  return encodeFunctionData({
    abi: multicallAbi,
    functionName: "aggregate3",
    args: [users.map((u) => ({ target: staking, allowFailure: true, callData: encodeFunctionData({ abi: stakingAbi, functionName: "pendingReward", args: [u] }) }))],
  });
}

/** One entry per user; null where the inner call failed. */
export function decodePendingBatch(data: Hex): (bigint | null)[] {
  const results = decodeFunctionResult({ abi: multicallAbi, functionName: "aggregate3", data });
  return results.map((r) => (r.success && r.returnData.length >= 66 ? (decodeFunctionResult({ abi: stakingAbi, functionName: "pendingReward", data: r.returnData }) as bigint) : null));
}
