/**
 * Duplicate-order prevention and recovery guards for the market-trade session.
 *
 * The property that matters: Truly never produces two different signed orders
 * for one attempt, never re-sends unless Lighter provably lacks the original,
 * and never offers a retry while the previous attempt's outcome is unknown.
 * Offline (Lighter's API is faked through driveTx's deps); part of `pnpm check`.
 */

import { installChromeStub } from './chrome-stub.ts';

installChromeStub();

const { driveTx, retryOrder, closePosition, classifyFundingError, SessionError } = await import(
  '../src/lib/trade-session.ts'
);
const { updateSession, getActiveTrade } = await import('../src/lib/trade.ts');

let failed = false;
const fail = (m: string) => {
  console.error('FAIL', m);
  failed = true;
};
const pass = (m: string) => console.log('pass', m);

const NOW = 1_800_000_000_000;
const signed = (over: Record<string, unknown> = {}) => ({
  txType: 14,
  txInfo: JSON.stringify({ Nonce: 7, ExpiredAt: NOW + 600_000 }),
  txHash: 'ab'.repeat(40),
  nonce: 7,
  status: 'signed' as const,
  signedAt: NOW,
  ...over,
});

const fake = (opts: { found?: boolean; next?: number; send?: 'accepted' | 'rejected' | 'uncertain' | 'nonce'; now?: number }) => {
  const sent: string[] = [];
  return {
    sent,
    deps: {
      lookup: async () => (opts.found ? { found: true as const, status: 3 } : { found: false as const }),
      nonce: async () => opts.next ?? 7,
      send: async (tx: { txInfo: string }) => {
        sent.push(tx.txInfo);
        switch (opts.send ?? 'accepted') {
          case 'accepted':
            return { kind: 'accepted' as const, txHash: 'ab'.repeat(40) };
          case 'rejected':
            return { kind: 'rejected' as const, code: 21701, message: 'invalid base amount' };
          case 'nonce':
            return { kind: 'uncertain' as const, message: 'invalid nonce' };
          default:
            return { kind: 'uncertain' as const, message: 'timeout' };
        }
      },
      now: () => opts.now ?? NOW + 1_000,
    },
  };
};

// A tx Lighter already has is never sent again.
{
  const f = fake({ found: true });
  const out = await driveTx(signed(), 1, 4, f.deps);
  if (out.status !== 'accepted' || f.sent.length) fail('a tx Lighter already sequenced was re-sent');
  else pass('a tx found by its offline hash is marked accepted without sending');
}
// Nonce consumed (indexer lag): ours, do not send.
{
  const f = fake({ next: 8 });
  const out = await driveTx(signed(), 1, 4, f.deps);
  if (out.status !== 'accepted' || f.sent.length) fail('a consumed nonce led to a resend');
  else pass('a consumed nonce is treated as sequenced; nothing is re-sent');
}
// Provably absent and still valid: send the IDENTICAL bytes.
{
  const tx = signed();
  const f = fake({});
  const out = await driveTx(tx, 1, 4, f.deps);
  if (out.status !== 'accepted' || f.sent.length !== 1 || f.sent[0] !== tx.txInfo) fail('first send did not use the stored bytes');
  else pass('a provably absent tx is sent with its stored signed bytes');
}
// An uncertain one is resent only as the same bytes.
{
  const tx = signed({ status: 'uncertain' });
  const f = fake({ send: 'uncertain' });
  const a = await driveTx(tx, 1, 4, f.deps);
  const b = await driveTx(a, 1, 4, f.deps);
  if (b.status !== 'uncertain' || f.sent.some((s) => s !== tx.txInfo)) fail('an uncertain retry changed the signed payload');
  else pass('retrying an uncertain submission re-sends identical bytes (same nonce, cannot execute twice)');
}
// Expired without its nonce consumed: dead, and NOT sent.
{
  const f = fake({ now: NOW + 600_000 + 31_000 });
  const out = await driveTx(signed({ status: 'uncertain' }), 1, 4, f.deps);
  if (out.status !== 'expired' || f.sent.length) fail('an expired tx was sent or not marked dead');
  else pass('an expired, unsequenced tx is marked dead and never sent');
}
// A real refusal is final.
{
  const f = fake({ send: 'rejected' });
  const out = await driveTx(signed(), 1, 4, f.deps);
  if (out.status !== 'rejected' || out.code !== 21701) fail('a refusal was not recorded as rejected');
  else pass('a definite refusal is recorded with Lighter\'s code');
  const again = await driveTx(out, 1, 4, f.deps);
  if (f.sent.length !== 1 || again.status !== 'rejected') fail('a rejected tx was sent again');
  else pass('a rejected tx is terminal');
}
// A nonce refusal on resend is NOT a rejection.
{
  const f = fake({ send: 'nonce' });
  const out = await driveTx(signed(), 1, 4, f.deps);
  if (out.status !== 'uncertain') fail(`a nonce refusal became ${out.status}`);
  else pass('a nonce refusal stays uncertain (may mean the original landed)');
}

// --- session guards -----------------------------------------------------------
const quote = { marketId: 0, symbol: 'ETH', grossWithdrawalUnits: '10045045' } as never;
const setSession = async (over: Record<string, unknown>) => {
  await chrome.storage.local.set({
    'truly:activeTrade': {
      ownerIndex: 3,
      ownerAddress: '0x000000000000000000000000000000000000dEaD',
      startedAt: NOW,
      accountIndex: 99,
      session: {
        id: 'sess-1',
        createdAt: NOW,
        updatedAt: NOW,
        marketId: 0,
        symbol: 'ETH',
        direction: 'long',
        leverage: 5,
        marginUnits: '10000000',
        quote,
        state: 'order-uncertain',
        detail: '',
        ...over,
      },
    },
  });
};

await setSession({ state: 'order-uncertain', order: { tx: signed({ status: 'uncertain' }) } });
try {
  await retryOrder();
  fail('a retry was allowed while the order outcome is unknown');
} catch (error) {
  if (error instanceof SessionError && error.code === 'not-retryable') pass('no retry while an order outcome is uncertain');
  else fail(`uncertain retry threw ${(error as Error).message}`);
}

await setSession({ state: 'submitting-order' });
try {
  await retryOrder();
  fail('a retry was allowed mid-submission');
} catch {
  pass('no retry mid-submission');
}

await setSession({ state: 'open', close: { tx: signed({ status: 'accepted' }), clientOrderIndex: 5 } });
try {
  await closePosition();
  fail('a second close was signed while one is in flight');
} catch (error) {
  if (error instanceof SessionError && error.code === 'close-in-flight') pass('a second close is refused while one is in flight');
  else fail(`in-flight close threw ${(error as Error).message}`);
}

await setSession({ state: 'awaiting-deposit' });
try {
  await closePosition();
  fail('closing was offered before a position could exist');
} catch {
  pass('close is refused before the position exists');
}

// Sessions cannot be crossed: a write for another session id is refused.
try {
  await updateSession('some-other-session', () => ({ state: 'open' }));
  fail('a write for a different session id was applied');
} catch {
  const t = await getActiveTrade();
  if (t?.session?.state !== 'awaiting-deposit') fail('the foreign write changed this session');
  else pass('a write addressed to another session id is refused');
}

// Concurrent writers do not drop each other's fields.
await Promise.all([
  updateSession('sess-1', () => ({ creditedUsd: 9.9 })),
  updateSession('sess-1', () => ({ detail: 'concurrent' })),
]);
{
  const s = (await getActiveTrade())?.session;
  if (s?.creditedUsd !== 9.9 || s?.detail !== 'concurrent') fail('a concurrent session write was lost');
  else pass('concurrent session writes are serialised, none lost');
}

// --- funding errors map to the named cases ------------------------------------
const map: [string, string][] = [
  ['This deposit has not yet been approved by the ASP', 'pending-asp'],
  ['No note is large enough to fund a trade', 'insufficient-balance'],
  ['Failed to generate proof', 'proof-failed'],
  ['relayer refused the request: fee too low', 'relayer-rejected'],
  ['anon-rpc request timed out', 'anon-rpc-timeout'],
  ['execution reverted: IncorrectASPRoot', 'pending-asp'],
  ['transaction reverted', 'arbitrum-revert'],
];
let mapped = true;
for (const [msg, code] of map) {
  const got = classifyFundingError(new Error(msg));
  if (got !== code) {
    mapped = false;
    fail(`"${msg}" -> ${got}, expected ${code}`);
  }
}
if (mapped) pass('funding failures map to pending-asp / insufficient / proof / relayer / anon-rpc / revert');

await chrome.storage.local.remove('truly:activeTrade');
console.log(failed ? '\nFAILED' : '\ntrade session guards OK');
process.exit(failed ? 1 : 0);
