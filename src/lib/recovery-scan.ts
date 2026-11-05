/**
 * E8's safety net: find money left at owner addresses.
 *
 * Owner addresses are single-use and retired, so nothing watches them after a
 * trade ends. A failed re-shield, a crash between withdrawal and re-shield, or
 * a trade abandoned mid-flight all leave USDC at an address the UI has stopped
 * showing. The seed can regenerate every one of them, so nothing is ever truly
 * lost — but only if something goes looking.
 */

import type { Address } from 'viem';
import { ownerUsdcBalance } from './reshield';
import { getOwnerIndex, ownerAt } from './vault';

/**
 * How far past the last known index to keep looking.
 *
 * The index advances before a trade's funds are committed, so a crash can
 * leave the real money one or two indices beyond the stored pointer. Scanning
 * only up to the pointer would miss exactly the case this exists for.
 */
const LOOKAHEAD = 5;

export interface StrandedFunds {
  readonly index: number;
  readonly address: Address;
  readonly balance: bigint;
}

/**
 * Scan owner indices for leftover USDC.
 *
 * Reads go through the anon-rpc transport like everything else, so a scan is
 * not a privacy hole: it does not reveal to the RPC which addresses belong
 * together.
 */
export async function scanForStrandedFunds(options?: {
  onProgress?: (scanned: number, total: number) => void;
}): Promise<StrandedFunds[]> {
  const highest = await getOwnerIndex();
  const total = highest + LOOKAHEAD + 1;
  const found: StrandedFunds[] = [];

  for (let index = 0; index <= highest + LOOKAHEAD; index++) {
    const owner = await ownerAt(index);
    const balance = await ownerUsdcBalance(owner.address);

    if (balance > 0n) {
      found.push({ index, address: owner.address, balance });
    }

    options?.onProgress?.(index + 1, total);
  }

  return found;
}
