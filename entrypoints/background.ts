/**
 * Background service worker: the only place key material is ever handled, and
 * the only place a provider request is ever answered.
 *
 * MV3 tears this worker down after ~30s idle, so nothing durable may live in a
 * module-level variable. The unlocked seed goes to chrome.storage.session and
 * the auto-lock is a chrome.alarms alarm, not a setTimeout, which would die
 * with the worker.
 */

// MUST BE FIRST. ffjavascript, pulled in transitively by the Privacy Pools
// SDK, calls URL.createObjectURL at module level — and that does not exist in
// a service worker, so the import throws and the worker never registers.
// ESM evaluates imports in order, so this side-effect module has to precede
// anything that reaches the SDK.
import { swGlobalsInstalled } from '@truly/shims/sw-globals';

import type { Request, Response } from '@truly/lib/messages';
import {
  createVault,
  currentOwner,
  getOwnerIndex,
  hasVault,
  isUnlocked,
  lock,
  unlock,
  requireUnlockedMnemonic,
} from '@truly/lib/vault';
import { endTrade, getActiveTrade, startTrade } from '@truly/lib/trade';
import { handleProviderRequest, settle } from '@truly/lib/provider';
import { getApproval } from '@truly/lib/approvals';
import { getReadCount } from '@truly/lib/anon-rpc';
import { checkDeposit, prepareDeposit } from '@truly/lib/deposit';
import { unshieldForTrade } from '@truly/lib/unshield';
import { findSpendableNotes, totalSpendable } from '@truly/lib/discovery';
import { authoritativeScope } from '@truly/lib/pool';
import {
  buildSeedDerivationTypedData,
  deriveMnemonicFromWalletSignature,
} from '@truly/lib/wallet-seed';
import type { Address, Hex } from 'viem';
import { canRetire, getTradeStatus } from '@truly/lib/orchestrator';
import { scanForStrandedFunds } from '@truly/lib/recovery-scan';
import {
  clearRecoveryState,
  getRecoveryState,
  startMetaMaskRecovery,
} from '@truly/lib/recovery';
import { configProblems, USDC_ADDRESS } from '@truly/lib/config';
import { publicClient } from '@truly/lib/chain';
import { erc20Abi } from 'viem';

const AUTO_LOCK_ALARM = 'truly:auto-lock';
const AUTO_LOCK_MINUTES = 15;

/**
 * Deposit credit takes ~15-20 minutes without fast-bridge capacity, so poll on
 * an alarm. setInterval would die with the worker; the minimum period Chrome
 * honours for an unpacked extension is 1 minute.
 */
const DEPOSIT_ALARM = 'truly:deposit-poll';
const DEPOSIT_POLL_MINUTES = 1;

export default defineBackground({
  /**
   * An ES MODULE service worker, not the default single IIFE bundle.
   *
   * E3 pulls the Privacy Pools SDK into the worker — note discovery needs
   * AccountService and DataService — and that SDK contains dynamic import()s.
   * The bundler then wants to code-split, which IIFE cannot express, and the
   * build fails with "Invalid value 'iife' for option output.format", naming
   * neither the SDK nor the import that caused it.
   *
   * WXT routes a module background through its ESM group rather than lib mode
   * (see group-entrypoints), so splitting is allowed there. MV3 supports
   * "type": "module" on the service worker.
   *
   * Unrelated to the anon-rpc blob: importScripts in the CSP below — those run
   * in the sandboxed Worker inside the offscreen document, not in this worker.
   */
  type: 'module',
  main() {
    chrome.runtime.onInstalled.addListener(() => {
      console.info('[truly] installed');
    });

    // Reads the shim's export so the module cannot be tree-shaken. Without a
    // referenced binding the bundler drops it, and the worker goes back to
    // dying on URL.createObjectURL before any of this runs.
    console.info('[truly] worker up; sw globals installed:', swGlobalsInstalled);

    // Chrome may drop alarms across a browser restart. A deposit in flight has
    // real money sitting at an intent address, so re-arm rather than relying on
    // the user reopening the popup.
    chrome.runtime.onStartup.addListener(() => {
      void resumeDepositWatch();
    });

    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === AUTO_LOCK_ALARM) void autoLock();
      if (alarm.name === DEPOSIT_ALARM) void pollDeposit();
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
  },
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

    case 'endTrade': {
      // Retiring burns the owner index. Doing that mid-deposit or
      // mid-withdrawal leaves funds at an address the UI no longer shows —
      // recoverable only via the scan, and only if the user thinks to run it.
      const { ok, reason } = await canRetire();
      if (!ok) {
        throw new Error(
          `${reason ?? 'This trade is not finished.'} Use Abandon if you intend to retire it anyway.`,
        );
      }
      await endTrade();
      await chrome.alarms.clear(DEPOSIT_ALARM);
      return null;
    }

    case 'abandonTrade':
      // Deliberate escape hatch: the user has been warned and chosen to
      // retire an unfinished trade. The seed still reaches the funds.
      await endTrade();
      // Stop watching immediately rather than letting the next tick discover
      // there is no trade: that tick would be a network call tying this owner
      // to a moment after the trade closed.
      await chrome.alarms.clear(DEPOSIT_ALARM);
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

    case 'tradeStatus':
      return getTradeStatus();

    case 'scanStranded': {
      const found = await scanForStrandedFunds();
      // bigint does not survive the message channel.
      return found.map((f) => ({
        index: f.index,
        address: f.address,
        balance: f.balance.toString(),
      }));
    }

    case 'metamaskRecoverStart':
      // Returns immediately; the job outlives the popup.
      await startMetaMaskRecovery(message.password, message.version);
      return null;

    case 'metamaskRecoverStatus':
      return getRecoveryState();

    case 'metamaskRecoverClear':
      await clearRecoveryState();
      return null;

    case 'seedTypedData':
      // Shown to the user so they can compare it against what their wallet
      // displays before signing.
      return {
        json: JSON.stringify(
          buildSeedDerivationTypedData(message.address as Address, message.version),
          null,
          2,
        ),
      };

    case 'importWalletSeed': {
      // Derive first: an invalid signature must not create a vault that then
      // has to be destroyed.
      const mnemonic = await deriveMnemonicFromWalletSignature(
        message.signature as Hex,
        message.address as Address,
        message.version,
      );
      const result = await createVault(message.password, mnemonic);
      await touchAutoLock();
      return result;
    }

    case 'prepareDeposit': {
      const intentAddress = await prepareDeposit();
      // Start watching only once there is somewhere for funds to land.
      await chrome.alarms.create(DEPOSIT_ALARM, {
        periodInMinutes: DEPOSIT_POLL_MINUTES,
      });
      return { intentAddress };
    }

    case 'checkDeposit':
      return checkDeposit();

    case 'unshield': {
      // Long-running: a withdrawal proof plus relaying. The popup may well be
      // closed before this resolves, which is fine — unshieldForTrade writes
      // its record only on confirmed on-chain success, so the result survives
      // in the trade state rather than in this response.
      const result = await unshieldForTrade();
      await touchAutoLock();
      return {
        txHash: result.txHash,
        amountUnits: result.amountUnits.toString(),
        expectedNetUnits: result.expectedNetUnits.toString(),
        remainderUnits: result.remainderUnits.toString(),
        feeBPS: result.feeBPS.toString(),
        recipient: result.recipient,
      };
    }

    case 'poolBalance': {
      // A full pool scan, so not cheap: the popup asks for it, rather than
      // polling it.
      const mnemonic = await requireUnlockedMnemonic();
      const scope = await authoritativeScope();
      const notes = await findSpendableNotes(mnemonic, scope);
      const largest = notes.reduce((max, n) => (n.value > max ? n.value : max), 0n);
      return {
        totalUnits: totalSpendable(notes).toString(),
        noteCount: notes.length,
        largestUnits: largest.toString(),
      };
    }

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

/** Re-arm the deposit watch if a trade is still waiting on credit. */
async function resumeDepositWatch(): Promise<void> {
  const trade = await getActiveTrade();
  if (!trade?.intentAddress || trade.accountIndex !== undefined) return;

  await chrome.alarms.create(DEPOSIT_ALARM, {
    periodInMinutes: DEPOSIT_POLL_MINUTES,
  });
  console.info('[truly] resumed deposit watch for owner', trade.ownerIndex);
}

/**
 * One deposit poll. Stops the alarm once credited, and on any error leaves it
 * running: a transient API failure must not abandon a deposit in flight.
 */
async function pollDeposit(): Promise<void> {
  try {
    const progress = await checkDeposit();

    if (progress.complete) {
      await chrome.alarms.clear(DEPOSIT_ALARM);
      console.info('[truly] deposit credited, account', progress.accountIndex);
      return;
    }

    if (progress.claimable) {
      // Waiting will not credit these funds, and polling through it looks
      // identical to a slow deposit.
      await chrome.alarms.clear(DEPOSIT_ALARM);
      console.warn('[truly] deposit is claimable and needs an action');
      return;
    }

    if (progress.failed) {
      // Polling a dead deposit forever would look identical to waiting.
      await chrome.alarms.clear(DEPOSIT_ALARM);
      console.error('[truly] deposit failed:', progress.status, progress.description);
    }
  } catch (error) {
    // No active trade means the trade ended; nothing left to watch.
    if (errorMessage(error) === 'no active trade') {
      await chrome.alarms.clear(DEPOSIT_ALARM);
      return;
    }
    console.warn('[truly] deposit poll failed, will retry', error);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRpcError(error: unknown): error is Error & { code: number } {
  return error instanceof Error && typeof (error as { code?: unknown }).code === 'number';
}
