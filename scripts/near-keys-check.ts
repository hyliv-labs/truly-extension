/**
 * NEAR owner keys: SLIP-10 ed25519 vectors.
 *
 * Expected values come from independent libraries, run on the Hardhat test
 * phrase: near-seed-phrase (parseSeedPhrase, default m/44'/397'/0') for the
 * public key, and ed25519-hd-key (derivePath) for the secret keys.
 */

import { mnemonicToSeed } from '@scure/bip39';
import { deriveNearOwner, isImplicitAccount, nearKeyFromSecret, nearOwnerPath, slip10Ed25519 } from '../src/lib/near-keys.ts';
import { deriveOwner } from '../src/lib/keys.ts';

const PHRASE = 'test test test test test test test test test test test junk';
let failed = 0;
const check = (ok: boolean, name: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
  if (!ok) failed += 1;
};
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

const seed = await mnemonicToSeed(PHRASE);
const wallet = nearKeyFromSecret(slip10Ed25519(seed, "m/44'/397'/0'"));
check(hex(slip10Ed25519(seed, "m/44'/397'/0'")) === '31f5e9f8314382bad358f85d6f59cd823837026b9b91350835db83d0d3f8d093', "m/44'/397'/0' secret matches ed25519-hd-key");
check(wallet.publicKey === 'ed25519:9oA9CVKfCT6o1hJkEu2xywj9dLEcdeDjnrMCoZPYiheS', "m/44'/397'/0' public key matches near-seed-phrase");

const owner0 = await deriveNearOwner(PHRASE, 0);
const owner5 = await deriveNearOwner(PHRASE, 5);
check(nearOwnerPath(0) === "m/44'/397'/7702'/0'/0'", 'owner path');
check(hex(owner0.secretKey) === '245a98160f307982485f97a95d353674ce691ec9853ae2fce02093a85e160408', 'owner #0 secret matches ed25519-hd-key');
check(hex(owner5.secretKey) === '8fd2697b8142559c39999e96c8ff29e3cc6dc7b17a4d8eaad3ae8cd500235917', 'owner #5 secret matches ed25519-hd-key');
check(isImplicitAccount(owner0.accountId) && owner0.accountId === hex(owner0.publicKeyBytes), 'owner account is the 64-hex public key');
check(owner0.accountId !== owner5.accountId && owner0.accountId !== wallet.accountId, 'owners differ from each other and from the wallet account');

const evm0 = await deriveOwner(PHRASE, 0);
check(evm0.privateKey.slice(2) !== hex(owner0.secretKey), 'NEAR key is not the EVM owner key');

let threw = false;
try {
  slip10Ed25519(seed, "m/44'/397'/0");
} catch {
  threw = true;
}
check(threw, 'non-hardened level refused');

if (failed) {
  console.log(`${failed} NEAR key check(s) failed`);
  process.exit(1);
}
console.log('near keys: all checks pass');
