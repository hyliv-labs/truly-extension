/**
 * Background service worker: the only place key material is ever handled, and
 * the only place a provider request is ever answered.
 *
 * MV3 tears this worker down after ~30s idle, so nothing durable may live in a
 * module-level variable. The unlocked seed goes to chrome.storage.session and
 * the auto-lock is a chrome.alarms alarm, not a setTimeout, which would die
 * with the worker.
 */

import type { Request, Response } from '@truly/lib/messages';
import {
  createVault,
  currentOwner,
  getOwnerIndex,
  hasVault,
  isUnlocked,
  lock,
  unlock,
} from '@truly/lib/vault';
import { endTrade, getActiveTrade, startTrade } from '@truly/lib/trade';
import { handleProviderRequest, settle } from '@truly/lib/provider';
import { getApproval } from '@truly/lib/approvals';
import { getReadCount } from '@truly/lib/anon-rpc';
import { configProblems, USDC_ADDRESS } from '@truly/lib/config';
import { publicClient } from '@truly/lib/chain';
import { erc20Abi } from 'viem';

const AUTO_LOCK_ALARM = 'truly:auto-lock';
const AUTO_LOCK_MINUTES = 15;

export default defineBackground(() => {
  chrome.runtime.onInstalled.addListener(() => {
    console.info('[truly] installed');
  });

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === AUTO_LOCK_ALARM) void autoLock();
  });

  chrome.runtime.onMessage.addListener((message: Request, sender, sendResponse) => {
    if (typeof message?.kind !== 'string') return false;

    handle(message, sender)
      .then((value) => sendResponse({ ok: true, value } satisfies Response<unknown>))
      .catch((error: unknown) =>
        sendResponse({
          ok: false,
          error: errorMessage(error),
          // Preserve the EIP-1193 code so the dapp can tell a user rejection
          // (4001) from an unsupported method (4200).
          ...(isRpcError(error) ? { rpc: { code: error.code, message: error.message } } : {}),
        }),
      );

    // Keeps the message channel open for the async reply.
    return true;
  });
});

async function handle(
  message: Request,
  sender: chrome.runtime.MessageSender,
): Promise<unknown> {
  switch (message.kind) {
    case 'status':
      return {
        hasVault: await hasVault(),
        unlocked: await isUnlocked(),
        ownerIndex: await getOwnerIndex(),
        activeTrade: await getActiveTrade(),
      };

    case 'createVault': {
      const result = await createVault(message.password, message.mnemonic);
      await touchAutoLock();
      return result;
    }

    case 'unlock':
      await unlock(message.password);
      await touchAutoLock();
      return null;

    case 'lock':
      await autoLock();
      return null;

    case 'currentOwner': {
      const owner = await currentOwner();
      await touchAutoLock();
      // Address only; the private key must not leave the worker.
      return { index: owner.index, address: owner.address };
    }

    case 'startTrade': {
      const trade = await startTrade();
      await touchAutoLock();
      return trade;
    }

    case 'endTrade':
      await endTrade();
      return null;

    case 'provider': {
      // Trust the sender's own URL over anything the page claims: a page cannot
      // forge the origin of the content script that relays for it.
      const origin = sender.origin ?? message.origin;
      // Temporary: needed to learn which methods Lighter actually calls.
      // TODO(E5): remove once the connect + authorize flow is confirmed.
      console.info('[truly] rpc', origin, message.method, message.params);
      const result = await handleProviderRequest(origin, message.method, message.params);
      await touchAutoLock();
      return result;
    }

    case 'getApproval':
      return getApproval(message.id);

    case 'keepAlive':
      return null;

    case 'anonRpcStatus':
      return { reads: await getReadCount(), problems: configProblems() };

    case 'anonRpcSelfTest': {
      // E2's done-criterion: one eth_blockNumber and one USDC balance read,
      // both returning through the harness.
      const blockNumber = await publicClient.getBlockNumber();
      const owner = await currentOwner();
      const balance = await publicClient.readContract({
        address: USDC_ADDRESS,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [owner.address],
      });
      return {
        blockNumber: blockNumber.toString(),
        usdcBalance: balance.toString(),
      };
    }

    case 'settleApproval':
      await settle(message.id, message.approved);
      return null;

    default: {
      const unreachable: never = message;
      throw new Error(`unknown request: ${JSON.stringify(unreachable)}`);
    }
  }
}

async function autoLock(): Promise<void> {
  await lock();
  await chrome.alarms.clear(AUTO_LOCK_ALARM);
  console.info('[truly] locked');
}

/** Restart the idle countdown. Called on every authenticated action. */
async function touchAutoLock(): Promise<void> {
  await chrome.alarms.create(AUTO_LOCK_ALARM, {
    delayInMinutes: AUTO_LOCK_MINUTES,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRpcError(error: unknown): error is Error & { code: number } {
  return error instanceof Error && typeof (error as { code?: unknown }).code === 'number';
}
