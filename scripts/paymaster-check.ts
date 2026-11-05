/**
 * Asserts the paymasterData byte layout matches Circle's spec exactly:
 *
 *   byte 0        uint8 mode, always 0
 *   bytes 1..20   token address
 *   bytes 21..52  uint256 permitAmount
 *   bytes 53..    permit signature, no length prefix
 *
 * This is checked byte by byte because a wrong layout does not throw. The
 * operation is simply rejected on mainnet, after the trade has closed and the
 * user's money is already sitting at a single-use owner address.
 */

import { encodePaymasterData } from '../src/lib/permit.ts';
import { USDC_ADDRESS } from '../src/lib/config.ts';

let failed = false;
const fail = (msg: string) => {
  console.error('FAIL', msg);
  failed = true;
};
const pass = (msg: string) => console.log('pass', msg);

// 65-byte ECDSA signature, distinctive so a misplacement is obvious.
const signature = `0x${'ab'.repeat(65)}` as const;
const permitAmount = 10_000_000n; // 10 USDC

const data = encodePaymasterData({ permitAmount, permitSignature: signature });
const bytes = Buffer.from(data.slice(2), 'hex');

// 1 + 20 + 32 + 65
if (bytes.length !== 118) fail(`expected 118 bytes, got ${bytes.length}`);
else pass('total length is 1 + 20 + 32 + 65 bytes');

if (bytes[0] !== 0) fail(`mode byte should be 0, got ${bytes[0]}`);
else pass('leading mode byte is 0');

const token = `0x${bytes.subarray(1, 21).toString('hex')}`;
if (token.toLowerCase() !== USDC_ADDRESS.toLowerCase()) {
  fail(`token at bytes 1..20 is ${token}, expected ${USDC_ADDRESS}`);
} else {
  pass('token address occupies bytes 1..20');
}

const amount = BigInt(`0x${bytes.subarray(21, 53).toString('hex')}`);
if (amount !== permitAmount) {
  fail(`permitAmount at bytes 21..52 is ${amount}, expected ${permitAmount}`);
} else {
  pass('permitAmount is a full uint256 at bytes 21..52');
}

const tail = `0x${bytes.subarray(53).toString('hex')}`;
if (tail !== signature) {
  fail(`signature tail is ${tail.slice(0, 20)}…, expected ${signature.slice(0, 20)}…`);
} else {
  pass('signature follows with no length prefix');
}

// A different amount must not change where the signature starts — that would
// mean a length prefix had crept in.
const other = encodePaymasterData({
  permitAmount: 1n,
  permitSignature: signature,
});
if (Buffer.from(other.slice(2), 'hex').length !== bytes.length) {
  fail('encoding length varies with permitAmount, so a field is not fixed-width');
} else {
  pass('layout is fixed-width regardless of amount');
}

process.exitCode = failed ? 1 : 0;
