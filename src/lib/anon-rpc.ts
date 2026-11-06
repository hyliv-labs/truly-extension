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
  ANON_RPC_TIMEOUT_MS,
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

  // Gateways are NOT required in general — they are a tor-js requirement.
  // nym runs a mixnet client in the sandbox and needs no gateway at all, so
  // demanding one here would rule out the worker that has no single point of
  // failure. Pass config only when there is config to pass, and let a worker
  // that needs one say so: tor-js's message is explicit.
  worker = new AnonRpcWorker({
    address: ANON_RPC_SPECIFIER!,
    // Opaque to the harness by design (SPEC 7.1); the schema belongs to the
    // worker. tor-js wants { gateways: [...] }.
    ...(ANON_RPC_GATEWAYS.length > 0 ? { config: { gateways: ANON_RPC_GATEWAYS } } : {}),
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
  // The AbortSignal on the Request below is NOT enough on its own: the harness
  // forwards the Request into the sandboxed worker and the signal does not
  // reach it. Measured: with the mixnet connection stalled, a balance read
  // never settled, the session step waited on it for 15+ minutes, and every
  // later call ("End trade" included) queued behind it. This deadline lives
  // here, so it always fires; the stalled worker is dropped so the next read
  // reconnects instead of waiting on the same dead connection.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      resetAnonRpc();
      reject(
        new AnonRpcUnavailable(
          `No answer over anon-rpc for ${method} within ${Math.round(ANON_RPC_TIMEOUT_MS / 1000)}s. The connection was reset; the next read reconnects.`,
        ),
      );
    }, ANON_RPC_TIMEOUT_MS);
  });
  try {
    return await Promise.race([anonRpcCallOnce(method, params), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function anonRpcCallOnce(method: string, params: unknown[]): Promise<unknown> {
  let active: AnonRpcWorker;
  try {
    active = await getWorker();
  } catch (error) {
    if (error instanceof AnonRpcUnavailable) throw error;
    throw new AnonRpcUnavailable(
      error instanceof Error ? error.message : String(error),
    );
  }

  // A dead gateway does not refuse the dial, it just never answers. Without a
  // deadline the read never settles and every caller waits forever.
  let response: Response;
  try {
    // A pre-built Request, passed with NO init. The harness forwards such a
    // Request unchanged; give it a url + init pair instead and it rebuilds
    // one, and the content-type did not survive that rebuild — arb1 replied
    // "415 invalid content type, only application/json is supported".
    const request = new Request(ARBITRUM_RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(ANON_RPC_TIMEOUT_MS),
    });
    response = await active.fetch(request);
  } catch (error) {
    const aborted =
      error instanceof DOMException &&
      (error.name === 'TimeoutError' || error.name === 'AbortError');
    if (aborted) {
      throw new AnonRpcUnavailable(
        `No response from the anon-rpc gateway within ${Math.round(ANON_RPC_TIMEOUT_MS / 1000)}s. ` +
          'The configured KPS gateway may be down or saturated — the published one is a demonstration gateway with no availability guarantee. Set WXT_ANON_RPC_GATEWAYS to another.',
      );
    }
    throw new AnonRpcUnavailable(error instanceof Error ? error.message : String(error));
  }

  if (!response.ok) {
    // The body carries the reason. Without it a 415 or a 429 is just a
    // number, and the number alone points at anon-rpc when the complaint is
    // usually the RPC endpoint's.
    let detail = '';
    try {
      detail = (await response.text()).slice(0, 300);
    } catch {
      detail = '(no body)';
    }
    throw new AnonRpcUnavailable(
      `anon-rpc returned ${response.status} for ${method}${detail ? `: ${detail}` : ''}`,
    );
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
