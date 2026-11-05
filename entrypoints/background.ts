/**
 * Background service worker: the only place key material is ever handled.
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

const AUTO_LOCK_ALARM = 'truly:auto-lock';
const AUTO_LOCK_MINUTES = 15;

export default defineBackground(() => {
  chrome.runtime.onInstalled.addListener(() => {
    console.info('[truly] installed');
  });

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === AUTO_LOCK_ALARM) void autoLock();
  });

  chrome.runtime.onMessage.addListener((message: Request, _sender, sendResponse) => {
    if (typeof message?.kind !== 'string') return false;

    handle(message)
      .then((value) => sendResponse({ ok: true, value } satisfies Response<unknown>))
      .catch((error: unknown) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        } satisfies Response<never>),
      );

    // Keeps the message channel open for the async reply.
    return true;
  });
});

async function handle(message: Request): Promise<unknown> {
  switch (message.kind) {
    case 'status':
      return {
        hasVault: await hasVault(),
        unlocked: await isUnlocked(),
        ownerIndex: await getOwnerIndex(),
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
