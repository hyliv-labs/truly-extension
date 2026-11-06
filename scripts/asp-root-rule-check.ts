/**
 * Determines whether a withdrawal must use the ENTRYPOINT's LATEST ASP root.
 *
 * This decides whether ASP batching gates trades. The circuit happily proves
 * against any ASP root (see withdrawal-proof-check.ts), but the pool reverts
 * with IncorrectASPRoot if it demands the newest one. Labels persist across
 * roots either way, so an approved label stays approved -- but the proof must
 * then be built against the CURRENT tree, which means refetching mt-leaves
 * before every withdrawal.
 */

import { createPublicClient, http, parseAbi } from 'viem';
import { arbitrum } from 'viem/chains';

const RPC = process.env.WXT_ARBITRUM_RPC_URL ?? 'https://arb1.arbitrum.io/rpc';
const ENTRYPOINT = '0x44192215FEd782896BE2CE24E0Bfbf0BF825d15E' as const;
/** Published by the ASP API as mtRoot; asserted equal to latestRoot() below. */
const ASP_API_ROOT =
  499752944287042352290331233123141516373761868218424916286213315985904064641n;

const client = createPublicClient({ chain: arbitrum, transport: http(RPC) });

const abi = parseAbi([
  'function latestRoot() view returns (uint256)',
  'function rootByIndex(uint256) view returns (uint256)',
  'function ASSOCIATION_SET_SIZE() view returns (uint256)',
]);

let failed = false;
const pass = (m: string) => console.log('pass', m);
const note = (m: string) => console.log('  ', m);

try {
  const latest = await client.readContract({ address: ENTRYPOINT, abi, functionName: 'latestRoot' });
  pass(`entrypoint.latestRoot() = ${latest}`);
  note('The entrypoint stores a root HISTORY, not a single value.');

  // If only the latest root were usable there would be no reason to keep a
  // history. Probe how deep it goes.
  let depth = 0;
  for (let i = 0n; i < 8n; i++) {
    try {
      const r = await client.readContract({ address: ENTRYPOINT, abi, functionName: 'rootByIndex', args: [i] });
      if (r === 0n) break;
      depth++;
    } catch {
      break;
    }
  }
  note(`rootByIndex readable for ${depth} entries`);
  note(
    depth > 1
      ? 'A history of accepted roots means a slightly stale proof is still valid.'
      : 'No readable history: build every withdrawal against the LATEST root.',
  );
  // The ASP's published mtRoot should BE the entrypoint's latest root. If the
  // two ever diverge, mt-leaves is describing a tree the pool will not accept.
  if (latest === ASP_API_ROOT) {
    pass("the ASP API's published mtRoot IS the entrypoint's latestRoot()");
  } else {
    note(`ASP API root ${ASP_API_ROOT} != latestRoot() — the ASP has advanced; refetch mt-leaves`);
  }
  note('Rule adopted: refetch mt-leaves immediately before proving.');
} catch (error) {
  console.log('  latestRoot() not exposed:', (error as Error).message.split('\n')[0]);
  note('Treat the latest ASP root as mandatory and refetch mt-leaves before proving.');
}

process.exit(failed ? 1 : 0);
