/**
 * Discovery must read through anon-rpc, not a direct HTTP transport.
 *
 * The SDK's DataService builds its own http() client from an rpcUrl string, so
 * by default every discovery read goes straight to that provider. Discovery is
 * the one operation that scans the whole pool, so doing it from the user's own
 * IP tells the provider this address is interested in Privacy Pools -- the
 * association the extension exists to prevent.
 *
 * This leak is INVISIBLE at runtime: discovery succeeds either way. So it has
 * to be asserted.
 *
 * Offline; part of `pnpm check`. No network calls are made -- only the
 * transport wiring is inspected.
 */

import { installChromeStub } from './chrome-stub.ts';

installChromeStub();

process.env.WXT_PRIVACY_POOL_ADDRESS ??= '0x3706e38af05bf0158BCdbB46239f8289980b093f';
process.env.WXT_PRIVACY_POOL_ENTRYPOINT ??= '0x44192215FEd782896BE2CE24E0Bfbf0BF825d15E';

const { createAnonDataService, usesAnonTransport } = await import('../src/lib/discovery.ts');
const { publicClient } = await import('../src/lib/chain.ts');
const { LOG_CHUNK_SIZE } = await import('../src/lib/config.ts');

let failed = false;
const fail = (m: string) => {
  console.error('FAIL', m);
  failed = true;
};
const pass = (m: string) => console.log('pass', m);

const service = createAnonDataService();
pass('DataService constructed');

if (!usesAnonTransport(service)) {
  fail('discovery is NOT routed through anon-rpc — the scan would leak to the RPC provider');
} else {
  pass('the Arbitrum client is our anon-rpc publicClient');
}

// Be specific: it must be the anon client, not merely "some client".
const clients = (service as unknown as { clients: Map<number, unknown> }).clients;
if (clients.get(42161) !== publicClient) {
  fail('the chain-42161 client is not the anon publicClient');
} else {
  pass('chain 42161 resolves to the anon publicClient by identity');
}

// The chunk size must be the configured one, or a full scan is ~11,000 calls.
const cfg = (service as unknown as { logFetchConfigs: Map<number, { blockChunkSize: number }> })
  .logFetchConfigs;
const chunk = cfg?.get(42161)?.blockChunkSize;
if (chunk !== LOG_CHUNK_SIZE) {
  fail(`blockChunkSize is ${chunk}, expected ${LOG_CHUNK_SIZE}`);
} else {
  pass(`blockChunkSize is ${chunk}, not the SDK's 10000 default`);
}

// The placeholder URL must never be a real endpoint.
const url = (service as unknown as { chainConfigs: Array<{ rpcUrl: string }> }).chainConfigs[0]
  ?.rpcUrl;
if (!url?.includes('invalid')) {
  fail(`the configured rpcUrl is ${url} — a real endpoint could be dialled if the swap regressed`);
} else {
  pass('the configured rpcUrl is an unroutable placeholder');
}

console.log(failed ? '\nFAILED' : '\ndiscovery transport OK');
process.exit(failed ? 1 : 0);
