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

import { encodeFunctionData, keccak256, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { findTradeByOwner, tradeForOrigin, updateOwnedTrade, type ActiveTrade, type VenueId } from './trade';
import { isUnlocked, ownerAt, requireUnlockedMnemonic } from './vault';
import { deriveNearOwner } from './near-keys';
import { nearOutcomeFailure, nearSignAndSend } from './near-chain';
import { describeNearTransactions, implicitPublicKey, isNearWalletMethod, parseNearTransactions, parseNep413, signNep413, type NearWalletMethod } from './near-wallet';
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
import { isStructNameRefusal, looseTypedDataAllowed, signTypedDataLoose } from './typed-data';
import { APP_VENUE_IDS, APP_VENUES, isAppVenue } from './app-venues';
import { dydxAddressFromSignature, isCanonicalDydxOnboarding, isDydxOnboarding } from './dydx';
import {
  parsePersonalSign,
  parseTransactionRequest,
  parseTypedDataRequest,
  ProviderRequestError,
} from './provider-requests';

/** Arbitrum One. */
export const CHAIN_ID_HEX = '0xa4b1';

const APPROVAL_WINDOW = { width: 400, height: 560 } as const;

const SITE_TABS = [
  'https://*.lighter.xyz/*',
  'https://*.uniswap.org/*',
  'https://*.compound.xyz/*',
  'https://*.compound.finance/*',
  'https://*.hyperliquid.xyz/*',
  ...APP_VENUE_IDS.flatMap((id) => APP_VENUES[id].tabPatterns),
];

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
  // A request id belongs to the origin that made it. Another page presenting
  // the same id gets nothing from the stored result.
  if (existing && normaliseOrigin(existing.origin) !== normaliseOrigin(origin)) {
    throw rpcError(4100, 'That request belongs to another site.');
  }
  if (existing) return continueInFlight(existing);

  const trade = await tradeForOrigin(origin);
  if (isNearWalletMethod(method)) return handleNearRequest({ origin, method, params, requestId: id }, trade);
  if (trade?.venue && isAppVenue(trade.venue) && APP_VENUES[trade.venue].chain === 'near') {
    // A NEAR app: the Ethereum provider stays silent there, and nothing is signed for Arbitrum.
    throw rpcError(4200, `On ${APP_VENUES[trade.venue].name}, Ghosty is a NEAR wallet.`);
  }
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
      return siteChain(trade);

    case 'wallet_switchEthereumChain': {
      const target = (params[0] as { chainId?: string } | undefined)?.chainId?.toLowerCase();
      if (!target || target === CHAIN_ID_HEX) {
        await setSiteChain(trade, CHAIN_ID_HEX);
        return null;
      }
      if (trade.venue && SIGN_ONLY_CHAINS[trade.venue as VenueId]?.includes(target)) {
        await setSiteChain(trade, target);
        return null;
      }
      throw rpcError(4902, 'Truly only operates on Arbitrum One.');
    }

    case 'eth_accounts':
      // No prompt: this is the "already connected?" probe. The trade gate
      // above is what keeps it from leaking anything.
      return [trade.ownerAddress];

    case 'wallet_getPermissions':
      return accountsPermission(trade.ownerAddress);

    case 'eth_sendTransaction':
      // On a sign-only chain the site believes it is on another network. A
      // transaction it sends would be signed for Arbitrum, so refuse it.
      if ((await siteChain(trade)) !== CHAIN_ID_HEX) {
        throw rpcError(4100, 'Ghosty only signs messages on that network. Switch the site back to Arbitrum to send a transaction.');
      }
      return approveAndPerform({ requestId: id, origin, method, params, ownerAddress: trade.ownerAddress, ownerIndex: trade.ownerIndex });

    case 'eth_requestAccounts':
    case 'wallet_requestPermissions':
    case 'personal_sign':
    case 'eth_signTypedData_v3':
    case 'eth_signTypedData_v4':
    case 'eth_signTypedData':
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
 * Chains a site may switch to for signing only. dydx.trade switches to
 * Ethereum mainnet (chainId 1) before it asks for its onboarding signature
 * (v4-web useGenerateKeys: switchChainAsync({chainId: 1}), then sign), and
 * will not onboard a wallet that refuses. Ghosty reports that chain to the
 * site and signs messages there, but sends no transaction until the site
 * switches back to Arbitrum.
 */
const SIGN_ONLY_CHAINS: Partial<Record<VenueId, string[]>> = { dydx: ['0x1'] };
const SITE_CHAIN = 'truly:siteChain';

async function siteChain(trade: ActiveTrade): Promise<string> {
  if (!trade.venue || !SIGN_ONLY_CHAINS[trade.venue as VenueId]) return CHAIN_ID_HEX;
  const stored = (await chrome.storage.session.get(SITE_CHAIN))[SITE_CHAIN] as Record<string, string> | undefined;
  return stored?.[`${trade.venue}:${trade.ownerIndex}`] ?? CHAIN_ID_HEX;
}

async function setSiteChain(trade: ActiveTrade, chainId: string): Promise<void> {
  if (!trade.venue || !SIGN_ONLY_CHAINS[trade.venue as VenueId]) return;
  // Announce even when nothing changed: wagmi's switchChain waits for chainChanged.
  const stored = ((await chrome.storage.session.get(SITE_CHAIN))[SITE_CHAIN] as Record<string, string> | undefined) ?? {};
  await chrome.storage.session.set({ [SITE_CHAIN]: { ...stored, [`${trade.venue}:${trade.ownerIndex}`]: chainId } });
  if (isAppVenue(trade.venue)) await broadcastProviderEvent('chainChanged', [chainId], [...APP_VENUES[trade.venue].tabPatterns]);
}

/**
 * Tell every open Lighter tab that the exposed account changed.
 *
 * Only Lighter tabs receive it. The content script is not injected anywhere
 * else, and a broadcast to every tab would hand the owner address to sites
 * that never asked.
 */
export async function broadcastProviderEvent(
  event: 'accountsChanged' | 'disconnect' | 'chainChanged',
  args: unknown[],
  urls: string[] = SITE_TABS,
): Promise<void> {
  let tabs: chrome.tabs.Tab[] = [];
  try {
    tabs = await chrome.tabs.query({ url: urls });
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
  origin: string;
  resolve: (trade: ActiveTrade) => void;
  reject: (error: Error) => void;
};

const tradeWaiters: TradeWaiter[] = [];
let watchingTrades = false;
let connectWindowId: number | undefined;

/**
 * Lighter calls this before any trade exists. Keep the promise pending,
 * show Truly, and finish the normal approval once the user starts a trade.
 * The site tab stays open; the user closes it.
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
  // The click that follows has to ask the chain whether the next address
  // was already used. That read goes through anon-rpc, and the first one
  // builds a circuit. Start it now, while the window is on screen, so the
  // click is not the thing that waits for the circuit.
  void publicClient.getChainId().catch(() => undefined);
  await openTrulyWindow(input.origin);
  const trade = await waitForOriginTrade(input.origin);

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
}

function waitForOriginTrade(origin: string): Promise<ActiveTrade> {
  return new Promise((resolve, reject) => {
    const waiter: TradeWaiter = { origin, resolve, reject };
    tradeWaiters.push(waiter);
    watchTrades();
    void tradeForOrigin(origin).then((trade) => {
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
  for (const waiter of [...tradeWaiters]) {
    void tradeForOrigin(waiter.origin).then((trade) => {
      if (trade) settleWaiter(waiter, trade);
    });
  }
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
  /** NEAR requests: the prompt text and the account shown, worked out by the caller. */
  message?: string;
  displayAccount?: string;
}): Promise<unknown> {
  if (input.method === 'eth_sendTransaction') {
    await assertOwnerHasEth(input.ownerAddress);
  }

  const message = input.message ?? approvalMessage(input.method, input.params, input.ownerAddress);
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
    ownerAddress: input.displayAccount ?? record.ownerAddress,
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

  const trade = await findTradeByOwner(latest.ownerIndex);
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

/**
 * dydx.trade derives its account from this signature. Keep the public
 * dydx1/noble1 addresses on the owner's trade, so Bring back can check dYdX.
 * The signature itself goes only to the page, as with any signature.
 */
async function rememberDydxAccount(ownerIndex: number, signature: Hex, canonical: boolean): Promise<void> {
  const trade = await findTradeByOwner(ownerIndex);
  if (!trade || trade.venue !== 'dydx') return;
  const derived = dydxAddressFromSignature(signature);
  // The first canonical account is kept: a later look-alike request cannot
  // replace it with an empty account and let Bring back retire a funded one.
  if (trade.appAccount?.address && trade.appAccount.address !== derived.dydx) {
    await updateOwnedTrade(ownerIndex, { appAccount: { ...trade.appAccount, unknownAccounts: [...new Set([...(trade.appAccount.unknownAccounts ?? []), derived.dydx])] } }).catch(() => undefined);
    return;
  }
  if (!canonical) {
    // A non-standard onboarding payload: dYdX may hold funds under an account
    // Ghosty cannot check the usual way. Record it so Bring back refuses.
    await updateOwnedTrade(ownerIndex, {
      appAccount: { address: trade.appAccount?.address ?? '', noble: trade.appAccount?.noble, unknownAccounts: [...new Set([...(trade.appAccount?.unknownAccounts ?? []), derived.dydx])] },
    }).catch(() => undefined);
    return;
  }
  await updateOwnedTrade(ownerIndex, { appAccount: { ...trade.appAccount, address: derived.dydx, noble: derived.noble } }).catch(() => undefined);
}

async function execute(record: InFlightRequest, privateKey: Hex): Promise<unknown> {
  if (isNearWalletMethod(record.method)) return executeNear(record);
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
      if (isDydxOnboarding(typed)) {
        const signature = await account.signTypedData({ domain: typed.domain, types: typed.types, primaryType: typed.primaryType, message: typed.message });
        await rememberDydxAccount(record.ownerIndex, signature, isCanonicalDydxOnboarding(typed));
        return signature;
      }
      try {
        return await account.signTypedData({
          domain: typed.domain,
          types: typed.types,
          primaryType: typed.primaryType,
          message: typed.message,
        });
      } catch (error) {
        // Hyperliquid's "HyperliquidTransaction:ApproveAgent" (Enable trading)
        // and its other user-signed actions use a name viem refuses. Same
        // digest, without that one check; anything else viem refuses stays refused.
        // Only Hyperliquid's own names, only for the Hyperliquid address, and
        // still through viem's field checks (looseTypedDataAllowed renames and validates).
        const trade = await findTradeByOwner(record.ownerIndex);
        if (!isStructNameRefusal(error) || trade?.venue !== 'hyperliquid' || !looseTypedDataAllowed(typed)) throw error;
        return signTypedDataLoose(privateKey, typed);
      }
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
  if (latest.rawTx) {
    try {
      return await broadcastRaw(latest.rawTx as Hex);
    } catch (error) {
      // A stored transaction keeps the gas limit it was signed with. One that
      // Arbitrum already rejected has to be signed again, or every retry sends
      // the same failing bytes.
      await clearRawTx(record.requestId);
      if (!intrinsicGasTooLow(error)) throw error;
    }
  }

  const account = privateKeyToAccount(privateKey);
  const tx = parseTransactionRequest(record.params, record.ownerAddress);
  // Do not call prepareTransactionRequest. It estimates gas, and that
  // eth_estimateGas is the call returning "intrinsic gas too low" — the
  // padding below it never ran. Nonce and base fee do not need an estimate.
  const [nonce, block] = await Promise.all([
    publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' }),
    publicClient.getBlock(),
  ]);
  const base = block.baseFeePerGas ?? 0n;
  if (base === 0n) {
    throw new Error('Arbitrum did not return a base fee, so the transaction was not sent.');
  }
  const gas = await arbitrumGasLimit(tx);
  console.info('[truly] arbitrum gas limit', {
    site: tx.gas?.toString() ?? 'none',
    chosen: gas.toString(),
    maxFeePerGas: (base * 2n).toString(),
  });
  const serialized = await account.signTransaction({
    chainId: 42161,
    type: 'eip1559',
    nonce,
    to: tx.to,
    data: tx.data ?? '0x',
    value: tx.value,
    gas,
    maxFeePerGas: base * 2n,
    maxPriorityFeePerGas: 0n,
  });
  const current = (await getInFlight(record.requestId)) ?? latest;
  await putInFlight({ ...current, rawTx: serialized });

  try {
    return await broadcastRaw(serialized);
  } catch (error) {
    await clearRawTx(record.requestId);
    if (intrinsicGasTooLow(error)) {
      throw new Error(
        `Arbitrum rejected gas limit ${gas}. ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    throw error;
  }
}

async function clearRawTx(requestId: string): Promise<void> {
  const stored = await getInFlight(requestId);
  if (!stored?.rawTx) return;
  const { rawTx: _omit, ...rest } = stored;
  await putInFlight(rest);
}

function intrinsicGasTooLow(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /intrinsic gas too low/i.test(message);
}

/** Arbitrum's precompile for the gas limit a transaction actually needs. */
const ARBITRUM_NODE_INTERFACE: Address = '0x00000000000000000000000000000000000000C8';

const nodeGasAbi = [
  {
    type: 'function',
    name: 'gasEstimateComponents',
    stateMutability: 'payable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'contractCreation', type: 'bool' },
      { name: 'data', type: 'bytes' },
    ],
    outputs: [
      { name: 'gasEstimate', type: 'uint64' },
      { name: 'gasEstimateForL1', type: 'uint64' },
      { name: 'baseFee', type: 'uint256' },
      { name: 'l1BaseFeeEstimate', type: 'uint256' },
    ],
  },
] as const;

async function arbitrumNodeGas(to: Address, data: Hex, value: bigint): Promise<bigint> {
  const raw = await publicClient.call({
    to: ARBITRUM_NODE_INTERFACE,
    data: encodeFunctionData({
      abi: nodeGasAbi,
      functionName: 'gasEstimateComponents',
      args: [to, false, data],
    }),
    value,
    // A missing gas on eth_call is what makes Arbitrum answer "intrinsic gas
    // too low". The limit is for the simulation only; it is not charged.
    gas: 5_000_000n,
  });
  if (!raw.data || raw.data.length < 66) return 0n;
  return BigInt(raw.data.slice(0, 66));
}

async function arbitrumGasLimit(tx: {
  to: Address;
  data?: Hex;
  value: bigint;
  gas?: bigint;
}): Promise<bigint> {
  const fromNode = await arbitrumNodeGas(tx.to, tx.data ?? '0x', tx.value).catch(() => 0n);
  // 1.5× the precompile result, the site's own limit, and a calldata floor.
  // The floor does not depend on eth_estimateGas: an approve measured on
  // Arbitrum needs about 56k, and a 21k estimate doubled is still rejected.
  const chosen = highest(fromNode + fromNode / 2n, arbitrumGasFloor(tx.data), tx.gas ?? 0n);
  // Cap so the reserved fee stays inside the 0.0001 ETH a fresh address holds
  // at the current ~0.02 gwei base fee, with room for the 2× fee above.
  const cap = 1_500_000n;
  return chosen > cap ? cap : chosen;
}

/**
 * Floor used when the precompile cannot be read. 800 gas per calldata byte
 * is about triple the L1 posting cost measured for an approve.
 */
function arbitrumGasFloor(data: Hex | undefined): bigint {
  const bytes = BigInt(Math.max(0, ((data?.length ?? 2) - 2) / 2));
  return 200_000n + bytes * 800n;
}

function highest(...values: bigint[]): bigint {
  return values.reduce((max, value) => (value > max ? value : max));
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

// --- NEAR wallet (NEAR Connect injected wallet) ------------------------------------

async function handleNearRequest(
  input: { origin: string; method: NearWalletMethod; params: unknown[]; requestId: string },
  found: ActiveTrade | null,
): Promise<unknown> {
  if (input.method === 'near_signOut') return null;
  let trade = found;
  if (!trade) {
    if (input.method === 'near_getAccounts') return [];
    if (input.method !== 'near_signIn') return refuseWithoutTrade(input.method);
    // As with an Ethereum connect: show Ghosty and wait for the user to start this app.
    await openTrulyWindow(input.origin);
    trade = await waitForOriginTrade(input.origin);
  }
  if (!trade.venue || !isAppVenue(trade.venue) || APP_VENUES[trade.venue].chain !== 'near') {
    throw rpcError(4100, 'Ghosty is a NEAR wallet only on NEAR apps.');
  }
  const accountId = trade.appAccount?.address;
  if (!accountId || !/^[0-9a-f]{64}$/.test(accountId)) {
    throw rpcError(4100, `Fund the ${APP_VENUES[trade.venue].name} account in Ghosty first (Go ghost), then connect.`);
  }
  const account = { accountId, publicKey: implicitPublicKey(accountId) };
  if (input.method === 'near_getAccounts') return [account];
  if (input.method === 'near_signIn' && (await consumeConnectConsent(input.origin))) return [account];

  let message: string;
  try {
    if (input.method === 'near_signIn') message = `Connect NEAR account ${accountId} to ${input.origin}. The site sees this account and can ask Ghosty to sign; every signature asks you first.`;
    else if (input.method === 'near_signMessage') {
      const parsed = parseNep413(input.params);
      message = `For ${parsed.recipient}:\n\n${parsed.message}`;
    } else message = describeNearTransactions(parseNearTransactions(input.method, input.params, accountId), accountId);
  } catch (error) {
    // Refused before any prompt: nothing Ghosty will sign was asked for.
    throw rpcError(4200, error instanceof Error ? error.message : String(error));
  }
  return approveAndPerform({
    requestId: input.requestId,
    origin: input.origin,
    method: input.method,
    params: input.params,
    ownerAddress: trade.ownerAddress,
    ownerIndex: trade.ownerIndex,
    message,
    displayAccount: accountId,
  });
}

/** After approval. The NEAR key is derived at the request's own owner index, like the EVM key. */
async function executeNear(record: InFlightRequest): Promise<unknown> {
  const trade = await findTradeByOwner(record.ownerIndex);
  const key = await deriveNearOwner(await requireUnlockedMnemonic(), record.ownerIndex);
  if (!trade?.appAccount?.address || trade.appAccount.address !== key.accountId) {
    throw rpcError(4100, 'Ghosty NEAR account mismatch; refusing to sign.');
  }
  const account = { accountId: key.accountId, publicKey: key.publicKey };
  switch (record.method) {
    case 'near_signIn':
      return [account];
    case 'near_signMessage':
      return signNep413(key, parseNep413(record.params));
    case 'near_signAndSendTransaction':
    case 'near_signAndSendTransactions': {
      const txs = parseNearTransactions(record.method, record.params, key.accountId);
      const outcomes = [];
      // In order: a later transaction often depends on an earlier one (a deposit before a swap).
      for (const tx of txs) {
        const outcome = await nearSignAndSend(key, tx.receiverId, tx.actions);
        outcomes.push(outcome);
        if (nearOutcomeFailure(outcome)) break;
      }
      return record.method === 'near_signAndSendTransaction' ? outcomes[0] : outcomes;
    }
    default:
      throw rpcError(4200, `Ghosty does not support ${record.method}.`);
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
    void Promise.all(tradeWaiters.map(async (waiter) => ({ waiter, trade: await tradeForOrigin(waiter.origin) }))).then((rows) => {
      for (const row of rows) {
        if (row.trade) continue;
        const index = tradeWaiters.indexOf(row.waiter);
        if (index === -1) continue;
        tradeWaiters.splice(index, 1);
        row.waiter.reject(rpcError(4001, 'User rejected the request.'));
      }
      if (tradeWaiters.length === 0) unwatchTrades();
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
