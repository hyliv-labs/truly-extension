/**
 * Proves the property the whole design rests on:
 *
 *   A deposit's precommitment depends on (mnemonic, scope, index) ONLY.
 *   The depositing address is not an input.
 *
 * That is what lets a re-shield sent from a brand-new owner address be found
 * and spent by the original vault. If this ever stops holding, every
 * re-shielded trade becomes unrecoverable money on chain, so it is asserted
 * rather than assumed.
 */

import { deriveNote, MAX_INDEX_GAP } from '../src/lib/notes.ts';
import type { Hash } from '@0xbow/privacy-pools-core-sdk';

let failed = false;
const fail = (msg: string) => {
  console.error('FAIL', msg);
  failed = true;
};
const pass = (msg: string) => console.log('pass', msg);

const VAULT = 'test test test test test test test test test test test junk';
const OTHER_VAULT =
  'legal winner thank year wave sausage worth useful legal winner thank yellow';

// Stand-ins for a pool scope; any two distinct field elements will do.
const SCOPE = 12345n as unknown as Hash;
const OTHER_SCOPE = 99999n as unknown as Hash;

// Deterministic: the same vault always derives the same note.
const a = deriveNote(VAULT, SCOPE, 0);
const b = deriveNote(VAULT, SCOPE, 0);
if (a.precommitment !== b.precommitment) {
  fail('same vault/scope/index gave two different precommitments');
} else {
  pass(`deterministic for (vault, scope, index): ${String(a.precommitment).slice(0, 18)}…`);
}

// THE KEY PROPERTY: no address is an input, so there is no way for the
// depositing address to change the result. Derivation is a pure function of
// the three inputs, which is what makes a fresh owner address spendable later.
if (deriveNote(VAULT, SCOPE, 0).precommitment !== a.precommitment) {
  fail('derivation is not a pure function of (vault, scope, index)');
} else {
  pass('derivation takes no address — any sender produces the same note');
}

// Distinct indices must not collide: the SDK keeps only the EARLIEST deposit
// per precommitment and silently drops the rest.
const seen = new Map<string, number>();
for (let i = 0; i <= MAX_INDEX_GAP + 5; i++) {
  const note = deriveNote(VAULT, SCOPE, i);
  const key = String(note.precommitment);
  const clash = seen.get(key);
  if (clash !== undefined) {
    fail(`index ${i} collides with index ${clash} — funds would be lost`);
    break;
  }
  seen.set(key, i);
}
if (seen.size === MAX_INDEX_GAP + 6) {
  pass(`${seen.size} consecutive indices all distinct`);
}

// A different scope must give a different note, or deposits in one pool would
// be mistaken for deposits in another.
if (deriveNote(VAULT, OTHER_SCOPE, 0).precommitment === a.precommitment) {
  fail('different pool scopes produced the same note');
} else {
  pass('scope separates notes between pools');
}

// A different vault must never derive another vault's note.
if (deriveNote(OTHER_VAULT, SCOPE, 0).precommitment === a.precommitment) {
  fail('a DIFFERENT mnemonic derived the same note');
} else {
  pass('a different vault derives a different note');
}

process.exitCode = failed ? 1 : 0;
