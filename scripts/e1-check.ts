// E1 verification: determinism of derivation + round-trip of the sealed vault.
// Run with Node's type stripping; no chrome APIs are touched here.

import {
  deriveFundingWallet,
  deriveOwner,
  FUNDING_WALLET_PATH,
  newMnemonic,
  isValidMnemonic,
  ownerPath,
  sdkMasterKeyPreimages,
} from '../src/lib/keys.ts';
import { seal, open } from '../src/lib/crypto.ts';

const fail = (msg: string) => {
  console.error('FAIL', msg);
  process.exitCode = 1;
};
const pass = (msg: string) => console.log('pass', msg);

// Fixed phrase so the expected address is stable across runs.
const PHRASE =
  'test test test test test test test test test test test junk';

if (!isValidMnemonic(PHRASE)) fail('fixture phrase should be valid');
else pass('fixture phrase validates');

if (ownerPath(0) !== "m/44'/60'/7702'/0/0") fail(`path wrong: ${ownerPath(0)}`);
else pass('derivation path shape');

if (FUNDING_WALLET_PATH !== "m/44'/60'/7702'/1/0") fail(`funding path wrong: ${FUNDING_WALLET_PATH}`);
else pass('funding wallet path is not a trade owner');

// THE COLLISION GUARD.
//
// The Privacy Pools SDK hashes the private keys at m/44'/60'/0'/0/0 and
// m/44'/60'/1'/0/0 into masterNullifier and masterSecret. An owner key that
// equals either one would make the key that signs on Lighter's website the
// preimage of half the material deriving every note in the pool. Owner
// account 1 did exactly that before this was caught, so it is asserted rather
// than left to the path string looking right.
{
  const { masterNullifierPreimage, masterSecretPreimage } =
    await sdkMasterKeyPreimages(PHRASE);
  let collided = false;
  for (let i = 0; i < 25; i++) {
    const owner = await deriveOwner(PHRASE, i);
    if (owner.privateKey === masterNullifierPreimage) {
      fail(`owner #${i} IS the masterNullifier preimage`);
      collided = true;
    }
    if (owner.privateKey === masterSecretPreimage) {
      fail(`owner #${i} IS the masterSecret preimage`);
      collided = true;
    }
  }
  const funding = await deriveFundingWallet(PHRASE);
  if (funding.privateKey === masterNullifierPreimage || funding.privateKey === masterSecretPreimage) {
    fail('funding wallet IS an SDK master-key preimage');
    collided = true;
  }
  for (let i = 0; i < 25; i++) {
    const owner = await deriveOwner(PHRASE, i);
    if (owner.address === funding.address) {
      fail(`funding wallet reuses trade owner #${i}`);
      collided = true;
    }
  }
  if (!collided) pass('no owner key equals either SDK master-key preimage (25 indices)');

  // Guard the guard: if these two were ever equal to each other, or the
  // helper returned a constant, the loop above would pass vacuously.
  if (masterNullifierPreimage === masterSecretPreimage) {
    fail('the two master-key preimages are identical — the check is vacuous');
  } else {
    pass('the two master-key preimages differ, so the check is meaningful');
  }
}

// Determinism: same phrase + index => same address, every time.
const a = await deriveOwner(PHRASE, 0);
const b = await deriveOwner(PHRASE, 0);
if (a.address !== b.address) fail('index 0 not deterministic');
else pass(`index 0 deterministic: ${a.address}`);

// Distinctness: a new index must never reuse an address.
const c = await deriveOwner(PHRASE, 1);
if (c.address === a.address) fail('index 1 reused index 0 address');
else pass(`index 1 distinct: ${c.address}`);

// Account 1' must differ from the standard account 0' of the same seed,
// so restoring the seed into a normal wallet does not reveal trade owners.
const { HDKey } = await import('@scure/bip32');
const { mnemonicToSeed } = await import('@scure/bip39');
const { privateKeyToAccount } = await import('viem/accounts');
const seed = await mnemonicToSeed(PHRASE);
const standard = HDKey.fromMasterSeed(seed).derive("m/44'/60'/0'/0/0");
const standardAddr = privateKeyToAccount(
  ('0x' + Buffer.from(standard.privateKey!).toString('hex')) as `0x${string}`,
).address;
if (standardAddr === a.address) fail('owner collides with standard account 0');
else pass(`distinct from standard m/44'/60'/0'/0/0 (${standardAddr})`);

// A fresh random phrase must not collide.
const other = await deriveOwner(newMnemonic(), 0);
if (other.address === a.address) fail('random phrase collided');
else pass('random phrase gives a different owner');

// Vault round-trip: seal then open returns the phrase; wrong password throws.
const box = await seal(PHRASE, 'correct horse battery staple');
const recovered = await open(box, 'correct horse battery staple');
if (recovered !== PHRASE) fail('seal/open did not round-trip');
else pass('vault seal/open round-trips');

try {
  await open(box, 'wrong password');
  fail('wrong password was accepted');
} catch (e) {
  if ((e as Error).message !== 'incorrect password') {
    fail(`unexpected error: ${(e as Error).message}`);
  } else pass('wrong password rejected');
}

// Restore path: re-deriving from the opened phrase must match the original.
const restored = await deriveOwner(recovered, 0);
if (restored.address !== a.address) fail('restore produced a different address');
else pass('restore from sealed phrase yields the same owner address');
