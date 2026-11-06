/**
 * The relayer fee estimator, pinned against the live curve.
 *
 * The fee looked like a flat 10 BPS from /relayer/details, and was hardcoded
 * that way. /relayer/quote shows it is 10 BPS PLUS the relay transaction's
 * gas, which is fixed -- so at the 5 USDC pool floor the real rate is 68 BPS,
 * nearly 7x the assumed one.
 *
 * Under-reserving here strands funds: a withdrawal sized against 10 BPS leaves
 * a remainder below the pool minimum, which cannot then be re-shielded. So the
 * estimator must be conservative at EVERY size, and this asserts it against
 * the measured values rather than trusting the formula.
 *
 * Offline; part of `pnpm check`.
 */

import { installChromeStub } from './chrome-stub.ts';

installChromeStub();

const { estimateRelayerFeeUnits, RELAYER_BASE_FEE_BPS, POOL_MIN_DEPOSIT_UNITS } = await import(
  '../src/lib/config.ts'
);

let failed = false;
const fail = (m: string) => {
  console.error('FAIL', m);
  failed = true;
};
const pass = (m: string) => console.log('pass', m);

const USDC = (n: number) => BigInt(Math.round(n * 1_000_000));

/** Measured from fastrelay.xyz on Arbitrum; see scripts/relayer-quote-check.ts. */
const MEASURED: Array<[usdc: number, bps: number]> = [
  [5, 68],
  [10, 39],
  [25, 21],
  [50, 15],
  [100, 12],
  [250, 11],
];

for (const [usdc, bps] of MEASURED) {
  const actual = (USDC(usdc) * BigInt(bps)) / 10_000n;
  const estimate = estimateRelayerFeeUnits(USDC(usdc));
  if (estimate < actual) {
    fail(
      `at ${usdc} USDC the estimate ${estimate} is BELOW the measured ${actual} — ` +
        'a withdrawal sized on it would leave less than planned',
    );
  } else {
    pass(`${usdc} USDC: estimate ${estimate} >= measured ${actual}`);
  }
}

// The estimator must not be so conservative it refuses everything either.
const atFloor = estimateRelayerFeeUnits(POOL_MIN_DEPOSIT_UNITS);
if (atFloor > POOL_MIN_DEPOSIT_UNITS / 10n) {
  fail(`estimate at the pool floor is ${atFloor}, over 10% — that is too pessimistic`);
} else {
  pass(`estimate at the ${POOL_MIN_DEPOSIT_UNITS} floor is ${atFloor}, under 10%`);
}

// The fixed component must dominate at small sizes; that is the whole point.
const smallRate = (estimateRelayerFeeUnits(USDC(5)) * 10_000n) / USDC(5);
const largeRate = (estimateRelayerFeeUnits(USDC(250)) * 10_000n) / USDC(250);
if (smallRate <= largeRate) {
  fail('the estimator is flat — it has not modelled the fixed gas cost');
} else {
  pass(`estimator rate falls with size: ${smallRate} BPS at 5 USDC -> ${largeRate} at 250`);
}

if (largeRate < RELAYER_BASE_FEE_BPS) {
  fail(`estimate at 250 USDC is ${largeRate} BPS, below the ${RELAYER_BASE_FEE_BPS} BPS base`);
} else {
  pass(`estimate never falls below the ${RELAYER_BASE_FEE_BPS} BPS base rate`);
}

console.log(failed ? '\nFAILED' : '\nrelayer fee estimator OK');
process.exit(failed ? 1 : 0);
