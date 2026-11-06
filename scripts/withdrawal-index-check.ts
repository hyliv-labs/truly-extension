/**
 * Withdrawal-index allocation, per label.
 *
 * A change note's secrets come from generateWithdrawalSecrets(keys, label,
 * index). Reuse an index under a label and the change note carries a nullifier
 * already in the pool's spent set -- the withdrawal that tries to spend it
 * reverts permanently and those funds are unreachable. Nothing errors at the
 * time the duplicate is created.
 *
 * Indices are also PER LABEL: two labels at index 0 is correct and must not be
 * mistaken for a collision.
 *
 * Offline; part of `pnpm check`.
 */

import { installChromeStub } from './chrome-stub.ts';

installChromeStub();

const {
  nextWithdrawalIndex,
  confirmWithdrawalIndex,
  getWithdrawalIndex,
  deriveChangeNote,
} = await import('../src/lib/notes.ts');

let failed = false;
const fail = (m: string) => {
  console.error('FAIL', m);
  failed = true;
};
const pass = (m: string) => console.log('pass', m);

const LABEL_A = 42n;
const LABEL_B = 99n;
const PHRASE = 'test test test test test test test test test test test junk';

// A fresh label starts at 0.
if ((await nextWithdrawalIndex(LABEL_A)) !== 0) {
  fail('a label with no withdrawals did not start at index 0');
} else {
  pass('a fresh label starts at index 0');
}

// Allocation must NOT advance: a withdrawal that never lands consumed nothing.
await nextWithdrawalIndex(LABEL_A);
if ((await nextWithdrawalIndex(LABEL_A)) !== 0) {
  fail('allocating advanced the index — a failed withdrawal would burn one');
} else {
  pass('allocating does not advance; a failed withdrawal reuses its index');
}

// Confirmation advances it.
await confirmWithdrawalIndex(LABEL_A, 0);
if ((await nextWithdrawalIndex(LABEL_A)) !== 1) {
  fail('confirming did not advance the index — the next withdrawal would reuse it');
} else {
  pass('confirming advances the index');
}

// THE COLLISION GUARD: a late or duplicated confirmation must not rewind.
await confirmWithdrawalIndex(LABEL_A, 0);
if ((await getWithdrawalIndex(LABEL_A)) !== 1) {
  fail('a repeated confirmation moved the index BACKWARDS — the next change note would collide');
} else {
  pass('a repeated confirmation cannot move the index backwards');
}

await confirmWithdrawalIndex(LABEL_A, 5);
await confirmWithdrawalIndex(LABEL_A, 2);
if ((await getWithdrawalIndex(LABEL_A)) !== 6) {
  fail(`an out-of-order confirmation rewound the index to ${await getWithdrawalIndex(LABEL_A)}`);
} else {
  pass('out-of-order confirmations keep the maximum');
}

// Indices are per label, not global.
if ((await nextWithdrawalIndex(LABEL_B)) !== 0) {
  fail('a second label inherited the first label\'s index — indices are not isolated');
} else {
  pass('a second label is independent, still at index 0');
}

// Derivation: same inputs give the same secrets, different indices do not.
const n0 = deriveChangeNote(PHRASE, LABEL_A, 0);
const n0again = deriveChangeNote(PHRASE, LABEL_A, 0);
const n1 = deriveChangeNote(PHRASE, LABEL_A, 1);
const b0 = deriveChangeNote(PHRASE, LABEL_B, 0);

if (String(n0.nullifier) !== String(n0again.nullifier)) {
  fail('derivation is not deterministic — a change note could not be respent');
} else {
  pass('derivation is deterministic for the same (label, index)');
}
if (String(n0.nullifier) === String(n1.nullifier)) {
  fail('indices 0 and 1 derive the SAME nullifier — reuse would be undetectable');
} else {
  pass('different indices derive different nullifiers');
}
if (String(n0.nullifier) === String(b0.nullifier)) {
  fail('different labels at index 0 derive the same nullifier');
} else {
  pass('different labels at index 0 derive different nullifiers');
}

for (const bad of [-1, 1.5, Number.NaN]) {
  try {
    deriveChangeNote(PHRASE, LABEL_A, bad);
    fail(`deriveChangeNote accepted an invalid index ${bad}`);
  } catch {
    pass(`deriveChangeNote rejects ${bad}`);
  }
}

console.log(failed ? '\nFAILED' : '\nwithdrawal index allocation OK');
process.exit(failed ? 1 : 0);
