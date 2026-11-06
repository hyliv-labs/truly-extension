/**
 * Exit thresholds.
 *
 * Getting these wrong is expensive in a specific way: advising a fast
 * withdrawal on a balance that cannot cover the fee strands the money
 * mid-withdrawal, and advising a withdrawal while a position is open closes a
 * trade that is still running.
 */

import { adviseExit, fastWithdrawAmount, fastWithdrawUnits, isExitComplete, DUST_USDC } from '../src/lib/exit.ts';

let failed = false;
const fail = (msg: string) => {
  console.error('FAIL', msg);
  failed = true;
};
const pass = (msg: string) => console.log('pass', msg);

const snap = (over: Partial<Parameters<typeof adviseExit>[0]> = {}) => ({
  accountIndex: 1,
  balance: 0,
  positions: 0,
  openOrders: 0,
  ...over,
});

// No account yet: nothing to exit.
if (adviseExit(snap({ accountIndex: null })).kind !== 'not-funded') {
  fail('an account that does not exist should be not-funded');
} else pass('no account -> not-funded');

// An open position must take priority over any balance advice. Telling the
// user to withdraw here would close a live trade.
const live = adviseExit(snap({ balance: 50, positions: 1 }));
if (live.kind !== 'has-positions') {
  fail(`open position gave '${live.kind}', expected has-positions`);
} else pass('an open position blocks withdrawal advice');

// Comfortably above the minimum: fast.
if (adviseExit(snap({ balance: 25 })).kind !== 'withdraw-fast') {
  fail('25 USDC should be a fast withdrawal');
} else pass('25 USDC -> fast withdrawal');

// Right at the documented 4 USDC minimum, the $1 fee may sit on top, so fast
// is unsafe. This is the boundary that strands money if it is wrong.
const atMinimum = adviseExit(snap({ balance: 4 }));
if (atMinimum.kind !== 'withdraw-secure') {
  fail(`4 USDC gave '${atMinimum.kind}'; the undocumented fee may not fit`);
} else pass('4 USDC -> secure, since the fee may not fit');

// 5 USDC covers the minimum plus the fee.
if (adviseExit(snap({ balance: 5 })).kind !== 'withdraw-fast') {
  fail('5 USDC should cover the minimum plus the fee');
} else pass('5 USDC -> fast withdrawal');

// Dust is written off rather than chased.
const dust = adviseExit(snap({ balance: DUST_USDC / 2 }));
if (dust.kind !== 'dust') {
  fail(`${DUST_USDC / 2} USDC gave '${dust.kind}', expected dust`);
} else pass('sub-dust balance -> write off');

if (adviseExit(snap({ balance: 0 })).kind !== 'empty') {
  fail('a zero balance should be empty');
} else pass('zero balance -> empty');

// Only empty and dust end a trade; everything else needs action.
if (!isExitComplete(adviseExit(snap({ balance: 0 })))) {
  fail('empty should complete the exit');
} else if (!isExitComplete(dust)) {
  fail('dust should complete the exit');
} else if (isExitComplete(adviseExit(snap({ balance: 25 })))) {
  fail('a withdrawable balance must NOT complete the exit');
} else {
  pass('only empty and dust complete the exit');
}

if (fastWithdrawUnits('25.5') !== 24_500_000n) fail(`25.5 USDC withdrew ${fastWithdrawUnits('25.5')}`);
else pass('25.50 USDC withdraws 24.50, leaving 1 USDC for the fee');

if (fastWithdrawUnits('5') !== 4_000_000n) fail('5 USDC should withdraw exactly the 4 USDC minimum');
else pass('5 USDC withdraws 4 USDC');

if (fastWithdrawUnits('4.99') !== null) fail('4.99 USDC must not be a fast withdrawal');
else pass('below 5 USDC signs nothing');

if (fastWithdrawUnits('nope') !== null) fail('a non-numeric balance must not be withdrawn');
else pass('a non-numeric balance signs nothing');

if (fastWithdrawAmount('4', 0n) !== 4_000_000n) fail('a 4 USDC balance with no fee should withdraw 4');
else pass('a quoted fee of 0 withdraws the 4 USDC minimum');

if (fastWithdrawAmount('5', 2_000_000n) !== null) fail('a 2 USDC fee on 5 USDC would leave less than the minimum');
else pass('a fee that drops the payout under 4 USDC signs nothing');

process.exitCode = failed ? 1 : 0;
