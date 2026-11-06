/**
 * E2: every Arbitrum read goes through the anon-rpc harness.
 *
 * The AnonRpcWorker is constructed here in the service worker; the DOM it
 * needs lives in our offscreen document, which has already mounted the host
 * (hence offscreenUrl: false — an extension may have only one).
 */

import { AnonRpcWorker } from '@anon-rpc/browser-extension-harness';
import type { RpcProvider } from '@anon-rpc/browser-harness';
import {
  ANON_RPC_GATEWAYS,
  ANON_RPC_SPECIFIER,
  ARBITRUM_RPC_URL,
  BOOTSTRAP_RPC_URL,
  configProblems,
} from './config';
import { ensureOffscreenDocument } from './offscreen';

const LOCAL_READ_COUNT = 'truly:anonRpcReads';

/**
 * Module-scoped, so it dies with the worker — which is correct. `reuse` is on
 * by default, so the offscreen document hands back the worker it already
 * booted rather than re-verifying the bundle on every service-worker restart.
 */
let worker: AnonRpcWorker | null = null;

export class AnonRpcUnavailable extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'AnonRpcUnavailable';
  }
}

/**
 * Bootstrap provider. Used for exactly one thing: reading the specifier
 * contract, which breaks the circular "need the chain to reach the chain"
 * dependency. It is NOT anonymised, so nothing else may use it.
 */
const bootstrapProvider: RpcProvider = {
  async request({ method, params }) {
    const response = await fetch(BOOTSTRAP_RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params ?? [] }),
    });
    if (!response.ok) {
      throw new Error(`bootstrap RPC ${response.status}`);
    }
    const json = (await response.json()) as { result?: unknown; error?: { message: string } };
    if (json.error) throw new Error(json.error.message);
    return json.result;
  },
};

async function getWorker(): Promise<AnonRpcWorker> {
  const problems = configProblems();
  if (problems.length > 0) {
    throw new AnonRpcUnavailable(problems.map((p) => p.reason).join(' '));
  }

  if (worker) return worker;

  // Our document, not the harness's: offscreenUrl: false below.
  await ensureOffscreenDocument();

  if (ANON_RPC_GATEWAYS.length === 0) {
    throw new AnonRpcUnavailable(
      'No anon-rpc gateway configured. tor-js has no default: browsers cannot open the raw TCP Tor needs, so it relays through a KPS gateway. Set WXT_ANON_RPC_GATEWAYS.',
    );
  }

  worker = new AnonRpcWorker({
    address: ANON_RPC_SPECIFIER!,
    // Opaque to the harness by design — the schema is the worker's, and
    // tor-js wants { gateways: [...] }. Without it the worker boots and then
    // refuses every fetch, which reads like a network failure rather than
    // missing configuration.
    config: { gateways: ANON_RPC_GATEWAYS },
    preExisting: { rpcProvider: bootstrapProvider },
    offscreenUrl: false,
  });

  return worker;
}

/** Drop the cached worker so the next read re-boots it. */
export function resetAnonRpc(): void {
  worker?.close();
  worker = null;
}

export async function getReadCount(): Promise<number> {
  const stored = await chrome.storage.local.get(LOCAL_READ_COUNT);
  const count = stored[LOCAL_READ_COUNT];
  return typeof count === 'number' ? count : 0;
}

async function countRead(): Promise<void> {
  await chrome.storage.local.set({ [LOCAL_READ_COUNT]: (await getReadCount()) + 1 });
}

/**
 * One JSON-RPC call through the anon-client. Throws AnonRpcUnavailable rather
 * than falling back to a direct fetch: a silent fallback would deanonymise the
 * user at exactly the moment they believe they are protected.
 */
export async function anonRpcCall(
  method: string,
  params: unknown[] = [],
): Promise<unknown> {
  let active: AnonRpcWorker;
  try {
    active = await getWorker();
  } catch (error) {
    if (error instanceof AnonRpcUnavailable) throw error;
    throw new AnonRpcUnavailable(
      error instanceof Error ? error.message : String(error),
    );
  }

  const response = await active.fetch(ARBITRUM_RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });

  if (!response.ok) {
    throw new AnonRpcUnavailable(`anon-rpc returned ${response.status}`);
  }

  const json = (await response.json()) as {
    result?: unknown;
    error?: { code: number; message: string };
  };

  // Counted after a response comes back, so the figure in the popup means
  // "reads actually anonymised", not "reads attempted".
  await countRead();

  if (json.error) {
    throw Object.assign(new Error(json.error.message), { code: json.error.code });
  }
  return json.result;
}
