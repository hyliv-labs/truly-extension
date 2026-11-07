import { parseTransaction, type Hex } from 'viem';

/**
 * Gas limit Arbitrum will accept for this calldata.
 *
 * A limit that only covers Ethereum's 21,000 is rejected with "intrinsic gas
 * too low", because the calldata also has to be posted to Ethereum. The
 * unshield that landed (1,363,258 gas, 1,476 bytes) is the measurement: 1,000
 * gas per byte clears it. `suggested` wins when the caller already has a
 * higher figure, such as the Railgun estimate.
 */
export function arbitrumGasLimit(data: Hex | undefined, suggested = 0n): bigint {
  const bytes = BigInt(Math.max(0, ((data?.length ?? 2) - 2) / 2));
  const floor = 100_000n + bytes * 1_000n;
  return suggested > floor ? suggested : floor;
}

/**
 * The most ETH a signed transaction can cost its sender: gas limit times the
 * fee cap, plus the value it carries. This is what a node checks before it
 * accepts the transaction, so a sender holding less is refused outright.
 *
 * Why it exists: the Railgun unshield was given a fixed 0.00005 ETH. Measured
 * on owner #1: the node wanted 0.0000570 ETH, refused the broadcast with
 * "insufficient funds for gas * price + value", and the funding sat retrying
 * the same refused bytes. Reading the cost from the signed bytes is exact.
 */
export function maxCostWei(raw: Hex): bigint {
  const tx = parseTransaction(raw);
  const gas = tx.gas ?? 0n;
  const price = tx.maxFeePerGas ?? tx.gasPrice ?? 0n;
  return gas * price + (tx.value ?? 0n);
}
