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
  getWithdrawalFloor,
  deriveChangeNote,
  StaleScanError,
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

// THE AUTHORITY IS THE CHAIN. The SDK derives the index as
// account.children.length, both when creating secrets and when replaying
// Withdrawn events during recovery. So the index must follow that count.
if ((await nextWithdrawalIndex(LABEL_A, 0)) !== 0) {
  fail('a label with no change notes did not yield index 0');
} else {
  pass('a label with no change notes yields index 0');
}
if ((await nextWithdrawalIndex(LABEL_A, 3)) !== 3) {
  fail('the index did not follow the on-chain children count');
} else {
  pass('the index follows the on-chain children count');
}

// THE RECOVERY CASE that a local counter would get wrong. Storage is empty
// after MetaMask recovery or a reinstall, so a local counter reads 0 -- but
// the chain has two change notes. Index 0 would reuse a spent nullifier.
if ((await nextWithdrawalIndex(LABEL_B, 2)) !== 2) {
  fail('a recovered vault with an empty store did not follow the chain — index would collide');
} else {
  pass('a recovered vault with an EMPTY store still yields index 2, not 0');
}

// Allocation must not advance anything: a withdrawal that never lands has
// consumed no index, and the chain count is unchanged either way.
await nextWithdrawalIndex(LABEL_A, 3);
if ((await nextWithdrawalIndex(LABEL_A, 3)) !== 3) {
  fail('allocating twice changed the answer — a failed withdrawal would burn an index');
} else {
  pass('allocating does not advance; a failed withdrawal reuses its index');
}

// The local floor catches the OPPOSITE failure: a scan that has not yet seen
// a withdrawal we know confirmed. Deriving against the lower count would
// reuse a spent nullifier.
await confirmWithdrawalIndex(LABEL_A, 2); // floor becomes 3
if ((await getWithdrawalFloor(LABEL_A)) !== 3) {
  fail('confirming did not raise the local floor');
} else {
  pass('confirming raises the local floor');
}
try {
  await nextWithdrawalIndex(LABEL_A, 1);
  fail('a STALE scan (1 child, floor 3) was accepted — the change note would be stranded');
} catch (error) {
  if (error instanceof StaleScanError) {
    pass('a stale scan is refused with StaleScanError rather than silently reusing an index');
  } else {
    fail(`stale scan threw the wrong error: ${(error as Error).name}`);
  }
}
if ((await nextWithdrawalIndex(LABEL_A, 3)) !== 3) {
  fail('a scan that matches the floor was wrongly refused');
} else {
  pass('a scan that has caught up with the floor is accepted');
}

// The floor is monotonic, so a late confirmation cannot lower it and let a
// stale scan through.
await confirmWithdrawalIndex(LABEL_A, 0);
if ((await getWithdrawalFloor(LABEL_A)) !== 3) {
  fail('a repeated confirmation lowered the floor');
} else {
  pass('a repeated confirmation cannot lower the floor');
}

// Floors are per label, not global.
if ((await getWithdrawalFloor(999n)) !== 0) {
  fail('an untouched label inherited another label\'s floor');
} else {
  pass('floors are per label, not global');
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
    await nextWithdrawalIndex(LABEL_A, bad);
    fail(`nextWithdrawalIndex accepted an invalid children count ${bad}`);
  } catch {
    pass(`nextWithdrawalIndex rejects a children count of ${bad}`);
  }
  try {
    deriveChangeNote(PHRASE, LABEL_A, bad);
    fail(`deriveChangeNote accepted an invalid index ${bad}`);
  } catch {
    pass(`deriveChangeNote rejects ${bad}`);
  }
}

console.log(failed ? '\nFAILED' : '\nwithdrawal index allocation OK');
process.exit(failed ? 1 : 0);
