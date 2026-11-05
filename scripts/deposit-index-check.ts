/**
 * Deposit-index allocation under success and failure.
 *
 * Both failure modes lose money silently:
 *  - advancing on a FAILED attempt punches a hole; ten holes and every later
 *    deposit is invisible to the scan (MAX_CONSECUTIVE_MISSES = 10)
 *  - reusing a CONFIRMED index collides; the SDK keeps only the earliest
 *    deposit per precommitment and drops the rest
 *
 * Neither raises an error at the time, so both are asserted here.
 */

type Store = Record<string, unknown>;

function makeArea(store: Store) {
  return {
    async get(key: string) {
      return key in store ? { [key]: store[key] } : {};
    },
    async set(items: Store) {
      Object.assign(store, items);
    },
    async remove(key: string) {
      delete store[key];
    },
    async clear() {
      for (const k of Object.keys(store)) delete store[k];
    },
  };
}

(globalThis as Record<string, unknown>).chrome = {
  storage: { local: makeArea({}), session: makeArea({}) },
};

const { nextDepositIndex, confirmDepositIndex, getDepositIndex, MAX_INDEX_GAP } =
  await import('../src/lib/notes.ts');

let failed = false;
const fail = (msg: string) => {
  console.error('FAIL', msg);
  failed = true;
};
const pass = (msg: string) => console.log('pass', msg);

// A fresh vault starts at 0.
if ((await nextDepositIndex()) !== 0) fail('first deposit should use index 0');
else pass('first deposit uses index 0');

// FAILURE: asking again without confirming must return the SAME index. Nothing
// with that precommitment reached the chain, so reuse leaves no gap.
await nextDepositIndex();
await nextDepositIndex();
if ((await nextDepositIndex()) !== 0) {
  fail('index advanced on a failed attempt — that would punch a hole');
} else {
  pass('a failed attempt reuses its index, leaving no gap');
}

// SUCCESS: confirming advances exactly one.
await confirmDepositIndex(0);
if ((await nextDepositIndex()) !== 1) {
  fail(`after confirming 0, next should be 1, got ${await nextDepositIndex()}`);
} else {
  pass('a confirmed deposit advances the index by one');
}

// A repeated confirmation must not skip ahead; retries and late callbacks are
// normal and must be harmless.
await confirmDepositIndex(0);
await confirmDepositIndex(0);
if ((await nextDepositIndex()) !== 1) {
  fail('repeated confirmation of the same index moved it');
} else {
  pass('confirming the same index twice is idempotent');
}

// Monotonic: a late confirmation for an older index must never move it back,
// which would hand out a confirmed index again.
await confirmDepositIndex(5);
await confirmDepositIndex(2);
if ((await getDepositIndex()) !== 6) {
  fail(`index moved backwards: ${await getDepositIndex()}`);
} else {
  pass('a stale confirmation cannot move the index backwards');
}

// The whole point: a run of confirmed deposits stays dense, never approaching
// the scan's miss tolerance.
const used: number[] = [];
for (let i = 0; i < 12; i++) {
  const index = await nextDepositIndex();
  used.push(index);
  await confirmDepositIndex(index);
}
const gaps = used.slice(1).map((v, i) => v - used[i]!);
if (gaps.some((g) => g !== 1)) {
  fail(`indices were not consecutive: ${used.join(', ')}`);
} else {
  pass(`12 confirmed deposits stay consecutive (gap 1, tolerance ${MAX_INDEX_GAP})`);
}

if (new Set(used).size !== used.length) {
  fail('an index was handed out twice — deposits would collide');
} else {
  pass('no index was handed out twice');
}

process.exitCode = failed ? 1 : 0;
