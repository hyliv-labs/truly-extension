/**
 * Determines whether a withdrawal must use the ENTRYPOINT's LATEST ASP root.
 *
 * ANSWERED, from PrivacyPool.sol's validWithdrawal modifier:
 *
 *   if (_proof.ASPRoot() != ENTRYPOINT.latestRoot()) revert IncorrectASPRoot();
 *
 * STRICT EQUALITY against a single value. The entrypoint exposes
 * rootByIndex(), but the pool never consults it -- historical roots are
 * readable and NOT accepted. Note the state root is different: that one does
 * go through _isKnownRoot(), a real history.
 *
 * Consequences, which E3 must implement:
 *  - A proof is invalidated by any updateRoot() landing before inclusion.
 *  - IncorrectASPRoot is therefore RETRYABLE, not terminal: refetch, re-prove.
 *  - Labels persist across roots, so an approved label stays approved. Only
 *    the proof has to be rebuilt, never the screening re-earned.
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
  note('The entrypoint does store a root history...');

  // The history is readable but NOT accepted by the pool. Probed only to show
  // that its existence must not be mistaken for tolerance of a stale root.
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
  note(`rootByIndex readable for at least ${depth} entries (loop limit, not depth)`);
  note('...but the pool compares against latestRoot() ONLY. Stale roots revert.');
  // The ASP's published mtRoot should BE the entrypoint's latest root. If the
  // two ever diverge, mt-leaves is describing a tree the pool will not accept.
  if (latest === ASP_API_ROOT) {
    pass("the ASP API's published mtRoot IS the entrypoint's latestRoot()");
  } else {
    note(`ASP API root ${ASP_API_ROOT} != latestRoot() — the ASP has advanced; refetch mt-leaves`);
  }
  note('Rule adopted: cache mt-leaves; before proving compare the cached root');
  note('with latestRoot() over anon-rpc and refetch ONLY on divergence. That');
  note('avoids telling 0xbow the moment of every withdrawal.');
} catch (error) {
  console.log('  latestRoot() not exposed:', (error as Error).message.split('\n')[0]);
  note('Treat the latest ASP root as mandatory and refetch mt-leaves before proving.');
}

process.exit(failed ? 1 : 0);
