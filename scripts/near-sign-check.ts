/**
 * NEAR signing: one transaction signed by near-chain.ts must match
 * near-api-js 7.4.0 (KeyPairSigner.signTransaction) byte for byte. The
 * expected hex was produced by that library from the same key and inputs.
 */
import { readFileSync } from 'node:fs';
import { nearKeyFromSecret } from '../src/lib/near-keys.ts';
import { ftTransferAction, nearSignTransaction, nearTransfer } from '../src/lib/near-chain.ts';

const [account, expected] = readFileSync(new URL('./near-sign-vector.txt', import.meta.url), 'utf8').trim().split('\n');
const key = nearKeyFromSecret(Uint8Array.from(Buffer.from('245a98160f307982485f97a95d353674ce691ec9853ae2fce02093a85e160408', 'hex')));
const signed = await nearSignTransaction(key, 'wrap.near', [ftTransferAction('abc.near', 1000n), nearTransfer(5n)], { nonce: 42n, blockHash: new Uint8Array(32).fill(7) });
let failed = 0;
const check = (ok: boolean, name: string) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`); if (!ok) failed++; };
check(key.accountId === account, 'implicit account matches near-api-js keyToImplicitAddress');
check(Buffer.from(signed).toString('hex') === expected, 'signed transaction matches near-api-js byte for byte');
if (failed) process.exit(1);
console.log('near signing: all checks pass');
