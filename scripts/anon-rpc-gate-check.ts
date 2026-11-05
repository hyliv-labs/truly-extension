/**
 * E2's blocking requirement: with the anon-rpc harness unusable, no money may
 * move, and the user must be told why.
 *
 * Runs in its own process because config.ts reads the environment once at
 * module evaluation — the rotation check sets a specifier, this one must not.
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

// Deliberately unset.
delete process.env.WXT_ANON_RPC_SPECIFIER;

const { configProblems } = await import('../src/lib/config.ts');
const { createVault } = await import('../src/lib/vault.ts');
const { startTrade } = await import('../src/lib/trade.ts');

let failed = false;
const fail = (msg: string) => {
  console.error('FAIL', msg);
  failed = true;
};
const pass = (msg: string) => console.log('pass', msg);

const problems = configProblems();
if (problems.length === 0) {
  fail('no specifier set, yet configProblems() reported nothing');
} else {
  pass(`config problem reported: ${problems[0]!.key}`);
}

// The reason has to be human-readable: the popup shows this string verbatim.
if (!problems[0]?.reason || problems[0].reason.length < 20) {
  fail('problem has no usable reason string for the popup');
} else {
  pass('problem carries a reason the popup can show');
}

await createVault('pw', 'test test test test test test test test test test test junk');

try {
  await startTrade();
  fail('a trade STARTED while reads could not be anonymised');
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.includes('anon-rpc')) {
    fail(`refused, but not for the anon-rpc reason: ${message}`);
  } else {
    pass('startTrade refused while anon-rpc is unavailable');
  }
}

process.exitCode = failed ? 1 : 0;
