/**
 * When a trade may be retired.
 *
 * Retiring burns the owner index, so getting this wrong strands money at an
 * address the UI has stopped showing. Two opposite failures matter equally:
 *
 *  - retiring too early, while a withdrawal is still in flight
 *  - never being able to retire, because a successful re-shield always leaves
 *    the unspent gas allowance behind
 */

import { installChromeStub } from './chrome-stub.ts';

installChromeStub();

process.env.WXT_ANON_RPC_SPECIFIER = '0x00000000000000000000000000000000000000a1';
process.env.WXT_PRIVACY_POOL_ENTRYPOINT = '0x00000000000000000000000000000000000000e1';
process.env.WXT_PRIVACY_POOL_ADDRESS = '0x00000000000000000000000000000000000000b1';
process.env.WXT_PRIVACY_POOL_RELAYER_URL = 'https://relayer.example';

const orchestrator = await import('../src/lib/orchestrator.ts');
const { getActiveTrade } = await import('../src/lib/trade.ts');

let failed = false;
const fail = (msg: string) => {
  console.error('FAIL', msg);
  failed = true;
};
const pass = (msg: string) => console.log('pass', msg);

/**
 * decideRetirable is the rule with the world-reading removed, so these cases
 * run without Lighter or a chain.
 */
type Status = Parameters<typeof orchestrator.decideRetirable>[0];
let current: Status = null;
const withStatus = (status: Status) => {
  current = status;
};
const canRetire = async () => orchestrator.decideRetirable(current);

const PERMIT_RESERVE = 1_000_000n;

// No trade at all.
withStatus(null);
if ((await canRetire()).ok) fail('retired with no active trade');
else pass('no active trade -> not retirable');

// Mid-deposit: the money has not even arrived.
withStatus({ phase: 'waiting-for-deposit', detail: 'Waiting for Lighter.' });
if ((await canRetire()).ok) fail('retired while waiting for the deposit');
else pass('waiting for deposit -> not retirable');

// A position is still open.
withStatus({ phase: 'trading', detail: 'Position open.' });
if ((await canRetire()).ok) fail('retired with a position open');
else pass('position open -> not retirable');

// THE DANGEROUS ONE. Lighter reads zero the moment a fast withdrawal is
// requested, before the USDC lands at the owner address. Both balances are
// zero and nothing has been re-shielded — retiring here strands the incoming
// funds at a burned index.
withStatus({
  phase: 'exiting',
  detail: 'Lighter is empty but nothing has reached the owner address yet.',
  ownerBalance: 0n,
});
if ((await canRetire()).ok) {
  fail('retired mid-withdrawal, with both balances zero and no re-shield');
} else {
  pass('withdrawal in flight (both balances zero) -> not retirable');
}

// Re-shielded, but a real balance remains — something is genuinely stranded.
withStatus({
  phase: 'reshielded',
  detail: 'Back in the pool.',
  ownerBalance: 5_000_000n,
});
if ((await canRetire()).ok) {
  fail('retired while 5 USDC was still at the owner address');
} else {
  pass('5 USDC left at the owner -> not retirable');
}

// THE DEADLOCK. A successful re-shield leaves the unspent part of the 1 USDC
// gas permit behind, so the owner is never exactly empty. Requiring zero would
// make every trade permanently unretirable.
withStatus({
  phase: 'reshielded',
  detail: 'Back in the pool.',
  ownerBalance: PERMIT_RESERVE - 50_000n, // ~0.95 USDC of unspent gas
});
const afterReshield = await canRetire();
if (!afterReshield.ok) {
  fail(`leftover gas blocked retirement: ${afterReshield.reason}`);
} else {
  pass('leftover gas allowance after a re-shield -> retirable');
}

// Exactly empty is fine too.
withStatus({ phase: 'reshielded', detail: 'Back in the pool.', ownerBalance: 0n });
if (!(await canRetire()).ok) fail('a fully empty owner was not retirable');
else pass('empty owner after re-shield -> retirable');

if (await getActiveTrade()) fail('the stub leaked an active trade');
else pass('no trade state was mutated by these checks');

process.exitCode = failed ? 1 : 0;
