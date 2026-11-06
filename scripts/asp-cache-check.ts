/**
 * The ASP association-set cache.
 *
 * Fetching the tree is a plain HTTPS call to 0xbow from the user's IP --
 * anon-rpc cannot carry it. Pulling it before every withdrawal would hand
 * 0xbow the timing of each one, so the tree is cached and refetched only when
 * the on-chain root moves.
 *
 * Two failures to guard, both silent:
 *  - refetching when the cache was valid, which leaks timing for no reason
 *  - SERVING a stale cache after the root moved, which builds a proof that
 *    reverts with IncorrectASPRoot after the quote and proof are already spent
 *
 * Offline: the chain read and the ASP fetch are both stubbed, so this asserts
 * the decision logic rather than the network.
 */

import { installChromeStub } from './chrome-stub.ts';

installChromeStub();

process.env.WXT_PRIVACY_POOL_ENTRYPOINT ??= '0x44192215FEd782896BE2CE24E0Bfbf0BF825d15E';

let failed = false;
const fail = (m: string) => {
  console.error('FAIL', m);
  failed = true;
};
const pass = (m: string) => console.log('pass', m);

const SCOPE = 19314316433070648921215665277427138450050666275686107272761703472573535400848n;
const LABEL = 42n;

// --- stub the two network edges -------------------------------------------
let acceptedRoot = 100n;
let publishedRoot = 100n;
let fetchCount = 0;

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = String(input);
  fetchCount++;
  if (url.includes('mt-leaves')) {
    return new Response(
      JSON.stringify({ aspLeaves: [LABEL.toString(), '999'], stateTreeLeaves: ['7', '8'] }),
      { status: 200 },
    );
  }
  if (url.includes('mt-roots')) {
    return new Response(JSON.stringify({ mtRoot: publishedRoot.toString() }), { status: 200 });
  }
  return new Response('{}', { status: 404 });
}) as typeof fetch;

const chain = await import('../src/lib/chain.ts');
// The entrypoint read must go through the anon client; stub at that boundary.
(chain.publicClient as unknown as { readContract: () => Promise<bigint> }).readContract =
  async () => acceptedRoot;

const {
  getAssociationSet,
  isLabelApproved,
  clearAssociationSetCache,
  AspUnavailable,
} = await import('../src/lib/asp.ts');

// --- 1. cold cache fetches -------------------------------------------------
await clearAssociationSetCache();
fetchCount = 0;
const first = await getAssociationSet(SCOPE);
if (first.fromCache) {
  fail('a cold cache claimed to be served from cache');
} else {
  pass('a cold cache fetches from the ASP');
}
if (fetchCount === 0) fail('no ASP request was made on a cold cache');

// --- 2. warm cache with an UNCHANGED root must not contact 0xbow ----------
fetchCount = 0;
const second = await getAssociationSet(SCOPE);
if (!second.fromCache) {
  fail('the cache was not reused although the root had not moved');
} else {
  pass('an unchanged root reuses the cache');
}
if (fetchCount !== 0) {
  fail(`${fetchCount} ASP requests were made with a valid cache — that leaks withdrawal timing`);
} else {
  pass('a valid cache contacts 0xbow ZERO times');
}

// --- 3. the root moves: the stale cache must NOT be served ----------------
acceptedRoot = 200n;
publishedRoot = 200n;
fetchCount = 0;
const third = await getAssociationSet(SCOPE);
if (third.fromCache) {
  fail('a STALE cache was served after the root moved — the proof would revert IncorrectASPRoot');
} else {
  pass('a moved root refetches rather than serving the stale cache');
}
if (third.set.root !== 200n) {
  fail(`refetch returned root ${third.set.root}, expected the new 200`);
} else {
  pass('the refetched set carries the new root');
}

// --- 4. ASP and chain disagreeing must refuse, not guess ------------------
acceptedRoot = 300n;
publishedRoot = 299n; // mid-publish
await clearAssociationSetCache();
try {
  await getAssociationSet(SCOPE);
  fail('a published/accepted root mismatch was accepted — the proof could not land');
} catch (error) {
  if (error instanceof AspUnavailable) {
    pass('a published/accepted root mismatch is refused before a quote is spent');
  } else {
    fail(`mismatch threw the wrong error: ${(error as Error).name}`);
  }
}

// --- 5. label membership --------------------------------------------------
acceptedRoot = 400n;
publishedRoot = 400n;
await clearAssociationSetCache();
const set = (await getAssociationSet(SCOPE)).set;
if (!isLabelApproved(set, LABEL)) {
  fail('an approved label was reported unapproved');
} else {
  pass('an approved label is recognised');
}
if (isLabelApproved(set, 123456n)) {
  fail('an unapproved label was reported approved — the withdrawal would revert');
} else {
  pass('an unapproved label is rejected');
}

globalThis.fetch = realFetch;
console.log(failed ? '\nFAILED' : '\nASP cache logic OK');
process.exit(failed ? 1 : 0);
