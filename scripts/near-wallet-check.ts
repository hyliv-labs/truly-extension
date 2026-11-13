/**
 * Ghosty's NEAR wallet: NEP-413 signatures match near-api-js 7.4.0
 * (KeyPairSigner.signNep413Message, same key and inputs), and transaction
 * requests are parsed and refused as intended.
 */
import { nearKeyFromSecret } from '../src/lib/near-keys.ts';
import { implicitPublicKey, parseNearTransactions, parseNep413, signNep413 } from '../src/lib/near-wallet.ts';

let failed = 0;
const check = (ok: boolean, name: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
  if (!ok) failed += 1;
};
const throws = (fn: () => unknown, pattern: RegExp, name: string) => {
  try {
    fn();
    check(false, `${name} (did not throw)`);
  } catch (error) {
    check(pattern.test(error instanceof Error ? error.message : String(error)), name);
  }
};

const key = nearKeyFromSecret(Uint8Array.from(Buffer.from('245a98160f307982485f97a95d353674ce691ec9853ae2fce02093a85e160408', 'hex')));
const nonce = { __bytes: Array(32).fill(9) };

const a = signNep413(key, parseNep413([{ message: 'Login to Rhea', recipient: 'app.rhea.finance', nonce, network: 'mainnet' }]));
check(a.signature === 'tgonu9aZ1JGDColtPoF8Dy3aBUPeIncy7KE7McV6r23V+x4FQOhYjLsJAsRoZLDQYtf0HLQM6s5e+rSnXBmOCw==', 'NEP-413 signature matches near-api-js');
check(a.publicKey === 'ed25519:4rPYQhpgAiCvb3xaZm22zaUgvbvfVVRgU3q1AqmusNRK' && a.accountId === key.accountId, 'NEP-413 account and public key match near-api-js');
const b = signNep413(key, parseNep413([{ message: 'hi', recipient: 'x.near', nonce, callbackUrl: 'https://a.b/c' }]));
check(b.signature === 'ZY6ST4nstAv112/w6grzhivNl71rlDTjrnRhfVCUS41CQ8mdFNQ650D2rkASmjU+ojGpk8nk1p4NF2LOqC1WAg==', 'NEP-413 with callbackUrl matches near-api-js');
check(implicitPublicKey(key.accountId) === key.publicKey, 'public key from implicit account id');
throws(() => parseNep413([{ message: 'x', recipient: 'y', nonce: { __bytes: [1, 2] } }]), /32 bytes/, 'short nonce refused');

const acct = key.accountId;
const txs = parseNearTransactions('near_signAndSendTransactions', [{ network: 'mainnet', transactions: [
  { receiverId: 'wrap.near', actions: [{ type: 'FunctionCall', params: { methodName: 'near_deposit', args: {}, gas: '10000000000000', deposit: '1000000000000000000000000' } }] },
  { receiverId: 'v2.ref-finance.near', actions: [{ type: 'FunctionCall', params: { methodName: 'swap', args: { actions: [] }, gas: '100000000000000', deposit: '1' } }, { type: 'Transfer', params: { deposit: '5' } }] },
] }], acct);
check(txs.length === 2 && txs[1]?.actions.length === 2, 'two transactions parsed');
check(txs[0]?.lines[0] === 'Call near_deposit({}) attaching 1 NEAR', 'deposit shown in NEAR');
throws(() => parseNearTransactions('near_signAndSendTransaction', [{ receiverId: 'x.near', actions: [{ type: 'AddKey', params: {} }] }], acct), /does not sign AddKey/, 'AddKey refused');
throws(() => parseNearTransactions('near_signAndSendTransaction', [{ receiverId: 'x.near', actions: [{ type: 'DeleteAccount', params: {} }] }], acct), /does not sign DeleteAccount/, 'DeleteAccount refused');
throws(() => parseNearTransactions('near_signAndSendTransaction', [{ signerId: 'someone.near', receiverId: 'x.near', actions: [{ type: 'Transfer', params: { deposit: '1' } }] }], acct), /another NEAR account/, 'other signer refused');
throws(() => parseNearTransactions('near_signAndSendTransaction', [{ network: 'testnet', receiverId: 'x.near', actions: [{ type: 'Transfer', params: { deposit: '1' } }] }], acct), /mainnet/, 'testnet refused');
throws(() => parseNearTransactions('near_signAndSendTransaction', [{ receiverId: 'x.near', actions: [{ type: 'FunctionCall', params: { methodName: 'm', args: {}, gas: '400000000000000', deposit: '0' } }] }], acct), /more gas/, 'excess gas refused');
throws(() => parseNearTransactions('near_signAndSendTransaction', [{ receiverId: 'x.near', actions: [{ type: 'Transfer', params: { deposit: '-1' } }] }], acct), /unreadable/, 'negative amount refused');

if (failed) {
  console.log(`${failed} NEAR wallet check(s) failed`);
  process.exit(1);
}
console.log('near wallet: all checks pass');
