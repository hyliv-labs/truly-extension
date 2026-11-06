/**
 * A blank env value must mean "unset", not "empty string".
 *
 * .env.example leaves keys blank to mean "use the default", but `??` only
 * falls back on undefined. A blank WXT_ANON_RPC_SPECIFIER= therefore became a
 * real empty address, the anon-rpc harness read the specifier contract at '',
 * and EVERY chain read failed with:
 *
 *   invalid argument 0: hex string has length 0, want 40 for common.Address
 *
 * which names neither the variable nor the file. Downstream it surfaced as
 * "the pool does not answer the Privacy Pools v1 interface" -- untrue, and
 * pointing at entirely the wrong component.
 *
 * Offline; part of `pnpm check`.
 */

import { installChromeStub } from './chrome-stub.ts';

installChromeStub();

let failed = false;
const fail = (m: string) => {
  console.error('FAIL', m);
  failed = true;
};
const pass = (m: string) => console.log('pass', m);

// Set BEFORE importing config, which reads env at module scope.
process.env.WXT_ANON_RPC_SPECIFIER = '';
process.env.WXT_BUNDLER_URL = '   ';
process.env.WXT_ARBITRUM_RPC_URL = '';

const { ANON_RPC_SPECIFIER, BUNDLER_URL, ARBITRUM_RPC_URL } = await import('../src/lib/config.ts');

const isAddress = (v: string) => /^0x[0-9a-fA-F]{40}$/.test(v);

if (!isAddress(ANON_RPC_SPECIFIER)) {
  fail(
    `a blank WXT_ANON_RPC_SPECIFIER produced ${JSON.stringify(ANON_RPC_SPECIFIER)}; ` +
      'the harness would read the specifier contract at an empty address',
  );
} else {
  pass(`a blank specifier falls back to the tor-js default (${ANON_RPC_SPECIFIER.slice(0, 10)}…)`);
}

if (!BUNDLER_URL.startsWith('http')) {
  fail(`a whitespace-only WXT_BUNDLER_URL produced ${JSON.stringify(BUNDLER_URL)}`);
} else {
  pass('a whitespace-only bundler URL falls back to the default');
}

if (!ARBITRUM_RPC_URL.startsWith('http')) {
  fail(`a blank WXT_ARBITRUM_RPC_URL produced ${JSON.stringify(ARBITRUM_RPC_URL)}`);
} else {
  pass('a blank Arbitrum RPC URL falls back to the default');
}

console.log(failed ? '\nFAILED' : '\nblank env values are treated as unset');
process.exit(failed ? 1 : 0);
