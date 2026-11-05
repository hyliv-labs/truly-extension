/**
 * E5 background half: the only place a provider request is ever answered.
 *
 * Two invariants, both load-bearing for privacy:
 *   1. Nothing is answered unless a trade is active — otherwise a page could
 *      fingerprint the user by asking for accounts at any time.
 *   2. Only the active trade's owner address is ever exposed. Never the index,
 *      never a past owner, never a list.
 */

import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import { getActiveTrade } from './trade';
import { currentOwner } from './vault';
import { dropApproval, putApproval } from './approvals';

/** Arbitrum One. */
export const CHAIN_ID_HEX = '0xa4b1';

const APPROVAL_WINDOW = { width: 400, height: 560 } as const;

/**
 * Worker-local. If MV3 tears the worker down while an approval window is open,
 * these settle as errors and the dapp sees a rejection rather than a hang.
 * TODO(E8): persist enough to re-offer the prompt after a teardown.
 */
const pending = new Map<
  string,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>();

export async function handleProviderRequest(
  origin: string,
  method: string,
  params: unknown[] = [],
): Promise<unknown> {
  const trade = await getActiveTrade();
  if (!trade) {
    throw rpcError(4100, 'Truly has no active trade; start one to connect.');
  }

  switch (method) {
    case 'eth_chainId':
      return CHAIN_ID_HEX;

    case 'wallet_switchEthereumChain': {
      const target = (params[0] as { chainId?: string } | undefined)?.chainId;
      if (target && target.toLowerCase() !== CHAIN_ID_HEX) {
        throw rpcError(4902, 'Truly only operates on Arbitrum One.');
      }
      return null;
    }

    case 'eth_accounts':
      // No prompt: this is the "already connected?" probe. The trade gate above
      // is what keeps it from leaking anything.
      return [trade.ownerAddress];

    case 'eth_requestAccounts': {
      await requireApproval({
        origin,
        method,
        ownerAddress: trade.ownerAddress,
      });
      return [trade.ownerAddress];
    }

    case 'personal_sign': {
      const [rawMessage, address] = params as [Hex, string];

      if (address?.toLowerCase() !== trade.ownerAddress.toLowerCase()) {
        throw rpcError(4100, 'Truly will only sign for the active owner.');
      }

      await requireApproval({
        origin,
        method,
        ownerAddress: trade.ownerAddress,
        message: decodeMessage(rawMessage),
      });

      const owner = await currentOwner();
      return privateKeyToAccount(owner.privateKey).signMessage({
        message: { raw: rawMessage },
      });
    }

    default:
      throw rpcError(4200, `Truly does not support ${method}.`);
  }
}

/** Opens the approval window and blocks until the user answers. */
async function requireApproval(input: {
  origin: string;
  method: string;
  ownerAddress: string;
  message?: string;
}): Promise<void> {
  const id = crypto.randomUUID();

  await putApproval({ id, createdAt: Date.now(), ...input });

  const approvalWindow = await chrome.windows.create({
    url: chrome.runtime.getURL(`/approval.html?id=${id}`),
    type: 'popup',
    ...APPROVAL_WINDOW,
  });

  const windowId = approvalWindow?.id;

  return new Promise<void>((resolve, reject) => {
    pending.set(id, { resolve: () => resolve(), reject });

    // Without a window id we cannot tell when the prompt is dismissed, and the
    // dapp would wait forever. Fail closed instead.
    if (windowId === undefined) {
      void settle(id, false, 'Truly could not open the approval window.');
      return;
    }

    // Closing the window is a rejection, not a hang.
    const onClosed = (closedId: number) => {
      if (closedId !== windowId) return;
      chrome.windows.onRemoved.removeListener(onClosed);
      void settle(id, false, 'User rejected the request.');
    };
    chrome.windows.onRemoved.addListener(onClosed);
  });
}

export async function settle(
  id: string,
  approved: boolean,
  reason = 'User rejected the request.',
): Promise<void> {
  const entry = pending.get(id);
  if (!entry) return;
  pending.delete(id);
  await dropApproval(id);

  if (approved) entry.resolve(undefined);
  else entry.reject(rpcError(4001, reason));
}

/** personal_sign carries a hex-encoded UTF-8 string. */
function decodeMessage(raw: Hex): string {
  try {
    const hex = raw.startsWith('0x') ? raw.slice(2) : raw;
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return new TextDecoder().decode(bytes);
  } catch {
    return raw;
  }
}

/** EIP-1193 shaped error so the dapp handles it as a normal provider failure. */
function rpcError(code: number, message: string): Error & { code: number } {
  return Object.assign(new Error(message), { code });
}
