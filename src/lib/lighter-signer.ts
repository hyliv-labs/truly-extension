/**
 * Lighter's official transaction signer (lighter-go `wasm/`), loaded in the
 * service worker so API keys and the owner key never cross a message channel.
 *
 * Every export of the Go module is a synchronous global that returns
 * `{ error }` or `{ txType, txInfo, txHash, messageToSign? }`. The signer is
 * offline: nonces come from the caller, never from the signer's own HTTP
 * client, because Go's net/http does not work under js/wasm.
 *
 * Built by scripts/build-lighter-signer.ts from a pinned commit.
 */

import { GoRuntime } from '../vendor/go-wasm-exec.js';

/** Lighter mainnet's L2 chain id, as lighter-go's wasm/main.go expects it. */
export const LIGHTER_MAINNET_CHAIN_ID = 304;

/** Where the signer is served from inside the extension. */
export const SIGNER_PATH = 'lighter/lighter-signer.wasm';

/**
 * wasm_exec.js installs stub `fs` and `process` globals when they are missing.
 * In the worker they never exist, and leaving a fake `process` around makes
 * other libraries believe they are in Node. They are captured and removed the
 * moment the runtime module has evaluated, and lent back only while the Go
 * runtime initialises — Go keeps its own references after that.
 */
const goGlobals = isolateGoGlobals();

function isolateGoGlobals(): { fs?: unknown; process?: unknown } {
  const g = globalThis as Record<string, unknown>;
  const captured: { fs?: unknown; process?: unknown } = {};

  const fs = g.fs as { constants?: { O_WRONLY?: number } } | undefined;
  if (fs?.constants?.O_WRONLY === -1) {
    captured.fs = fs;
    delete g.fs;
  }
  // Node's real process has `versions`; the Go stub does not.
  const proc = g.process as { versions?: unknown } | undefined;
  if (proc && proc.versions === undefined) {
    captured.process = proc;
    delete g.process;
  }
  return captured;
}

export class LighterSignerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LighterSignerError';
  }
}

export interface SignedTx {
  readonly txType: number;
  /** JSON string, sent verbatim as `tx_info`. */
  readonly txInfo: string;
  /** Computed offline, so a submission can be looked up even if sendTx timed out. */
  readonly txHash: string;
  readonly messageToSign?: string;
}

type SignerResult = Partial<SignedTx> & { error?: string };
type SignerFn = (...args: unknown[]) => unknown;

let ready: Promise<void> | null = null;

/** Load and start the Go module once per worker lifetime. */
export function loadSigner(fetchBytes: () => Promise<ArrayBuffer> = defaultFetch): Promise<void> {
  ready ??= (async () => {
    const go = new GoRuntime();
    const { instance } = await WebAssembly.instantiate(await fetchBytes(), go.importObject);

    const g = globalThis as Record<string, unknown>;
    const lent: string[] = [];
    for (const [name, value] of Object.entries(goGlobals)) {
      if (value !== undefined && g[name] === undefined) {
        g[name] = value;
        lent.push(name);
      }
    }
    try {
      // Runs Go's init synchronously up to main's select{}; the promise only
      // settles if the program exits, which it must not.
      void go.run(instance).then(() => {
        ready = null;
      });
    } finally {
      for (const name of lent) delete g[name];
    }

    if (typeof g.SignCreateOrder !== 'function') {
      ready = null;
      throw new LighterSignerError('Lighter signer started but exported no functions.');
    }
  })().catch((error: unknown) => {
    ready = null;
    throw error;
  });
  return ready;
}

async function defaultFetch(): Promise<ArrayBuffer> {
  const response = await fetch(chrome.runtime.getURL(SIGNER_PATH));
  if (!response.ok) {
    throw new LighterSignerError(
      `Lighter signer missing from the build (${response.status}). Run scripts/build-lighter-signer.ts.`,
    );
  }
  return response.arrayBuffer();
}

function call(name: string, ...args: unknown[]): SignerResult {
  const fn = (globalThis as Record<string, unknown>)[name] as SignerFn | undefined;
  if (typeof fn !== 'function') {
    throw new LighterSignerError(`Lighter signer is not loaded (${name}).`);
  }
  const result = fn(...args) as SignerResult | undefined;
  if (!result) throw new LighterSignerError(`${name} returned nothing.`);
  if (result.error) throw new LighterSignerError(`${name}: ${result.error}`);
  return result;
}

function signed(name: string, ...args: unknown[]): SignedTx {
  const result = call(name, ...args);
  if (typeof result.txType !== 'number' || !result.txInfo || !result.txHash) {
    throw new LighterSignerError(`${name} returned an incomplete transaction.`);
  }
  return {
    txType: result.txType,
    txInfo: result.txInfo,
    txHash: result.txHash,
    ...(result.messageToSign ? { messageToSign: result.messageToSign } : {}),
  };
}

export interface ApiKeyPair {
  readonly privateKey: string;
  readonly publicKey: string;
}

/** A random API key. The signer takes no seed, so the caller must persist it. */
export async function generateApiKey(): Promise<ApiKeyPair> {
  await loadSigner();
  const result = call('GenerateAPIKey') as SignerResult & Partial<ApiKeyPair>;
  if (!result.privateKey || !result.publicKey) {
    throw new LighterSignerError('GenerateAPIKey returned no key.');
  }
  return { privateKey: result.privateKey, publicKey: result.publicKey };
}

export interface SignerAccount {
  readonly privateKey: string;
  readonly apiKeyIndex: number;
  readonly accountIndex: number;
}

/** Registers the key with the Go signer. Idempotent; call before every sign. */
async function bind(account: SignerAccount): Promise<void> {
  await loadSigner();
  call('CreateClient', '', account.privateKey, LIGHTER_MAINNET_CHAIN_ID, account.apiKeyIndex, account.accountIndex);
}

/**
 * Authorise `publicKey` as this account's API key. The returned
 * `messageToSign` must be personal_sign'ed by the owner and attached as L1Sig.
 */
export async function signChangePubKey(
  account: SignerAccount,
  publicKey: string,
  nonce: number,
): Promise<SignedTx & { messageToSign: string }> {
  await bind(account);
  const tx = signed('SignChangePubKey', publicKey, 0, nonce, account.apiKeyIndex, account.accountIndex);
  if (!tx.messageToSign) throw new LighterSignerError('SignChangePubKey returned no L1 message.');
  return tx as SignedTx & { messageToSign: string };
}

/** Attach the owner's L1 signature; the tx hash does not cover it. */
export function withL1Signature(tx: SignedTx, l1Signature: string): SignedTx {
  const info = JSON.parse(tx.txInfo) as Record<string, unknown>;
  info.L1Sig = l1Signature;
  const { messageToSign: _omit, ...rest } = tx;
  return { ...rest, txInfo: JSON.stringify(info) };
}

/** Cross margin, the mode Lighter's own UI defaults to. */
export const MARGIN_MODE_CROSS = 0;

export async function signUpdateLeverage(
  account: SignerAccount,
  marketIndex: number,
  initialMarginFraction: number,
  nonce: number,
): Promise<SignedTx> {
  await bind(account);
  return signed(
    'SignUpdateLeverage',
    marketIndex,
    initialMarginFraction,
    MARGIN_MODE_CROSS,
    0,
    nonce,
    account.apiKeyIndex,
    account.accountIndex,
  );
}

/** lighter-go txtypes: ORDER_TYPE_MARKET and TIME_IN_FORCE_IMMEDIATE_OR_CANCEL. */
export const ORDER_TYPE_MARKET = 1;
export const TIME_IN_FORCE_IOC = 0;

export interface MarketOrderParams {
  readonly marketIndex: number;
  readonly clientOrderIndex: number;
  /** Integer, scaled by the market's size_decimals. */
  readonly baseAmount: number;
  /** Worst acceptable price, integer, scaled by price_decimals. */
  readonly price: number;
  readonly isAsk: boolean;
  readonly reduceOnly: boolean;
}

/** lighter-go USDC asset id and the perps collateral route. */
export const USDC_ASSET_INDEX = 3;
export const ROUTE_PERPS = 0;

/**
 * Secure withdrawal. Lighter settles this on Ethereum, at the account owner's
 * address. It cannot be re-shielded on Arbitrum. The return path uses
 * `signFastWithdraw`.
 */
export async function signWithdraw(
  account: SignerAccount,
  amountUnits: bigint,
  nonce: number,
): Promise<SignedTx> {
  if (amountUnits <= 0n || amountUnits > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new LighterSignerError('Withdrawal amount is outside the range the signer accepts.');
  }
  await bind(account);
  return signed(
    'SignWithdraw',
    USDC_ASSET_INDEX,
    ROUTE_PERPS,
    Number(amountUnits),
    0,
    nonce,
    account.apiKeyIndex,
    account.accountIndex,
  );
}

/** 20-byte address plus 12 zero bytes, the memo a fast withdrawal commits to. */
export function fastWithdrawMemo(address: string): string {
  const hex = address.toLowerCase().replace(/^0x/, '');
  if (!/^[\da-f]{40}$/.test(hex)) {
    throw new LighterSignerError('Fast withdrawal destination is not an address.');
  }
  return `${hex}${'00'.repeat(12)}`;
}

export interface FastWithdrawParams {
  /** Lighter's fast-withdraw pool, from `/fastwithdraw/info`. */
  readonly toAccountIndex: number;
  /** USDC that leaves, in 6-decimal units. The fee is extra and stays behind. */
  readonly amountUnits: bigint;
  /** `transfer_fee_usdc` from Lighter. It has to match exactly. */
  readonly feeUnits: bigint;
  /** Where the pool pays the USDC. On this product, the fresh owner. */
  readonly toAddress: string;
  readonly nonce: number;
}

/**
 * Fast withdrawal: a transfer to Lighter's pool with the destination in the
 * memo. The owner must `personal_sign` `messageToSign` and the result is
 * posted to `/fastwithdraw`, not `sendTx`. USDC arrives on Arbitrum.
 */
export async function signFastWithdraw(
  account: SignerAccount,
  params: FastWithdrawParams,
): Promise<SignedTx & { messageToSign: string }> {
  if (params.amountUnits <= 0n || params.amountUnits > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new LighterSignerError('Withdrawal amount is outside the range the signer accepts.');
  }
  if (params.feeUnits < 0n || params.feeUnits > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new LighterSignerError('Withdrawal fee is outside the range the signer accepts.');
  }
  await bind(account);
  const tx = signed(
    'SignTransfer',
    params.toAccountIndex,
    USDC_ASSET_INDEX,
    ROUTE_PERPS,
    ROUTE_PERPS,
    Number(params.amountUnits),
    Number(params.feeUnits),
    fastWithdrawMemo(params.toAddress),
    0,
    params.nonce,
    account.apiKeyIndex,
    account.accountIndex,
  );
  if (!tx.messageToSign) throw new LighterSignerError('The fast withdrawal returned no L1 message.');
  return tx as SignedTx & { messageToSign: string };
}

/** An immediate-or-cancel market order. Nothing rests on the book. */
export async function signMarketOrder(
  account: SignerAccount,
  order: MarketOrderParams,
  nonce: number,
): Promise<SignedTx> {
  await bind(account);
  return signed(
    'SignCreateOrder',
    order.marketIndex,
    order.clientOrderIndex,
    order.baseAmount,
    order.price,
    order.isAsk ? 1 : 0,
    ORDER_TYPE_MARKET,
    TIME_IN_FORCE_IOC,
    order.reduceOnly ? 1 : 0,
    0, // trigger price
    0, // order expiry: required to be 0 for IOC
    0, // integrator account
    0, // integrator taker fee
    0, // integrator maker fee
    0, // self-trade behaviour
    0, // self-trade equality
    0, // skipNonce
    nonce,
    account.apiKeyIndex,
    account.accountIndex,
  );
}

/** Read-only auth for order queries. `deadline` 0 lets the signer pick its default. */
export async function createAuthToken(account: SignerAccount, deadline = 0): Promise<string> {
  await bind(account);
  const result = call('CreateAuthToken', deadline, account.apiKeyIndex, account.accountIndex) as SignerResult & {
    authToken?: string;
  };
  if (!result.authToken) throw new LighterSignerError('CreateAuthToken returned no token.');
  return result.authToken;
}

/** `ExpiredAt` from a signed tx, in ms. After this it can never execute. */
export function txExpiresAt(tx: Pick<SignedTx, 'txInfo'>): number | null {
  try {
    const value = (JSON.parse(tx.txInfo) as { ExpiredAt?: unknown }).ExpiredAt;
    return typeof value === 'number' && value > 0 ? value : null;
  } catch {
    return null;
  }
}
