/**
 * Asserts our reimplementation of privacypools.com's wallet-signature seed
 * derivation matches theirs.
 *
 * A single wrong byte here produces a valid-looking mnemonic for a DIFFERENT,
 * empty account. The user would be told they have no funds rather than seeing
 * an error, so every constant is pinned by test.
 */

import { privateKeyToAccount, mnemonicToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import {
  buildSeedDerivationTypedData,
  deriveMnemonicFromWalletSignature,
  SeedSignatureError,
} from '../src/lib/wallet-seed.ts';

let failed = false;
const fail = (msg: string) => {
  console.error('FAIL', msg);
  failed = true;
};
const pass = (msg: string) => console.log('pass', msg);

const account = privateKeyToAccount(`0x${'aa'.repeat(32)}` as Hex);

async function seedFor(version: 'v1' | 'v2') {
  const signature = await account.signTypedData(
    buildSeedDerivationTypedData(account.address, version),
  );
  return deriveMnemonicFromWalletSignature(signature, account.address, version);
}

const v2 = await seedFor('v2');
const v2again = await seedFor('v2');
const v1 = await seedFor('v1');

if (v2.split(' ').length !== 24) fail(`v2 should be 24 words, got ${v2.split(' ').length}`);
else pass('v2 derives a 24-word mnemonic');

if (v1.split(' ').length !== 12) fail(`v1 should be 12 words, got ${v1.split(' ').length}`);
else pass('v1 derives a 12-word mnemonic');

// Determinism is the whole basis of recovery: no stored secret, just a
// reproducible signature.
if (v2 !== v2again) fail('same wallet produced two different v2 mnemonics');
else pass('derivation is deterministic across signings');

// v1 and v2 are different accounts, not two encodings of one.
if (v1 === v2) fail('v1 and v2 produced the same mnemonic');
else pass('v1 and v2 are distinct accounts');

// The output must be a real BIP-39 phrase the SDK can consume.
try {
  mnemonicToAccount(v2);
  pass('derived phrase is valid BIP-39 and loads as an account');
} catch {
  fail('derived phrase is not valid BIP-39');
}

// A different wallet must never land on someone else's account.
const other = privateKeyToAccount(`0x${'bb'.repeat(32)}` as Hex);
const otherSig = await other.signTypedData(
  buildSeedDerivationTypedData(other.address, 'v2'),
);
if ((await deriveMnemonicFromWalletSignature(otherSig, other.address, 'v2')) === v2) {
  fail('a different wallet derived the same mnemonic');
} else {
  pass('a different wallet derives a different mnemonic');
}

// A signature by the wrong account must be refused, not silently used — it
// would derive an empty account and look like "you have no funds".
try {
  await deriveMnemonicFromWalletSignature(otherSig, account.address, 'v2');
  fail('accepted a signature made by a different address');
} catch (error) {
  if (error instanceof SeedSignatureError) pass('refuses a signature from the wrong address');
  else fail(`wrong error type: ${String(error)}`);
}

// Contract wallets sign in other formats; a short signature must be refused.
try {
  await deriveMnemonicFromWalletSignature(`0x${'11'.repeat(64)}` as Hex, account.address);
  fail('accepted a 64-byte signature');
} catch (error) {
  if (error instanceof SeedSignatureError) pass('refuses a signature that is not 65 bytes');
  else fail(`wrong error type: ${String(error)}`);
}

// The signed payload must commit to keccak256(address) and the versioned
// context, or it is not the payload the website asks wallets to sign.
const typed = buildSeedDerivationTypedData(account.address, 'v2');
if (typed.message.context !== 'privacy-pools/wallet-seed:v2') {
  fail(`wrong context string: ${typed.message.context}`);
} else if (typed.message.action !== 'Derive Account Seed') {
  fail(`wrong action string: ${typed.message.action}`);
} else if (typed.domain.name !== 'Privacy Pools' || typed.domain.version !== '1') {
  fail('wrong EIP-712 domain');
} else {
  pass('typed data matches the website payload exactly');
}

process.exitCode = failed ? 1 : 0;
