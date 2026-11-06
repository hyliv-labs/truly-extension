/**
 * The only viem client in the extension.
 *
 * Its transport is the anon-rpc harness, so every chain read is anonymised by
 * construction rather than by remembering to route each call. There is
 * deliberately no http() client anywhere else — see anon-rpc.ts for why a
 * fallback would be worse than an error.
 */

import { createPublicClient, custom } from 'viem';
import { arbitrum } from 'viem/chains';
import { anonRpcCall } from './anon-rpc';

export const anonTransport = custom({
  async request({ method, params }) {
    return anonRpcCall(method, (params as unknown[]) ?? []);
  },
});

export const publicClient = createPublicClient({
  chain: arbitrum,
  transport: anonTransport,
  /**
   * CCIP read is OFF, and this is not a preference.
   *
   * viem loads its CCIP-read handler with a dynamic import(), and Chrome
   * forbids dynamic import() in a service worker -- it throws
   * "disallowed on ServiceWorkerGlobalScope". The worker is a module worker
   * (see entrypoints/background.ts), which permits STATIC imports only.
   *
   * So an OffchainLookup revert on any read would not degrade: it would kill
   * the call with an error naming neither CCIP nor the import. None of the
   * contracts we read use CCIP, so nothing is lost by refusing it, and
   * `grep "import(" .output/chrome-mv3/background.js` should stay empty.
   */
  ccipRead: false,
});
