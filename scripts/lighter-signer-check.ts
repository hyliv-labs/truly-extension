/**
 * The REAL Lighter signer (the built WASM), driven offline: it loads, it does
 * not leak Go's fake Node globals, a market order carries exactly the fields
 * we asked for, and the ChangePubKey L1 signature recovers to the owner.
 *
 * Needs public/lighter/lighter-signer.wasm (scripts/build-lighter-signer.ts).
 * Part of `pnpm check`.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { verifyMessage } from 'viem';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const signer = await import('../src/lib/lighter-signer.ts');
const keys = await import('../src/lib/lighter-keys.ts');

let failed = false;
const fail = (m: string) => {
  console.error('FAIL', m);
  failed = true;
};
const pass = (m: string) => console.log('pass', m);

if ((globalThis as Record<string, unknown>).fs !== undefined) fail("Go's fake fs global leaked");
else pass("Go's stub fs global is removed after the runtime module loads");

await signer.loadSigner(async () => {
  const bytes = readFileSync(join(root, 'public', 'lighter', 'lighter-signer.wasm'));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
});
if ((globalThis as Record<string, unknown>).fs !== undefined) fail('fs leaked after Go init');
else pass('the signer starts without leaving fake globals behind');

const pair = await signer.generateApiKey();
const pair2 = await signer.generateApiKey();
if (pair.privateKey === pair2.privateKey) fail('GenerateAPIKey returned the same key twice');
else pass('API keys are random per call');

const account = { privateKey: pair.privateKey, apiKeyIndex: 4, accountIndex: 123456 };
const order = await signer.signMarketOrder(
  account,
  { marketIndex: 0, clientOrderIndex: 4242, baseAmount: 213, price: 224372, isAsk: false, reduceOnly: false },
  17,
);
const info = JSON.parse(order.txInfo) as Record<string, number>;
const expect: Record<string, number> = {
  MarketIndex: 0,
  ClientOrderIndex: 4242,
  BaseAmount: 213,
  Price: 224372,
  IsAsk: 0,
  Type: 1,
  TimeInForce: 0,
  ReduceOnly: 0,
  OrderExpiry: 0,
  Nonce: 17,
  ApiKeyIndex: 4,
  AccountIndex: 123456,
};
const wrong = Object.entries(expect).filter(([k, v]) => info[k] !== v);
if (order.txType !== 14 || wrong.length) fail(`market order fields wrong: ${JSON.stringify(wrong)} type ${order.txType}`);
else pass('a signed market order is IOC, type market, with the exact market/size/price/nonce requested');
if (!/^[0-9a-f]{80}$/.test(order.txHash)) fail(`tx hash shape ${order.txHash}`);
else pass('the tx hash is computed offline (known before sending)');
const exp = signer.txExpiresAt(order);
if (!exp || exp < Date.now() || exp > Date.now() + 3_600_000) fail(`ExpiredAt ${exp} is not a near-future deadline`);
else pass(`signed txs expire ~${Math.round((exp - Date.now()) / 60_000)} min out — a dead tx can be proven dead`);

const again = await signer.signMarketOrder(account, { marketIndex: 0, clientOrderIndex: 4242, baseAmount: 213, price: 224372, isAsk: false, reduceOnly: false }, 17);
if (again.txHash !== order.txHash) pass('re-signing produces a different tx (new ExpiredAt) — which is why Truly stores and resends the original bytes');
else pass('re-signing the same order is deterministic');

const close = await signer.signMarketOrder(account, { marketIndex: 0, clientOrderIndex: 5, baseAmount: 213, price: 219879, isAsk: true, reduceOnly: true }, 18);
const ci = JSON.parse(close.txInfo) as Record<string, number>;
if (ci.ReduceOnly !== 1 || ci.IsAsk !== 1) fail('the close order is not reduce-only / ask');
else pass('a close order is reduce-only on the opposite side');

const ownerKey = generatePrivateKey();
const owner = privateKeyToAccount(ownerKey);
const withdrawal = await signer.signWithdraw(account, 4_000_000n, 19);
const wi = JSON.parse(withdrawal.txInfo) as Record<string, number>;
if (withdrawal.txType !== 13 || wi.AssetIndex !== 3 || wi.RouteType !== 0 || wi.Amount !== 4_000_000 || wi.Nonce !== 19 || wi.FromAccountIndex !== 123456) {
  fail(`secure withdraw fields wrong: type ${withdrawal.txType} ${withdrawal.txInfo}`);
} else pass('SignWithdraw is the secure route: USDC on perps, exact amount, and it is not sent');

const fast = await signer.signFastWithdraw(account, {
  toAccountIndex: 999,
  amountUnits: 4_000_000n,
  feeUnits: 50_000n,
  toAddress: owner.address,
  nonce: 21,
});
const fi = JSON.parse(fast.txInfo) as Record<string, unknown>;
const memo = signer.fastWithdrawMemo(owner.address);
const memoBytes = Array.from({ length: 32 }, (_, i) => Number.parseInt(memo.slice(i * 2, i * 2 + 2), 16));
const memoOk = JSON.stringify(fi.Memo) === JSON.stringify(memoBytes);
if (
  fast.txType !== 12 ||
  fi.ToAccountIndex !== 999 ||
  fi.AssetIndex !== 3 ||
  fi.FromRouteType !== 0 ||
  fi.ToRouteType !== 0 ||
  fi.Amount !== 4_000_000 ||
  fi.USDCFee !== 50_000 ||
  fi.Nonce !== 21 ||
  !memoOk ||
  !fast.messageToSign
) {
  fail(`fast withdraw fields wrong: type ${fast.txType} ${fast.txInfo}`);
} else pass('a fast withdrawal is a transfer to the pool, with the destination in the memo, and it is not sent');
const fastL1 = await owner.signMessage({ message: fast.messageToSign });
const fastSigned = signer.withL1Signature(fast, fastL1);
const fastInfo = JSON.parse(fastSigned.txInfo) as { L1Sig?: string };
const fastRecovered = await verifyMessage({
  address: owner.address,
  message: fast.messageToSign,
  signature: fastInfo.L1Sig as `0x${string}`,
});
if (!fastRecovered) fail('the fast-withdrawal L1 signature does not recover to the owner');
else pass('the fast withdrawal carries an owner L1 signature');

const lev = await signer.signUpdateLeverage(account, 0, 2000, 19);
if (lev.txType !== 20) fail(`UpdateLeverage txType ${lev.txType}`);
else pass('leverage change signs (5x = IMF 2000)');

// ChangePubKey: owner signs Lighter's message with personal_sign.
const cpk = await signer.signChangePubKey(account, pair.publicKey, 0);
if (!cpk.messageToSign.startsWith('Register Lighter Account')) fail('ChangePubKey message is not Lighter\'s registration text');
const l1 = await owner.signMessage({ message: cpk.messageToSign });
const withSig = signer.withL1Signature(cpk, l1);
const parsed = JSON.parse(withSig.txInfo) as { L1Sig?: string; PubKey?: string };
const recovered = await verifyMessage({ address: owner.address, message: cpk.messageToSign, signature: parsed.L1Sig as `0x${string}` });
if (!recovered || withSig.txHash !== cpk.txHash || 'messageToSign' in withSig) fail('L1 signature not attached correctly');
else pass('the ChangePubKey L1 signature recovers to the owner and does not alter the tx hash');

const token = await signer.createAuthToken(account);
if (!token.includes(':123456:4:')) fail(`auth token shape ${token.slice(0, 30)}`);
else pass('read-only auth tokens are scoped to this account and key slot');

// Sealing: per-owner, per-account.
const sealed = await keys.sealApiKey(ownerKey, 123456, pair.privateKey);
if ((await keys.openApiKey(ownerKey, 123456, sealed)) !== pair.privateKey) fail('sealed API key did not round-trip');
else pass('the API key round-trips under its owner key');
for (const [what, k, idx] of [
  ['another owner', generatePrivateKey(), 123456],
  ['another account', ownerKey, 654321],
] as const) {
  try {
    await keys.openApiKey(k, idx, sealed);
    fail(`the API key opened under ${what}`);
  } catch {
    pass(`the API key does not open under ${what}`);
  }
}
if (JSON.stringify(sealed).includes(pair.privateKey.slice(2, 20))) fail('plaintext key visible in the sealed box');

console.log(failed ? '\nFAILED' : '\nlighter signer OK');
process.exit(failed ? 1 : 0);
