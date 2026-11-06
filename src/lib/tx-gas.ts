import { parseTransaction, type Hex } from 'viem';

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
