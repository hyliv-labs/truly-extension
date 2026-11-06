/**
 * E5 background half: the only place a provider request is ever answered.
 *
 * Two invariants, both load-bearing for privacy:
 *   1. Nothing about the owner is answered unless a trade is active — otherwise
 *      a page could fingerprint the user by asking for accounts at any time.
 *   2. Only the active trade's owner address is ever exposed. Never the index,
 *      never a past owner, never a list.
 *
 * Approval state lives in chrome.storage.session, not only in the promise
 * below. Chrome may kill this worker while the prompt is open. The content
 * script retries the same request id, and this module continues from the
 * stored record: it does not open a second prompt, and it does not sign a
 * second transaction.
 */

import { keccak256, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { getActiveTrade, type ActiveTrade } from './trade';
import { releaseLighterTab, spareLighterTab } from './site-cleanup';
import { isUnlocked, ownerAt } from './vault';
import {
  decideApproval,
  dropApproval,
  getInFlight,
  listInFlight,
  pruneInFlight,
  putApproval,
  putInFlight,
  type InFlightRequest,
} from './approvals';
import { publicClient } from './chain';
import {
  parsePersonalSign,
  parseTransactionRequest,
  parseTypedDataRequest,
  ProviderRequestError,
} from './provider-requests';

/** Arbitrum One. */
export const CHAIN_ID_HEX = '0xa4b1';

const APPROVAL_WINDOW = { width: 400, height: 560 } as const;

const LIGHTER_TAB = 'https://*.lighter.xyz/*';

/**
 * Worker-local waiters. The durable half is the in-flight record. If this
 * map is empty on wake, the record still says whether the user answered.
 */
const pending = new Map<
  string,
  { resolve: () => void; reject: (error: Error) => void }
>();

/** Stops two wakes from opening two windows for the same prompt. */
const windowOpens = new Map<string, Promise<void>>();

export async function handleProviderRequest(
  origin: string,
  method: string,
  params: unknown[] = [],
  requestId = '',
  tabId?: number,
): Promise<unknown> {
  const id = requestId || crypto.randomUUID();
  await pruneInFlight();

  const existing = await getInFlight(id);
  if (existing) return continueInFlight(existing);

  const trade = await getActiveTrade();
  if (!trade) {
    // Throwing here is what Lighter renders as "Connection cancelled", and
    // the request is already dead by the time the user starts a trade.
    // Hold it open instead. Nothing about the owner is returned until a
    // trade exists and the user approves.
    if (method === 'eth_requestAccounts' || method === 'wallet_requestPermissions') {
      return connectWhenTradeStarts({ origin, method, params, requestId: id, tabId });
    }
    return refuseWithoutTrade(method);
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
      // No prompt: this is the "already connected?" probe. The trade gate
      // above is what keeps it from leaking anything.
      return [trade.ownerAddress];

    case 'wallet_getPermissions':
      return accountsPermission(trade.ownerAddress);

    case 'eth_requestAccounts':
    case 'wallet_requestPermissions':
    case 'personal_sign':
    case 'eth_signTypedData_v3':
    case 'eth_signTypedData_v4':
    case 'eth_signTypedData':
    case 'eth_sendTransaction':
      return approveAndPerform({
        requestId: id,
        origin,
        method,
        params,
        ownerAddress: trade.ownerAddress,
        ownerIndex: trade.ownerIndex,
      });

    default:
      throw rpcError(4200, `Truly does not support ${method}.`);
  }
}

/**
 * Tell every open Lighter tab that the exposed account changed.
 *
 * Only Lighter tabs receive it. The content script is not injected anywhere
 * else, and a broadcast to every tab would hand the owner address to sites
 * that never asked.
 */
export async function broadcastProviderEvent(
  event: 'accountsChanged' | 'disconnect',
  args: unknown[],
): Promise<void> {
  let tabs: chrome.tabs.Tab[] = [];
  try {
    tabs = await chrome.tabs.query({ url: LIGHTER_TAB });
  } catch {
    return;
  }

  await Promise.all(
    tabs.map(async (tab) => {
      if (tab.id === undefined) return;
      try {
        await chrome.tabs.sendMessage(tab.id, { kind: 'providerEvent', event, args });
      } catch {
        // The tab has no content script. Nothing to update.
      }
    }),
  );
}

/**
 * Re-open prompts whose worker died before the user answered. Called on
 * every worker start. A window that is still open is left alone.
 */
export async function resumePendingApprovals(): Promise<void> {
  await pruneInFlight();
  for (const entry of await listInFlight()) {
    if (entry.status !== 'awaiting') continue;
    await ensureWindow(entry);
  }
}

/**
 * Account probes with no trade answer empty. A throw on eth_accounts during
 * a page-load check is what a dapp renders as a broken wallet. Connect
 * methods do not come through here: they wait in connectWhenTradeStarts.
 */
async function refuseWithoutTrade(method: string): Promise<unknown> {
  if (method === 'eth_chainId') return CHAIN_ID_HEX;
  if (method === 'eth_accounts' || method === 'wallet_getPermissions') return [];

  const unlocked = await isUnlocked();
  throw rpcError(
    4100,
    unlocked
      ? 'Truly has no active trade. Open Truly and start one, then try again.'
      : 'Truly is locked. Unlock it and start a trade, then try again.',
  );
}

type TradeWaiter = {
  resolve: (trade: ActiveTrade) => void;
  reject: (error: Error) => void;
};

const tradeWaiters: TradeWaiter[] = [];
let watchingTrades = false;
let connectWindowId: number | undefined;

/**
 * Lighter calls this before any trade exists. Keep the promise pending,
 * show Truly, and finish the normal approval once the user starts a trade.
 * The tab is spared so startTrade's session wipe does not close the page
 * that is waiting on this response.
 */
const CONNECT_CONSENT = 'truly:connectConsent';
/** Consent is for the request in front of the user now, not a standing grant. */
const CONNECT_CONSENT_TTL_MS = 2 * 60_000;

/**
 * Record that the user pressed Connect for `origin` in the Truly window.
 *
 * Session storage: it never survives the browser, and it is consumed by the
 * first connect from that origin, so it cannot quietly authorise a later one.
 */
export async function grantConnectConsent(origin: string): Promise<void> {
  await chrome.storage.session.set({
    [CONNECT_CONSENT]: { origin: normaliseOrigin(origin), at: Date.now() },
  });
}

export async function consumeConnectConsent(origin: string): Promise<boolean> {
  const stored = await chrome.storage.session.get(CONNECT_CONSENT);
  const grant = stored[CONNECT_CONSENT] as { origin: string; at: number } | undefined;
  await chrome.storage.session.remove(CONNECT_CONSENT);
  return (
    !!grant &&
    grant.origin === normaliseOrigin(origin) &&
    Date.now() - grant.at < CONNECT_CONSENT_TTL_MS
  );
}

function normaliseOrigin(origin: string): string {
  try {
    return new URL(origin).origin;
  } catch {
    return origin;
  }
}

async function connectWhenTradeStarts(input: {
  origin: string;
  method: string;
  params: unknown[];
  requestId: string;
  tabId?: number;
}): Promise<unknown> {
  if (input.tabId !== undefined) spareLighterTab(input.tabId);
  try {
    await openTrulyWindow(input.origin);
    const trade = await waitForActiveTrade();

    // The user pressed "Connect" in the Truly window for THIS site. That
    // click is the consent, so asking again in a second approval window would
    // be a prompt for a prompt. Only for connecting: it reveals the owner
    // address and nothing else, the same result execute() returns after an
    // approval. Signing requests always go through the approval window.
    if (await consumeConnectConsent(input.origin)) {
      return input.method === 'wallet_requestPermissions'
        ? accountsPermission(trade.ownerAddress)
        : [trade.ownerAddress];
    }

    return approveAndPerform({
      requestId: input.requestId,
      origin: input.origin,
      method: input.method,
      params: input.params,
      ownerAddress: trade.ownerAddress,
      ownerIndex: trade.ownerIndex,
    });
  } finally {
    if (input.tabId !== undefined) releaseLighterTab(input.tabId);
  }
}

function waitForActiveTrade(): Promise<ActiveTrade> {
  return new Promise((resolve, reject) => {
    const waiter: TradeWaiter = { resolve, reject };
    tradeWaiters.push(waiter);
    watchTrades();
    void getActiveTrade().then((trade) => {
      if (!trade || !tradeWaiters.includes(waiter)) return;
      settleWaiter(waiter, trade);
    });
  });
}

function watchTrades(): void {
  if (watchingTrades) return;
  watchingTrades = true;
  chrome.storage.onChanged.addListener(onTradeStorage);
}

function unwatchTrades(): void {
  if (!watchingTrades) return;
  watchingTrades = false;
  chrome.storage.onChanged.removeListener(onTradeStorage);
}

function onTradeStorage(_changes: { [key: string]: chrome.storage.StorageChange }, area: string): void {
  if (area !== 'local' || tradeWaiters.length === 0) return;
  void getActiveTrade().then((trade) => {
    if (!trade) return;
    for (const waiter of [...tradeWaiters]) settleWaiter(waiter, trade);
  });
}

function settleWaiter(waiter: TradeWaiter, trade: ActiveTrade): void {
  const index = tradeWaiters.indexOf(waiter);
  if (index === -1) return;
  tradeWaiters.splice(index, 1);
  if (tradeWaiters.length === 0) unwatchTrades();
  waiter.resolve(trade);
}

function failTradeWaiters(error: Error): void {
  const waiters = tradeWaiters.splice(0);
  unwatchTrades();
  for (const waiter of waiters) waiter.reject(error);
}

/** Wagmi reads caveats[0].value as the connected accounts. Without it the permissions call throws and Lighter asks twice. */
function accountsPermission(ownerAddress: string): unknown[] {
  return [
    {
      parentCapability: 'eth_accounts',
      caveats: [{ type: 'restrictReturnedAccounts', value: [ownerAddress] }],
    },
  ];
}

async function approveAndPerform(input: {
  requestId: string;
  origin: string;
  method: string;
  params: unknown[];
  ownerAddress: string;
  ownerIndex: number;
}): Promise<unknown> {
  if (input.method === 'eth_sendTransaction') {
    await assertOwnerHasEth(input.ownerAddress);
  }

  const message = approvalMessage(input.method, input.params, input.ownerAddress);
  const record: InFlightRequest = {
    requestId: input.requestId,
    approvalId: crypto.randomUUID(),
    origin: input.origin,
    method: input.method,
    params: input.params,
    ownerAddress: input.ownerAddress,
    ownerIndex: input.ownerIndex,
    status: 'awaiting',
    message,
    createdAt: Date.now(),
  };

  await putInFlight(record);
  await putApproval({
    id: record.approvalId,
    origin: record.origin,
    method: record.method,
    ownerAddress: record.ownerAddress,
    message,
    createdAt: record.createdAt,
  });

  await waitForDecision(record);
  const decided = await getInFlight(record.requestId);
  if (!decided || decided.status === 'rejected') {
    throw rpcError(
      decided?.error?.code ?? 4001,
      decided?.error?.message ?? 'User rejected the request.',
    );
  }
  return perform(decided);
}

async function continueInFlight(record: InFlightRequest): Promise<unknown> {
  if (record.status === 'completed') return record.result;
  if (record.status === 'rejected') {
    throw rpcError(record.error?.code ?? 4001, record.error?.message ?? 'User rejected the request.');
  }

  if (record.status === 'awaiting') {
    await waitForDecision(record);
    const decided = await getInFlight(record.requestId);
    if (!decided || decided.status === 'rejected') {
      throw rpcError(
        decided?.error?.code ?? 4001,
        decided?.error?.message ?? 'User rejected the request.',
      );
    }
    return perform(decided);
  }

  return perform(record);
}

/**
 * The only place a signature or a transaction is produced.
 *
 * The owner is derived at the index stored on the request, never whatever
 * index is current now. Retiring the trade while the prompt was open must
 * not redirect the signature onto the next address.
 */
async function perform(record: InFlightRequest): Promise<unknown> {
  const latest = (await getInFlight(record.requestId)) ?? record;
  if (latest.status === 'completed') return latest.result;

  const trade = await getActiveTrade();
  if (!trade || trade.ownerIndex !== latest.ownerIndex) {
    throw rpcError(4100, 'The trade ended before this request was signed.');
  }

  const owner = await ownerAt(latest.ownerIndex);
  if (owner.address.toLowerCase() !== latest.ownerAddress.toLowerCase()) {
    throw rpcError(4100, 'Truly owner mismatch; refusing to sign.');
  }

  const result = await execute(latest, owner.privateKey);
  const after = (await getInFlight(record.requestId)) ?? latest;
  await putInFlight({ ...after, status: 'completed', result });
  await dropApproval(latest.approvalId);
  return result;
}

async function execute(record: InFlightRequest, privateKey: Hex): Promise<unknown> {
  const account = privateKeyToAccount(privateKey);

  switch (record.method) {
    case 'eth_requestAccounts':
      return [record.ownerAddress];

    case 'wallet_requestPermissions':
      return accountsPermission(record.ownerAddress);

    case 'personal_sign': {
      const { raw } = parsePersonalSign(record.params, record.ownerAddress);
      return account.signMessage({ message: { raw } });
    }

    case 'eth_signTypedData':
    case 'eth_signTypedData_v3':
    case 'eth_signTypedData_v4': {
      const typed = parseTypedDataRequest(record.method, record.params, record.ownerAddress);
      return account.signTypedData({
        domain: typed.domain,
        types: typed.types,
        primaryType: typed.primaryType,
        message: typed.message,
      });
    }

    case 'eth_sendTransaction':
      return sendOwnerTransaction(record, privateKey);

    default:
      throw rpcError(4200, `Truly does not support ${record.method}.`);
  }
}

/**
 * Sign, remember the exact bytes, then broadcast.
 *
 * The hash of those bytes is the transaction hash. If the worker dies after
 * the broadcast, the retry sends the same bytes and returns the same hash.
 * A genuine rejection deletes the bytes so the next attempt can use a new nonce.
 */
async function sendOwnerTransaction(record: InFlightRequest, privateKey: Hex): Promise<Hex> {
  const latest = (await getInFlight(record.requestId)) ?? record;
  if (latest.rawTx) return broadcastRaw(latest.rawTx as Hex);

  const account = privateKeyToAccount(privateKey);
  const tx = parseTransactionRequest(record.params, record.ownerAddress);
  const prepared = await publicClient.prepareTransactionRequest({
    account,
    to: tx.to,
    data: tx.data,
    value: tx.value,
  });
  // prepareTransactionRequest returns the chain object alongside the fields
  // signTransaction wants. The runtime value is a transaction; the extra
  // fields are what the type refuses.
  const serialized = await account.signTransaction(
    prepared as Parameters<typeof account.signTransaction>[0],
  );
  await putInFlight({ ...latest, rawTx: serialized });

  try {
    return await broadcastRaw(serialized);
  } catch (error) {
    const stored = await getInFlight(record.requestId);
    if (stored) {
      const { rawTx: _omit, ...rest } = stored;
      await putInFlight(rest);
    }
    throw error;
  }
}

async function broadcastRaw(serialized: Hex): Promise<Hex> {
  const hash = keccak256(serialized);
  try {
    await publicClient.sendRawTransaction({ serializedTransaction: serialized });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // The node already has this exact transaction. Returning its hash is the
    // retry, not a second payment.
    if (!/already known|nonce too low|already imported|known transaction/i.test(message)) {
      throw error;
    }
  }
  return hash;
}

/**
 * An owner is funded with USDC and never with ETH. Sending it ETH from
 * anywhere the user controls would link this trade to that source, which is
 * the linkage the extension exists to avoid. Refuse before the prompt so the
 * user is not asked to approve a transaction that cannot be paid for.
 */
async function assertOwnerHasEth(ownerAddress: string): Promise<void> {
  const balance = await publicClient.getBalance({ address: ownerAddress as Hex });
  if (balance === 0n) {
    throw new ProviderRequestError(
      -32000,
      'This owner address holds no ETH, so it cannot send a transaction. Truly will not fund it with ETH, because that payment would link the address. USDC goes back to the pool through Re-shield, which pays gas in USDC.',
    );
  }
}

function approvalMessage(method: string, params: unknown[], ownerAddress: string): string | undefined {
  if (method === 'personal_sign') {
    return decodeMessage(parsePersonalSign(params, ownerAddress).raw);
  }
  if (
    method === 'eth_signTypedData' ||
    method === 'eth_signTypedData_v3' ||
    method === 'eth_signTypedData_v4'
  ) {
    return parseTypedDataRequest(method, params, ownerAddress).summary;
  }
  if (method === 'eth_sendTransaction') {
    return parseTransactionRequest(params, ownerAddress).summary;
  }
  return undefined;
}

async function waitForDecision(record: InFlightRequest): Promise<void> {
  await ensureWindow(record);

  const current = await getInFlight(record.requestId);
  if (!current) throw rpcError(4001, 'This request expired.');
  if (current.status === 'approved' || current.status === 'completed') return;
  if (current.status === 'rejected') {
    throw rpcError(current.error?.code ?? 4001, current.error?.message ?? 'User rejected the request.');
  }

  return new Promise<void>((resolve, reject) => {
    pending.set(record.approvalId, { resolve, reject });

    // The decision may have landed between the read above and this set.
    void getInFlight(record.requestId).then((fresh) => {
      const entry = pending.get(record.approvalId);
      if (!entry || !fresh || fresh.status === 'awaiting') return;
      pending.delete(record.approvalId);
      if (fresh.status === 'rejected') {
        entry.reject(
          rpcError(fresh.error?.code ?? 4001, fresh.error?.message ?? 'User rejected the request.'),
        );
      } else {
        entry.resolve();
      }
    });
  });
}

async function ensureWindow(record: InFlightRequest): Promise<void> {
  const inflight = new Promise<void>((resolve, reject) => {
    const existing = windowOpens.get(record.approvalId);
    if (existing) {
      void existing.then(resolve, reject);
      return;
    }

    const job = openApprovalWindow(record);
    windowOpens.set(record.approvalId, job);
    void job.then(
      () => {
        windowOpens.delete(record.approvalId);
        resolve();
      },
      (error: unknown) => {
        windowOpens.delete(record.approvalId);
        reject(error);
      },
    );
  });

  await inflight;
}

async function openApprovalWindow(record: InFlightRequest): Promise<void> {
  const latest = (await getInFlight(record.requestId)) ?? record;
  if (latest.windowId !== undefined && (await windowExists(latest.windowId))) {
    watchClose(latest.windowId, latest.approvalId);
    return;
  }

  const created = await chrome.windows.create({
    url: chrome.runtime.getURL(`/approval.html?id=${record.approvalId}`),
    type: 'popup',
    ...APPROVAL_WINDOW,
  });

  if (created?.id === undefined) {
    await settle(record.approvalId, false, 'Truly could not open the approval window.');
    return;
  }

  await putInFlight({ ...latest, windowId: created.id });
  watchClose(created.id, record.approvalId);
}

function watchClose(windowId: number, approvalId: string): void {
  const onClosed = (closedId: number) => {
    if (closedId !== windowId) return;
    chrome.windows.onRemoved.removeListener(onClosed);
    void settle(approvalId, false, 'User rejected the request.');
  };
  chrome.windows.onRemoved.addListener(onClosed);
}

async function windowExists(windowId: number): Promise<boolean> {
  try {
    await chrome.windows.get(windowId);
    return true;
  } catch {
    return false;
  }
}

/**
 * Show Truly so the user can start the trade this request is waiting on.
 * One window per connect: a second permissions call focuses it instead of
 * stacking another. Closing it with no trade rejects the request.
 */
async function openTrulyWindow(origin?: string): Promise<void> {
  if (connectWindowId !== undefined && (await windowExists(connectWindowId))) {
    try {
      await chrome.windows.update(connectWindowId, { focused: true });
    } catch {
      // Focus is best effort. The window is already there.
    }
    return;
  }
  connectWindowId = undefined;

  const url = new URL(chrome.runtime.getURL('/popup.html'));
  url.searchParams.set('connect', origin ?? '1');
  const created = await chrome.windows.create({
    url: url.toString(),
    type: 'popup',
    ...APPROVAL_WINDOW,
  });
  if (created?.id === undefined) {
    throw rpcError(4001, 'Truly could not open a window to start the trade.');
  }

  connectWindowId = created.id;
  const windowId = created.id;
  const onClosed = (closedId: number) => {
    if (closedId !== windowId) return;
    chrome.windows.onRemoved.removeListener(onClosed);
    if (connectWindowId === windowId) connectWindowId = undefined;
    // A trade may have started in the same moment the window closed.
    // Rejecting then would cancel a connect that is about to succeed.
    void getActiveTrade().then((trade) => {
      if (trade) return;
      failTradeWaiters(rpcError(4001, 'User rejected the request.'));
    });
  };
  chrome.windows.onRemoved.addListener(onClosed);
}

export async function settle(
  id: string,
  approved: boolean,
  reason = 'User rejected the request.',
): Promise<void> {
  const decided = await decideApproval(id, approved, reason);
  const entry = pending.get(id);
  if (!entry) return;
  pending.delete(id);

  if (!decided || decided.status === 'rejected') entry.reject(rpcError(4001, reason));
  else entry.resolve();
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
