/**
 * NEAR Intents 1Click: amount math and quote checks.
 *
 * The expensive mistake here is a deposit that does not match the quote.
 * With EXACT_INPUT, 1Click refunds a deposit that is short, and refunds the
 * excess of one that is long, with a fee. Ghosty's exit deposit is a Railgun
 * unshield, whose fee comes out of the amount, so the number quoted has to be
 * exactly what the contract delivers.
 *
 * The fixture is a real non-dry quote (2026-11-11, no funds sent).
 */

import {
  ARB_USDC_ASSET,
  authHeaders,
  buildQuoteRequest,
  checkQuote,
  createOneClickClient,
  describeStatus,
  destinationTx,
  formatUnits,
  parseUnits,
  pickerAssets,
  railgunNetForGross,
  type QuoteResponse,
  type StatusResponse,
} from '../src/lib/near-intents.ts';

let failed = false;
const fail = (msg: string) => {
  console.error('FAIL', msg);
  failed = true;
};
const pass = (msg: string) => console.log('pass', msg);
const throws = (label: string, run: () => unknown, pattern: RegExp) => {
  try {
    run();
    fail(`${label}: did not throw`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (pattern.test(message)) pass(label);
    else fail(`${label}: threw "${message}"`);
  }
};

// --- Railgun fee: inclusive, floor. Measured on Arbitrum yesterday. -------
if (railgunNetForGross(9_814_800n, 25n) !== 9_790_263n) fail('9,814,800 at 25 bps should arrive as 9,790,263');
else pass('railgun net matches the measured unshield (9.8148 -> 9.790263)');

// The contract: base = amount - floor(amount * bps / 10000). Never more than
// the gross, never less than gross minus the ceiling of the fee.
for (const gross of [1n, 399n, 400n, 1_000_000n, 2_000_001n, 5_000_000n, 123_456_789n]) {
  const net = railgunNetForGross(gross, 25n);
  const fee = gross - net;
  if (fee !== (gross * 25n) / 10_000n) fail(`fee for ${gross} is ${fee}`);
}
pass('railgun fee is floor(gross * bps / 10000) across amounts');
throws('railgun net refuses zero', () => railgunNetForGross(0n, 25n), /positive/);
throws('railgun net refuses a 100% fee', () => railgunNetForGross(10n, 10_000n), /usable rate/);

// --- Request building -------------------------------------------------------
const now = Date.parse('2026-11-11T11:20:12.000Z');
const R = '0x1111111111111111111111111111111111111111';
const BASE_USDC = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near';
const request = buildQuoteRequest({
  dry: false,
  originAsset: ARB_USDC_ASSET,
  destinationAsset: BASE_USDC,
  amountUnits: 2_000_000n,
  recipient: ` ${R} `,
  refundTo: R,
  slippageBps: 100,
  deadlineMinutes: 60,
  now,
});
if (request.recipient !== R) fail('recipient should be trimmed');
else pass('recipient is trimmed');
if (request.deadline !== '2026-11-11T12:20:12.000Z') fail(`deadline ${request.deadline}`);
else pass('deadline is now + minutes, ISO');
if (request.swapType !== 'EXACT_INPUT' || request.confidentiality !== undefined) fail('default is a public EXACT_INPUT quote');
else pass('default is a public EXACT_INPUT quote');
if (buildQuoteRequest({ ...requestInput(), confidential: true }).confidentiality !== 'basic') fail('confidential asks for basic');
else pass('confidential flag asks for basic confidentiality');
throws('same asset both sides is refused', () => buildQuoteRequest({ ...requestInput(), destinationAsset: ARB_USDC_ASSET }), /same asset/);
throws('slippage over 10% is refused', () => buildQuoteRequest({ ...requestInput(), slippageBps: 5_000 }), /Slippage/);
throws('zero amount is refused', () => buildQuoteRequest({ ...requestInput(), amountUnits: 0n }), /positive/);

function requestInput() {
  return {
    dry: false,
    originAsset: ARB_USDC_ASSET,
    destinationAsset: BASE_USDC,
    amountUnits: 2_000_000n,
    recipient: R,
    refundTo: R,
    slippageBps: 100,
    deadlineMinutes: 60,
    now,
  };
}

// --- Quote checks against a real response ----------------------------------
const real: QuoteResponse = {
  quote: {
    amountIn: '2000000',
    amountInFormatted: '2.0',
    amountOut: '1997365',
    amountOutFormatted: '1.997365',
    minAmountOut: '1977391',
    timeEstimate: 27,
    refundFee: '5300',
    withdrawFee: '2400',
    deadline: '2026-11-14T12:20:12.000Z',
    timeWhenInactive: '2026-11-14T12:20:12.000Z',
    depositAddress: '0xD052002F1e145b3080aD2a069b62Dd86a4718565',
  },
  quoteRequest: { ...request, depositMode: 'SIMPLE', confidentiality: 'public' },
  signature: 'ed25519:5QPiQs8SsmQBFc6bdgZZcUn98MkH5JL3cVnc8nY4weAQxmCiQD8qEUtTr9vLHWDT9PvhYzERwVxrSPpfHEt76ySv',
  timestamp: '2026-11-11T11:20:13.028Z',
  correlationId: 'ff2bac1e-3d9c-493f-8f62-efbc6b40cb1a',
};

if (checkQuote(request, real, now).depositAddress !== real.quote.depositAddress) fail('a matching quote should pass');
else pass('the real quote passes');

const tamper = (patch: Partial<QuoteResponse['quoteRequest']>, quotePatch: Partial<QuoteResponse['quote']> = {}): QuoteResponse => ({
  ...real,
  quoteRequest: { ...real.quoteRequest, ...patch },
  quote: { ...real.quote, ...quotePatch },
});
throws('a different recipient is refused', () => checkQuote(request, tamper({ recipient: '0x2222222222222222222222222222222222222222' }), now), /recipient/);
throws('a different refund address is refused', () => checkQuote(request, tamper({ refundTo: '0x2222222222222222222222222222222222222222' }), now), /refund address/);
throws('a different destination asset is refused', () => checkQuote(request, tamper({ destinationAsset: 'nep141:sol.omft.near' }), now), /destination asset/);
throws('a different echoed amount is refused', () => checkQuote(request, tamper({ amount: '2000001' }), now), /amount/);
throws('amountIn above the request is refused', () => checkQuote(request, tamper({}, { amountIn: '2000001' }), now), /units in/);
throws('zero out is refused', () => checkQuote(request, tamper({}, { amountOut: '0' }), now), /nothing out/);
throws('a minimum above the quote is refused', () => checkQuote(request, tamper({}, { minAmountOut: '1997366' }), now), /minimum/);
throws('no deposit address on a real quote is refused', () => checkQuote(request, tamper({}, { depositAddress: undefined }), now), /deposit address/);
throws('an unsigned quote is refused', () => checkQuote(request, { ...real, signature: '' }, now), /unsigned/);
throws(
  'an already inactive address is refused',
  () => checkQuote(request, real, Date.parse('2026-11-15T00:00:00.000Z')),
  /inactive/,
);
if (checkQuote(request, tamper({ recipient: R.toUpperCase().replace('0X', '0x') }), now)) pass('address comparison ignores case');

const dry = { ...request, dry: true };
if (!checkQuote(dry, { ...real, quoteRequest: { ...real.quoteRequest, dry: true }, quote: { ...real.quote, depositAddress: undefined } }, now)) {
  fail('a dry quote needs no deposit address');
} else pass('a dry quote needs no deposit address');

// --- Status ----------------------------------------------------------------
const success: StatusResponse = {
  status: 'SUCCESS',
  updatedAt: '2026-11-11T11:21:00.000Z',
  swapDetails: {
    destinationChainTxHashes: [
      { hash: '0xaaa', explorerUrl: '' },
      { hash: '0xbbb', explorerUrl: 'https://basescan.org/tx/0xbbb' },
    ],
  },
};
if (destinationTx(success)?.hash !== '0xbbb') fail('the last destination tx is the delivery');
else pass('destination tx is the last one reported');
if (destinationTx({ status: 'PENDING_DEPOSIT', updatedAt: '' }) !== null) fail('no details means no tx');
else pass('no swap details means no destination tx');
if (!/fresh address/.test(describeStatus('REFUNDED', 'exit'))) fail('an exit refund lands at the fresh address');
else pass('exit refund text names the fresh address');

// --- Units ------------------------------------------------------------------
if (parseUnits('12.5', 6) !== 12_500_000n) fail('12.5 USDC');
else pass('parseUnits 12.5 -> 12500000');
if (parseUnits('0.02', 8) !== 2_000_000n) fail('0.02 ZEC');
else pass('parseUnits 0.02 ZEC -> 2000000');
throws('too many decimals is refused', () => parseUnits('1.0000001', 6), /decimals/);
throws('junk is refused', () => parseUnits('1e5', 6), /amount like/);
if (formatUnits(1_997_365n, 6) !== '1.997365' || formatUnits('2000000', 6) !== '2') fail('formatUnits');
else pass('formatUnits trims trailing zeros');

// --- Auth headers ------------------------------------------------------------
if (Object.keys(authHeaders(null)).length !== 0) fail('no key, no header');
else pass('no partner key sends no auth header');
if (authHeaders('a.b.c').Authorization !== 'Bearer a.b.c') fail('a JWT goes in Authorization');
else pass('a JWT goes in Authorization: Bearer');
if (authHeaders(' plain-key ')['X-API-Key'] !== 'plain-key') fail('a plain key goes in X-API-Key');
else pass('a plain key goes in X-API-Key');

// --- Picker ---------------------------------------------------------------------
const rows = pickerAssets([
  { assetId: ARB_USDC_ASSET, decimals: 6, blockchain: 'arb', symbol: 'USDC' },
  { assetId: 'nep141:zec.omft.near', decimals: 8, blockchain: 'zec', symbol: 'ZEC' },
  { assetId: 'x:bsc', decimals: 18, blockchain: 'bsc', symbol: 'BNB' },
  { assetId: 'x:old', decimals: 6, blockchain: 'pol', symbol: 'USDC(DEPRECATED)' },
  { assetId: 'x:pol', decimals: 6, blockchain: 'pol', symbol: 'USDC' },
]);
const ids = rows.map((row) => row.assetId);
if (ids[0] !== 'nep141:zec.omft.near' || !rows[0]?.privacy) fail('featured privacy assets come first');
else pass('featured privacy assets come first');
if (ids.includes(ARB_USDC_ASSET) || ids.includes('x:bsc') || ids.includes('x:old')) fail('arb USDC, BNB and deprecated are hidden');
else pass('Arbitrum USDC, BNB Chain and deprecated tickers are hidden');
if (!ids.includes('x:pol')) fail('everything else stays selectable');
else pass('other listed assets stay selectable');

// --- Client wiring (no network) -----------------------------------------------
const seen: { url: string; init?: RequestInit }[] = [];
const fakeFetch = (async (url: string, init?: RequestInit) => {
  seen.push({ url, init });
  if (url.endsWith('/v0/quote')) return new Response(JSON.stringify({ message: 'recipient is not valid' }), { status: 400 });
  return new Response(JSON.stringify({ status: 'PENDING_DEPOSIT', updatedAt: '' }), { status: 200 });
}) as typeof fetch;
const client = createOneClickClient({ apiKey: 'k', fetch: fakeFetch, base: 'https://x' });
await client.status('0xabc', 'memo1');
const first = seen[0];
if (first?.url !== 'https://x/v0/status?depositAddress=0xabc&depositMemo=memo1') fail(`status url ${first?.url}`);
else pass('status passes the deposit address and memo');
if ((first?.init?.headers as Record<string, string> | undefined)?.['X-API-Key'] !== 'k') fail('the key is sent');
else pass('the partner key is sent on every call');
try {
  await client.quote(request);
  fail('a 400 should throw');
} catch (error) {
  if (error instanceof Error && error.message === 'recipient is not valid') pass("1Click's own message is surfaced");
  else fail(`400 threw ${String(error)}`);
}

if (failed) process.exit(1);
console.log('near-intents: all checks passed');
