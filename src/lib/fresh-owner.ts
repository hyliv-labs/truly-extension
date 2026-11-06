/**
 * Never hand out an owner address that was already used.
 *
 * The owner index lives in chrome.storage and only moves forward, but a
 * restored vault (or a reinstall) starts it at 0 again. Measured: after a
 * restore, the next deposit was planned on owner #0, the address an earlier
 * test had already funded and traded from, with 1.00 USDC still on its
 * Lighter account. Each trade is meant to get an address with no history.
 *
 * So before a trade takes an address, the chain is asked whether it has a
 * history: any transaction sent, or any ETH or USDC held. A used address is
 * retired and the next one checked. The reads go over anon-rpc, so the RPC
 * cannot tell they belong together. Lighter is deliberately NOT asked: a
 * burst of account lookups for consecutive addresses from one IP would tell
 * Lighter exactly that.
 */

import type { Address } from 'viem';
import { erc20Abi } from 'viem';
import { publicClient } from './chain';
import { USDC_ADDRESS } from './config';
import { currentOwner, retireOwner } from './vault';

export interface AddressHistory {
  readonly nonce: number;
  readonly ethWei: bigint;
  readonly usdcUnits: bigint;
}

export function hasHistory(history: AddressHistory): boolean {
  return history.nonce > 0 || history.ethWei > 0n || history.usdcUnits > 0n;
}

async function readHistory(address: Address): Promise<AddressHistory> {
  const [nonce, ethWei, usdcUnits] = await Promise.all([
    publicClient.getTransactionCount({ address }),
    publicClient.getBalance({ address }),
    publicClient.readContract({ address: USDC_ADDRESS, abi: erc20Abi, functionName: 'balanceOf', args: [address] }),
  ]);
  return { nonce, ethWei, usdcUnits };
}

export interface FreshOwnerDeps {
  readonly current: () => Promise<{ index: number; address: Address }>;
  readonly retire: (index: number) => Promise<void>;
  readonly read: (address: Address) => Promise<AddressHistory>;
}

let historyReader: (address: Address) => Promise<AddressHistory> = readHistory;

/** For offline checks only: replace the chain read. */
export function setHistoryReaderForTests(read: (address: Address) => Promise<AddressHistory>): void {
  historyReader = read;
}

const defaultDeps: FreshOwnerDeps = {
  current: currentOwner,
  retire: retireOwner,
  read: (address) => historyReader(address),
};

/** Move the owner index past every used address. Returns the fresh index. */
export async function skipUsedOwners(deps: FreshOwnerDeps = defaultDeps, limit = 25): Promise<number> {
  for (let checked = 0; checked < limit; checked += 1) {
    const owner = await deps.current();
    if (!hasHistory(await deps.read(owner.address))) return owner.index;
    await deps.retire(owner.index);
  }
  throw new Error(
    `The next ${limit} addresses from this vault all have on-chain history. Use "Scan for funds left at old addresses", then try again.`,
  );
}
