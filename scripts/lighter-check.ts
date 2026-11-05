/**
 * Live check against Lighter's mainnet API. Network-dependent, so it is NOT
 * part of `pnpm check` — run it with `pnpm check:lighter` when you want to
 * confirm the endpoints still behave as E4 assumes.
 *
 * It allocates an intent address for a throwaway address and moves no funds.
 */

import {
  createIntentAddress,
  getAccountIndex,
  getDepositStatus,
  getFastBridgeLimit,
  isDepositComplete,
} from '../src/lib/lighter.ts';

let failed = false;
const fail = (msg: string) => {
  console.error('FAIL', msg);
  failed = true;
};
const pass = (msg: string) => console.log('pass', msg);

// Derived from the public hardhat test phrase; holds nothing.
const OWNER = '0x8C8d35429F74ec245F8Ef2f4Fd1e551cFF97d650' as const;

const limit = await getFastBridgeLimit();
pass(`fast_bridge_limit = ${limit}${limit === '0' ? ' (no capacity: expect the ~15-20 min path)' : ''}`);

const intent = await createIntentAddress(OWNER);
if (!/^0x[0-9a-fA-F]{40}$/.test(intent)) fail(`intent address malformed: ${intent}`);
else pass(`intent address allocated: ${intent}`);

// Lighter must hand back the SAME intent address for the same owner, or a
// resumed trade would send its withdrawal to an address nothing watches.
const again = await createIntentAddress(OWNER);
if (again.toLowerCase() !== intent.toLowerCase()) {
  fail(`intent address is not stable per owner: ${intent} then ${again}`);
} else {
  pass('intent address is stable for a given owner');
}

const status = await getDepositStatus(OWNER);
pass(`deposit status: ${status.status} — ${status.description}`);

if (status.intentAddress.toLowerCase() !== intent.toLowerCase()) {
  fail('deposit status reports a different intent address');
} else {
  pass('deposit status agrees with the allocated intent address');
}

if (!status.isExternalDeposit) {
  fail('is_external_deposit did not stick — the relayer could not fund this');
} else {
  pass('is_external_deposit is set, so the relayer may fund it');
}

if (isDepositComplete(status)) {
  fail('a never-funded address reports complete');
} else {
  pass('undeposited address is not reported complete');
}

// A fresh owner has no Lighter account until its first deposit is credited.
const index = await getAccountIndex(OWNER);
pass(`account index for an unfunded owner: ${index === null ? 'none (expected)' : index}`);

process.exitCode = failed ? 1 : 0;
