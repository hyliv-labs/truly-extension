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

// --- the double-funding guard --------------------------------------------
// The hazard: a withdrawal is broadcast, then the worker is torn down or the
// receipt read fails. If no record exists, the phase falls back to
// 'unshielding', the button goes live, and a second click sends a SECOND
// payment to the same intent address -- untracked, and linking two pool
// withdrawals to one Lighter identity.
const { getTradeStatus } = await import('../src/lib/orchestrator.ts');

const baseTrade = {
  ownerIndex: 0,
  ownerAddress: '0x000000000000000000000000000000000000dEaD',
  startedAt: Date.now(),
  intentAddress: '0x000000000000000000000000000000000000bEEF',
};

const setTrade = async (withdrawal: unknown) => {
  await chrome.storage.local.set({
    'truly:activeTrade': { ...baseTrade, ...(withdrawal ? { withdrawal } : {}) },
  });
};

await setTrade(null);
const unfunded = await getTradeStatus();
if (unfunded?.phase !== 'unshielding') {
  fail(`an unfunded trade reported phase '${unfunded?.phase}', expected 'unshielding'`);
} else {
  pass('an unfunded trade is ready to fund');
}

// A pending record with a hash: in flight, must not invite a second payment.
await setTrade({
  status: 'pending',
  txHash: `0x${'cd'.repeat(32)}`,
  label: '42',
  amount: '25000000',
  childrenCountAtStart: 0,
  startedAt: Date.now(),
});
const pending = await getTradeStatus();
if (!pending?.detail.toLowerCase().includes('confirm')) {
  fail(
    `a pending withdrawal reads as "${pending?.detail}" — it must not read as ready to fund`,
  );
} else {
  pass('a broadcast-but-unconfirmed withdrawal reads as in-flight, not as ready to fund');
}

// A pending record with NO hash: outcome unknown, still must not invite one.
await setTrade({
  status: 'pending',
  label: '42',
  amount: '25000000',
  childrenCountAtStart: 0,
  startedAt: Date.now(),
});
const unknown = await getTradeStatus();
if (unknown?.detail.toLowerCase().includes('ready to fund')) {
  fail('a withdrawal of unknown outcome reads as ready to fund — this is the double-send');
} else {
  pass('a withdrawal of unknown outcome does not read as ready to fund');
}

// The decisive refusal: a CONFIRMED record must stop a second funding before
// any network call happens.
const { unshieldForTrade } = await import('../src/lib/unshield.ts');
await setTrade({
  status: 'confirmed',
  txHash: `0x${'ef'.repeat(32)}`,
  label: '42',
  amount: '25000000',
  childrenCountAtStart: 0,
  startedAt: Date.now(),
  confirmedAt: Date.now(),
});
try {
  await unshieldForTrade();
  fail('a confirmed trade was funded a SECOND time');
} catch (error) {
  if (error instanceof UnshieldError && /already been funded/i.test(error.message)) {
    pass('a confirmed trade refuses a second funding, before any network call');
  } else {
    fail(`second funding threw the wrong error: ${(error as Error).message.slice(0, 80)}`);
  }
}

// And with no intent address, funding must refuse rather than pick a
// recipient: the recipient is committed to inside the proof's context.
await chrome.storage.local.set({
  'truly:activeTrade': { ...baseTrade, intentAddress: undefined },
});
try {
  await unshieldForTrade();
  fail('funding proceeded without a Lighter deposit address');
} catch (error) {
  if (error instanceof UnshieldError) {
    pass('funding without a deposit address is refused');
  } else {
    fail(`missing-intent threw ${(error as Error).name}`);
  }
}

await chrome.storage.local.remove('truly:activeTrade');

console.log(failed ? '\nFAILED' : '\nunshield planning OK');
process.exit(failed ? 1 : 0);
