/**
 * E3 withdrawal: sizing guard and retry policy.
 *
 * Both failures here lose money quietly:
 *  - a withdrawal that leaves a remainder below the pool minimum strands that
 *    remainder: it can be neither re-shielded nor economically withdrawn, and
 *    nothing errors at the time
 *  - retrying a NON-race failure (a rejected proof, an unapproved label) burns
 *    quotes and proving time and can advance state that should not move
 *
 * Offline: no network, no proving. Asserts the decision logic.
 */

import { installChromeStub } from './chrome-stub.ts';

installChromeStub();

const { checkSizing, WithdrawError } = await import('../src/lib/withdraw.ts');
const { POOL_MIN_DEPOSIT_UNITS, estimateRelayerFeeUnits } = await import('../src/lib/config.ts');
const { isRetryableRevert, RelayerError } = await import('../src/lib/relayer.ts');
const { quoteStillUsable, quoteTimeRemainingMs } = await import('../src/lib/relayer.ts');

let failed = false;
const fail = (m: string) => {
  console.error('FAIL', m);
  failed = true;
};
const pass = (m: string) => console.log('pass', m);

const USDC = (n: number) => BigInt(Math.round(n * 1_000_000));

const note = (valueUsdc: number) => ({
  label: 42n,
  value: USDC(valueUsdc),
  nullifier: 1n as never,
  secret: 2n as never,
  commitmentHash: 3n,
  childrenCount: 0,
});

const expectReject = (fn: () => void, what: string) => {
  try {
    fn();
    fail(`${what} was ACCEPTED`);
  } catch (error) {
    if (error instanceof WithdrawError) pass(`${what} is rejected`);
    else fail(`${what} threw the wrong error: ${(error as Error).name}`);
  }
};

// --- sizing ---------------------------------------------------------------
expectReject(() => checkSizing(note(100), 0n), 'a zero withdrawal');
expectReject(() => checkSizing(note(100), -1n), 'a negative withdrawal');
expectReject(() => checkSizing(note(10), USDC(11)), 'withdrawing more than the note holds');

// THE STRANDING CASE: 100 USDC note, withdraw 97 -> 3 USDC left, below the
// 5 USDC pool minimum. That remainder can never be re-shielded.
expectReject(
  () => checkSizing(note(100), USDC(97)),
  'a withdrawal leaving 3 USDC (below the pool minimum)',
);

// Exactly at the minimum is fine.
try {
  checkSizing(note(100), USDC(95));
  pass('a withdrawal leaving exactly the pool minimum is allowed');
} catch (error) {
  fail(`leaving exactly the minimum was rejected: ${(error as Error).message}`);
}

// Spending the note entirely strands nothing.
try {
  checkSizing(note(100), USDC(100));
  pass('fully spending the note is allowed (no remainder to strand)');
} catch (error) {
  fail(`a full spend was rejected: ${(error as Error).message}`);
}

// A withdrawal the fee would eat.
const tiny = estimateRelayerFeeUnits(1000n);
if (tiny < 1000n) {
  fail('the fee estimate is implausibly small; the fee-consumes-withdrawal guard is untestable');
} else {
  expectReject(() => checkSizing(note(100), 1000n), 'a withdrawal the relayer fee would consume');
}

console.log(`  (pool minimum is ${POOL_MIN_DEPOSIT_UNITS} units)`);

// --- retry policy ---------------------------------------------------------
if (!isRetryableRevert('execution reverted: IncorrectASPRoot')) {
  fail('IncorrectASPRoot is not treated as retryable — a mid-flight ASP publish would abort');
} else {
  pass('IncorrectASPRoot is retryable (the ASP published mid-flight)');
}
if (isRetryableRevert('execution reverted: ContextMismatch')) {
  fail('ContextMismatch is treated as retryable — retrying cannot fix a rebuilt withdrawal struct');
} else {
  pass('ContextMismatch is NOT retryable');
}
if (isRetryableRevert('execution reverted: InvalidProof')) {
  fail('InvalidProof is treated as retryable');
} else {
  pass('InvalidProof is NOT retryable');
}

const transient = new RelayerError('CowSwap quote error', true);
const terminal = new RelayerError('bad proof', false);
if (!transient.retryable || terminal.retryable) {
  fail('RelayerError does not carry its retryable flag correctly');
} else {
  pass('RelayerError distinguishes transient from terminal');
}

// --- quote window ---------------------------------------------------------
const quoteWith = (ms: number) =>
  ({ feeCommitment: { expiration: Date.now() + ms } }) as never;

if (quoteStillUsable(quoteWith(5_000))) {
  fail('a quote with 5s left was called usable — proving would outlive it');
} else {
  pass('a nearly-expired quote is refused before proving is paid for');
}
if (!quoteStillUsable(quoteWith(55_000))) {
  fail('a fresh 55s quote was refused');
} else {
  pass('a fresh quote is usable');
}
if (quoteTimeRemainingMs(quoteWith(-1_000)) > 0) {
  fail('an expired quote reported positive time remaining');
} else {
  pass('an expired quote reports negative time remaining');
}

// --- tx hash extraction ---------------------------------------------------
const { extractTxHash } = await import('../src/lib/relayer.ts');
const HASH = `0x${'ab'.repeat(32)}`;

for (const shape of [
  { txHash: HASH },
  { hash: HASH },
  { transactionHash: HASH },
  { data: { txHash: HASH } },
  { result: { txHash: HASH } },
]) {
  if (extractTxHash(shape) !== HASH) {
    fail(`extractTxHash missed the hash in ${JSON.stringify(shape).slice(0, 40)}`);
  }
}
pass('extractTxHash finds the hash across the plausible response shapes');

// A hash must be VALIDATED, not trusted by name: recording a bogus one would
// mean waiting for a receipt that never arrives.
for (const bad of [{ txHash: 'pending' }, { txHash: '0x1234' }, { txHash: 42 }, {}, null, 'ok']) {
  if (extractTxHash(bad) !== undefined) {
    fail(`extractTxHash accepted ${JSON.stringify(bad)} as a transaction hash`);
  }
}
pass('a malformed or absent hash yields undefined rather than a bogus value');

console.log(failed ? '\nFAILED' : '\nwithdraw sizing and retry policy OK');
process.exit(failed ? 1 : 0);
