/**
 * Trade funding: choosing a note and an amount.
 *
 * Two floors pull in opposite directions and neither errors at the time it is
 * missed:
 *
 *  - Lighter rejects a deposit under 5 USDC. The relayer's fee comes out of
 *    the withdrawal, so what LANDS must clear it, not what was requested.
 *    Miss it and the funds sit at the intent address, uncredited.
 *  - The pool rejects a commitment under 5 USDC, so the remainder left behind
 *    must be zero or above that floor. Miss it and the remainder is stranded
 *    in the pool permanently.
 *
 * Offline; part of `pnpm check`.
 */

import { installChromeStub } from './chrome-stub.ts';

installChromeStub();

const { planUnshield, UnshieldError, LIGHTER_MIN_UNITS } = await import('../src/lib/unshield.ts');
const { POOL_MIN_DEPOSIT_UNITS, estimateRelayerFeeUnits } = await import('../src/lib/config.ts');

let failed = false;
const fail = (m: string) => {
  console.error('FAIL', m);
  failed = true;
};
const pass = (m: string) => console.log('pass', m);

const USDC = (n: number) => BigInt(Math.round(n * 1_000_000));
const note = (usdc: number, label = 1n) => ({
  label,
  value: USDC(usdc),
  nullifier: 7n,
  secret: 8n,
  commitmentHash: 9n,
  childrenCount: 0,
});

/** The invariant every accepted plan must satisfy. */
const assertPlanIsSafe = (plan: ReturnType<typeof planUnshield>, what: string) => {
  if (plan.expectedNetUnits < LIGHTER_MIN_UNITS) {
    fail(`${what}: would land ${plan.expectedNetUnits}, under Lighter's ${LIGHTER_MIN_UNITS}`);
  } else if (plan.remainderUnits !== 0n && plan.remainderUnits < POOL_MIN_DEPOSIT_UNITS) {
    fail(`${what}: would strand a ${plan.remainderUnits}-unit remainder in the pool`);
  } else if (plan.amountUnits > plan.note.value) {
    fail(`${what}: plans to withdraw more than the note holds`);
  } else {
    pass(`${what}: lands ${plan.expectedNetUnits}, leaves ${plan.remainderUnits}`);
  }
};

// --- no notes -------------------------------------------------------------
try {
  planUnshield([], USDC(25));
  fail('an empty note set produced a plan');
} catch (error) {
  if (error instanceof UnshieldError) pass('an empty note set is refused with a clear reason');
  else fail(`empty note set threw ${(error as Error).name}`);
}

// --- the ordinary case ----------------------------------------------------
assertPlanIsSafe(planUnshield([note(100)], USDC(25)), '100 USDC note, 25 wanted');

// --- THE STRANDING CASE ---------------------------------------------------
// A 28 USDC note with 25 wanted would leave 3 USDC — legal to withdraw, but
// below the pool minimum, so that 3 could never be re-shielded. The planner
// must take the whole note instead.
const tight = planUnshield([note(28)], USDC(25));
assertPlanIsSafe(tight, '28 USDC note, 25 wanted (would strand 3)');
if (!tight.spendsWholeNote) {
  fail('the planner left an unusable remainder instead of spending the note whole');
} else {
  pass('a would-be-stranded remainder causes the whole note to be spent');
}

// Exactly at the boundary: 30 USDC, 25 wanted -> 5 left, which IS usable.
const boundary = planUnshield([note(30)], USDC(25));
assertPlanIsSafe(boundary, '30 USDC note, 25 wanted (leaves exactly the minimum)');
if (boundary.spendsWholeNote) {
  fail('a usable 5 USDC remainder was needlessly consumed');
} else {
  pass('a remainder exactly at the pool minimum is kept, not consumed');
}

// --- THE LIGHTER FLOOR ----------------------------------------------------
// A note that cannot land 5 USDC after fees must be refused, not attempted.
try {
  const plan = planUnshield([note(5)], USDC(25));
  fail(
    `a 5 USDC note was accepted; it would land ${plan.expectedNetUnits}, under Lighter's minimum`,
  );
} catch (error) {
  if (error instanceof UnshieldError) {
    pass('a note too small to clear Lighter after fees is refused');
  } else {
    fail(`small note threw ${(error as Error).name}`);
  }
}

// --- note selection -------------------------------------------------------
// Given a choice, the largest note is used: it leaves the healthiest remainder
// and pays the lowest effective relayer rate.
const chosen = planUnshield([note(8, 1n), note(100, 2n), note(30, 3n)], USDC(25));
if (chosen.note.label !== 2n) {
  fail(`picked note ${chosen.note.label}, expected the largest (2)`);
} else {
  pass('the largest note is chosen');
}

// A set where only the big note works must still find it rather than give up
// on the first failure.
const salvaged = planUnshield([note(2, 1n), note(3, 2n), note(60, 3n)], USDC(25));
if (salvaged.note.label !== 3n) {
  fail('gave up before reaching the only viable note');
} else {
  pass('unusable notes are skipped rather than aborting the search');
}

// --- fees are actually subtracted ----------------------------------------
const big = planUnshield([note(100)], USDC(25));
if (big.expectedNetUnits >= big.amountUnits) {
  fail('the expected net is not below the gross — the relayer fee is not modelled');
} else {
  pass(
    `the fee is subtracted: ${big.amountUnits} gross -> ${big.expectedNetUnits} net ` +
      `(est. fee ${estimateRelayerFeeUnits(big.amountUnits)})`,
  );
}

// --- bad input ------------------------------------------------------------
for (const bad of [0n, -1n]) {
  try {
    planUnshield([note(100)], bad);
    fail(`a trade size of ${bad} was accepted`);
  } catch {
    pass(`a trade size of ${bad} is refused`);
  }
}

console.log(failed ? '\nFAILED' : '\nunshield planning OK');
process.exit(failed ? 1 : 0);
