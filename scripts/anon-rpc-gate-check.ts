/**
 * E2's blocking requirement: with the anon-rpc harness unusable, no money may
 * move, and the user must be told why.
 *
 * Runs in its own process because config.ts reads the environment once at
 * module evaluation — the rotation check sets a specifier, this one must not.
 */

import { installChromeStub } from './chrome-stub.ts';

installChromeStub();


// Deliberately unset: this script exists to prove the gate closes.
delete process.env.WXT_ANON_RPC_SPECIFIER;
delete process.env.WXT_PRIVACY_POOL_ENTRYPOINT;
delete process.env.WXT_PRIVACY_POOL_ADDRESS;
delete process.env.WXT_PRIVACY_POOL_RELAYER_URL;

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
  fail('nothing configured, yet configProblems() reported nothing');
} else {
  pass(`config problems reported: ${problems.map((p) => p.key).join(', ')}`);
}

// Each unknown must be named separately: "something is missing" does not tell
// the user which booth to visit.
// The specifier is deliberately NOT here: it now has a working default
// (tor-js), so it is no longer something the user must supply.
for (const key of ['WXT_PRIVACY_POOL_ENTRYPOINT', 'WXT_PRIVACY_POOL_RELAYER_URL']) {
  if (!problems.some((p) => p.key === key)) fail(`${key} was not reported`);
  else pass(`${key} reported`);
}

// The reason has to be human-readable: the popup shows this string verbatim.
if (!problems[0]?.reason || problems[0].reason.length < 20) {
  fail('problem has no usable reason string for the popup');
} else {
  pass('problem carries a reason the popup can show');
}

await createVault('test-password', 'test test test test test test test test test test test junk');

try {
  await startTrade();
  fail('a trade STARTED while reads could not be anonymised');
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.includes('Privacy Pools')) {
    fail(`refused, but not for the expected reason: ${message}`);
  } else {
    pass('startTrade refused while the pool is unconfigured');
  }
}

process.exitCode = failed ? 1 : 0;
