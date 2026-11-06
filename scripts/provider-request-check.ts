/**
 * Wallet-request parsing. A swapped argument or a foreign chain must fail
 * before an approval window opens, and the typed-data payload that is signed
 * must not still contain EIP712Domain — viem rejects that and the dapp would
 * see a failure that names neither field.
 */

import { privateKeyToAccount } from 'viem/accounts';
import {
  parsePersonalSign,
  parseTransactionRequest,
  parseTypedDataRequest,
  ProviderRequestError,
} from '../src/lib/provider-requests.ts';

const OWNER = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';

let failed = false;
const fail = (msg: string) => {
  console.error('FAIL', msg);
  failed = true;
};
const pass = (msg: string) => console.log('pass', msg);

function throws(label: string, fn: () => unknown, code: number): void {
  try {
    fn();
    fail(`${label} did not throw`);
  } catch (error) {
    if (error instanceof ProviderRequestError && error.code === code) pass(label);
    else fail(`${label} threw ${error instanceof Error ? error.message : String(error)}`);
  }
}

const typed = {
  domain: { name: 'Lighter', chainId: '0xa4b1' },
  types: {
    EIP712Domain: [{ name: 'name', type: 'string' }],
    Order: [{ name: 'amount', type: 'uint256' }],
  },
  primaryType: 'Order',
  message: { amount: '5' },
};

const parsed = parseTypedDataRequest(
  'eth_signTypedData_v4',
  [OWNER, JSON.stringify(typed)],
  OWNER,
);
if ('EIP712Domain' in parsed.types) fail('EIP712Domain was left in types');
else pass('EIP712Domain stripped');
if (parsed.domain.chainId !== 42161) fail(`chainId was ${String(parsed.domain.chainId)}`);
else pass('hex chainId coerced');
if (!parsed.summary.includes('Order')) fail('summary hid the primary type');
else pass('summary names the primary type');

const swapped = parseTypedDataRequest('eth_signTypedData_v4', [typed, OWNER], OWNER);
if (swapped.primaryType !== 'Order') fail('swapped typed-data params were not accepted');
else pass('swapped typed-data argument order accepted');

throws(
  'typed data for a different owner',
  () => parseTypedDataRequest('eth_signTypedData_v4', [OTHER, typed], OWNER),
  4100,
);
throws(
  'v1 typed data',
  () => parseTypedDataRequest('eth_signTypedData', [OWNER, typed], OWNER),
  4200,
);

const message = '0x6869';
const standard = parsePersonalSign([message, OWNER], OWNER);
if (standard.raw !== message) fail('standard personal_sign dropped the message');
else pass('personal_sign [message, address]');

const reversed = parsePersonalSign([OWNER, message], OWNER);
if (reversed.raw !== message || reversed.address !== OWNER) fail('reversed personal_sign mis-read');
else pass('personal_sign [address, message]');

throws(
  'personal_sign for a different owner',
  () => parsePersonalSign([message, OTHER], OWNER),
  4100,
);

const tx = parseTransactionRequest(
  [{ from: OWNER, to: OTHER, value: '0x0de0b6b3a7640000', data: '0xabcdef' }],
  OWNER,
);
if (tx.value !== 10n ** 18n) fail(`value parsed as ${tx.value}`);
else pass('transaction value parsed');
if (!tx.summary.includes(OTHER)) fail('summary hid the recipient');
else pass('transaction summary names the recipient');

throws(
  'transaction from a different owner',
  () => parseTransactionRequest([{ from: OTHER, to: OWNER }], OWNER),
  4100,
);
throws(
  'transaction on the wrong chain',
  () => parseTransactionRequest([{ from: OWNER, to: OTHER, chainId: 1 }], OWNER),
  4902,
);
throws(
  'contract creation',
  () => parseTransactionRequest([{ from: OWNER, data: '0x6000' }], OWNER),
  -32602,
);

const signer = privateKeyToAccount(
  '0x1111111111111111111111111111111111111111111111111111111111111111',
);
try {
  const signature = await signer.signTypedData({
    domain: parsed.domain,
    types: parsed.types,
    primaryType: parsed.primaryType,
    message: parsed.message,
  });
  if (!signature.startsWith('0x') || signature.length !== 132) fail('typed data did not sign');
  else pass('parsed typed data signs');
} catch (error) {
  fail(`parsed typed data did not sign: ${error instanceof Error ? error.message : String(error)}`);
}

process.exitCode = failed ? 1 : 0;
