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
});
