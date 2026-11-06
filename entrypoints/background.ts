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
import {
  broadcastProviderEvent,
  grantConnectConsent,
  handleProviderRequest,
  resumePendingApprovals,
  settle,
} from '@truly/lib/provider';
import { getApproval } from '@truly/lib/approvals';
import { getReadCount } from '@truly/lib/anon-rpc';
import { checkDeposit, prepareDeposit } from '@truly/lib/deposit';
import { unshieldForTrade } from '@truly/lib/unshield';
import { reshieldActiveTrade } from '@truly/lib/reshield-trade';
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
import { getFastBridgeLimit } from '@truly/lib/lighter';
import { fetchMarkets } from '@truly/lib/lighter-markets';
import { generateApiKey, signMarketOrder } from '@truly/lib/lighter-signer';
import {
  advanceSession,
  closePosition,
  getSession,
  getSessionView,
  openTradeSession,
  quoteTrade,
  retryFunding,
  retryLighterExit,
  retryOrder,
  runFunding,
  shieldFundedAccount,
} from '@truly/lib/trade-session';
import { forgetShieldedBalance, loadShieldedBalance } from '@truly/lib/shielded-balance';
import { ACTIVE_SESSION_STATES } from '@truly/lib/session-types';
import type { TradeRequest } from '@truly/lib/trade-plan';
import type { TradeRequestWire } from '@truly/lib/messages';

const AUTO_LOCK_ALARM = 'truly:auto-lock';
const AUTO_LOCK_MINUTES = 15;

/**
 * Deposit credit takes ~15-20 minutes without fast-bridge capacity, so poll on
 * an alarm. setInterval would die with the worker; the minimum period Chrome
 * honours for an unpacked extension is 1 minute.
 */
const DEPOSIT_ALARM = 'truly:deposit-poll';
const DEPOSIT_POLL_MINUTES = 1;

/**
 * Drives an in-extension trade session through the steps that wait on the
 * outside world: deposit credit, key registration, order execution. The popup
 * advances it faster while open; this keeps it moving when it is closed.
 */
const SESSION_ALARM = 'truly:session-tick';

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
    chrome.runtime.onInstalled.addListener((details) => {
      console.info('[truly] installed', details.reason);
      // Reloading the extension leaves every OPEN Lighter tab with a dead
      // relay: content scripts only run at document_start, so the page keeps
      // the old disconnected one and announces no provider at all. Truly then
      // simply does not appear in Lighter's wallet list, and the connect fails
      // with 'Connection cancelled' — a symptom that names nothing.
      //
      // Reloading the tab is what a user would do by hand, and it re-runs the
      // script cleanly rather than injecting a second copy alongside the dead
      // one.
      void refreshLighterTabs();
    });

    // Reads the shim's export so the module cannot be tree-shaken. Without a
    // referenced binding the bundler drops it, and the worker goes back to
    // dying on URL.createObjectURL before any of this runs.
    console.info('[truly] worker up; sw globals installed:', swGlobalsInstalled);

    // A prompt may have been open when this worker last died. Re-open it
    // from the stored record rather than losing the dapp's request.
    void resumePendingApprovals().catch((error: unknown) => {
      console.warn('[truly] could not restore approval prompts', error);
    });

    // Chrome may drop alarms across a browser restart. A deposit in flight has
    // real money sitting at an intent address, so re-arm rather than relying on
    // the user reopening the popup.
    chrome.runtime.onStartup.addListener(() => {
      void resumeDepositWatch();
      void armSessionTick();
    });
    void armSessionTick();

    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === AUTO_LOCK_ALARM) void autoLock();
      if (alarm.name === DEPOSIT_ALARM) void pollDeposit();
      if (alarm.name === SESSION_ALARM) void tickSession();
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
      void loadShieldedBalance().catch((error: unknown) => console.warn('[truly] shielded balance', error));
      return result;
    }

    case 'unlock':
      await unlock(message.password);
      await touchAutoLock();
      void loadShieldedBalance().catch((error: unknown) => console.warn('[truly] shielded balance', error));
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
      await broadcastProviderEvent('accountsChanged', [[trade.ownerAddress]]);
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
      await chrome.alarms.clear(SESSION_ALARM);
      await announceTradeEnded();
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
      await chrome.alarms.clear(SESSION_ALARM);
      await announceTradeEnded();
      return null;

    case 'provider': {
      // Trust the sender's own URL over anything the page claims: a page cannot
      // forge the origin of the content script that relays for it.
      const origin = sender.origin ?? message.origin;
      console.info('[truly] rpc', origin, message.method);
      const result = await handleProviderRequest(
        origin,
        message.method,
        message.params,
        message.requestId,
        sender.tab?.id,
      );
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

    case 'connectToSite': {
      // Consent FIRST, then the trade. Starting the trade is what releases
      // the held eth_requestAccounts, and it must find the consent already
      // recorded or it falls back to opening a second approval window.
      await grantConnectConsent(message.origin);
      const trade = (await getActiveTrade()) ?? (await startTrade());
      await touchAutoLock();
      return { ownerAddress: trade.ownerAddress };
    }

    case 'fundingSpeed': {
      // Read live rather than assumed: capacity can appear, and when it does
      // the funding wait collapses from ~15-20 minutes to seconds.
      const limit = await getFastBridgeLimit().catch(() => '0');
      return { fastBridgeLimit: limit, fast: Number(limit) > 0 };
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

    case 'reshield': {
      // Same shape as unshield: the popup may close, and the trade record is
      // what survives. A second click checks the receipt instead of depositing
      // again — see reshieldActiveTrade.
      const result = await reshieldActiveTrade();
      await touchAutoLock();
      return {
        userOpHash: result.userOpHash,
        deposited: result.deposited.toString(),
        depositIndex: result.depositIndex,
      };
    }

    case 'shieldedBalance':
      return loadShieldedBalance(message.refresh === true);

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

    case 'markets':
      return fetchMarkets();

    case 'quoteTrade': {
      const quote = await quoteTrade(toTradeRequest(message.trade));
      await touchAutoLock();
      return quote;
    }

    case 'openTrade': {
      const session = await openTradeSession(toTradeRequest(message.trade));
      await touchAutoLock();
      await broadcastProviderEvent('accountsChanged', [[(await getActiveTrade())!.ownerAddress]]);
      await armSessionTick();
      // Funding moves money and takes minutes; the record, not this reply,
      // is what the popup follows.
      void runFunding().catch((error: unknown) => console.error('[truly] funding failed', error));
      return session;
    }

    case 'tradeSession':
      return getSessionView();

    case 'advanceTrade':
      await advanceSession();
      return getSessionView();

    case 'retryFunding':
      await touchAutoLock();
      void retryFunding().catch((error: unknown) => console.error('[truly] funding retry failed', error));
      return null;

    case 'retryOrder':
      await retryOrder();
      await touchAutoLock();
      await armSessionTick();
      return getSessionView();

    case 'closePosition':
      await closePosition();
      await touchAutoLock();
      await armSessionTick();
      return getSessionView();

    case 'retryLighterExit':
      await retryLighterExit();
      await touchAutoLock();
      await armSessionTick();
      return getSessionView();

    case 'shieldFunds':
      await shieldFundedAccount();
      await touchAutoLock();
      await armSessionTick();
      return getSessionView();

    case 'lighterSignerSelfTest': {
      // A throwaway key and a fictitious account: nothing here is ever sent.
      const started = Date.now();
      const key = await generateApiKey();
      const tx = await signMarketOrder(
        { privateKey: key.privateKey, apiKeyIndex: 4, accountIndex: 1 },
        { marketIndex: 0, clientOrderIndex: 1, baseAmount: 1, price: 1, isAsk: false, reduceOnly: false },
        0,
      );
      return { txType: tx.txType, txHash: tx.txHash, loadMs: Date.now() - started };
    }

    default: {
      const unreachable: never = message;
      throw new Error(`unknown request: ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * Reload any open Lighter tab so its content script is live again.
 *
 * Only on install/update, which in development means every extension reload.
 * A trading page survives a reload; a silently missing wallet does not
 * survive a demo.
 */
async function refreshLighterTabs(): Promise<void> {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://*.lighter.xyz/*' });
    for (const tab of tabs) {
      if (tab.id === undefined) continue;
      await chrome.tabs.reload(tab.id);
      console.info('[truly] reloaded Lighter tab so the provider is announced again');
    }
  } catch (error) {
    // Never fatal: the user can reload the page themselves, and the worker
    // must still start.
    console.warn('[truly] could not refresh Lighter tabs', error);
  }
}

async function autoLock(): Promise<void> {
  await lock();
  await forgetShieldedBalance();
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
  // A market-trade session polls the deposit itself, on its own alarm.
  if (trade.session) return;

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

function toTradeRequest(wire: TradeRequestWire): TradeRequest {
  if (!/^\d+$/.test(wire.marginUnits ?? '')) throw new Error('Margin must be a whole number of USDC units.');
  const fundingSource = wire.depositOnly || wire.fundingSource === 'railgun' ? 'railgun' : 'privacy-pools';
  if (wire.depositOnly) {
    return { marketId: 0, direction: 'long', marginUnits: BigInt(wire.marginUnits), leverage: 1, fundingSource: 'railgun', depositOnly: true };
  }
  return {
    marketId: Number(wire.marketId),
    direction: wire.direction ?? 'long',
    marginUnits: BigInt(wire.marginUnits),
    leverage: Number(wire.leverage),
    fundingSource,
  };
}

/** Tick while a session waits on the outside world; stop once it waits on the user. */
async function armSessionTick(): Promise<void> {
  const session = await getSession();
  if (session && ACTIVE_SESSION_STATES.includes(session.state)) {
    await chrome.alarms.create(SESSION_ALARM, { periodInMinutes: 1 });
  } else {
    await chrome.alarms.clear(SESSION_ALARM);
  }
}

async function tickSession(): Promise<void> {
  try {
    await advanceSession();
  } catch (error) {
    console.warn('[truly] session tick failed', error);
  } finally {
    await armSessionTick();
  }
}

/** Lighter should drop the owner the moment the trade is no longer active. */
async function announceTradeEnded(): Promise<void> {
  await broadcastProviderEvent('accountsChanged', [[]]);
  await broadcastProviderEvent('disconnect', [
    { code: 4900, message: 'Truly trade ended.' },
  ]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRpcError(error: unknown): error is Error & { code: number } {
  return error instanceof Error && typeof (error as { code?: unknown }).code === 'number';
}
