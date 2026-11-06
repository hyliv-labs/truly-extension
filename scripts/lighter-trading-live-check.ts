/**
 * The market-trade clients against LIVE Lighter mainnet. No funds involved:
 *
 *   - reads: markets, top of book, nonces, tx lookup, API keys, an account
 *   - one sendTx of an order signed by a random, UNREGISTERED key for an
 *     existing account. Lighter must refuse it (bad signature), which
 *     exercises the real rejection path. It cannot execute.
 *
 * Network; not part of `pnpm check`. Run: pnpm check:trading
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const markets = await import('../src/lib/lighter-markets.ts');
const trading = await import('../src/lib/lighter-trading.ts');
const signer = await import('../src/lib/lighter-signer.ts');
const plan = await import('../src/lib/trade-plan.ts');

let failed = false;
const fail = (m: string) => {
  console.error('FAIL', m);
  failed = true;
};
const pass = (m: string) => console.log('pass', m);

const list = await markets.fetchMarkets();
const tradable = list.filter((m) => m.tradable);
if (tradable.length < 10) fail(`only ${tradable.length} tradable markets`);
else pass(`${list.length} perp markets, ${tradable.length} tradable; top: ${tradable.slice(0, 5).map((m) => `${m.symbol} ${m.maxLeverage}x`).join(', ')}`);

const eth = await markets.fetchMarket(0);
const book = await markets.fetchTopOfBook(0);
if (!book.bestBid || !book.bestAsk || book.bestBid >= book.bestAsk) fail(`bad book ${JSON.stringify(book)}`);
else pass(`ETH book ${book.bestBid} / ${book.bestAsk}, mark ${eth.markPrice}, max ${eth.maxLeverage}x, size dp ${eth.sizeDecimals}, price dp ${eth.priceDecimals}`);

const sized = plan.sizeMarketOrder({ market: eth, direction: 'long', leverage: 5, requestedMarginUsd: 10, creditedUsd: 10, bestBid: book.bestBid, bestAsk: book.bestAsk });
pass(`a 10 USDC 5x long would be ${sized.baseAmount} ETH (${sized.baseAmountScaled}) at worst ${sized.worstPrice} (${sized.worstPriceScaled})`);

const nonce = await trading.nextNonce(1, 0);
if (!(nonce > 0)) fail(`nextNonce ${nonce}`);
else pass(`nextNonce works (${nonce})`);

const missing = await trading.lookupTx('0'.repeat(80));
if (missing.found) fail('a zero hash was "found"');
else pass('an unknown tx hash reads as not-found (21500), not as an error');

const acct = await trading.readTradingAccount(1);
pass(`account read parses: collateral ${acct.collateral}, ${acct.positions.length} positions`);

await signer.loadSigner(async () => {
  const b = readFileSync(join(root, 'public', 'lighter', 'lighter-signer.wasm'));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
});
const junkKey = await signer.generateApiKey();
const registered = await trading.isApiKeyRegistered(1, 200, junkKey.publicKey);
if (registered) fail('a random key reads as registered');
else pass('an unregistered key reads as not registered');

const account = { privateKey: junkKey.privateKey, apiKeyIndex: 200, accountIndex: 1 };
const junkNonce = await trading.nextNonce(1, 200).catch(() => 0);
const tx = await signer.signMarketOrder(
  account,
  { marketIndex: 0, clientOrderIndex: 1, baseAmount: sized.baseAmountScaled, price: sized.worstPriceScaled, isAsk: false, reduceOnly: false },
  junkNonce,
);
const outcome = await trading.sendTx(tx);
if (outcome.kind === 'accepted') fail('Lighter ACCEPTED an order signed by an unregistered key');
else pass(`an order signed by an unregistered key is refused: ${outcome.kind} — ${'message' in outcome ? outcome.message : ''}`);
const after = await trading.lookupTx(tx.txHash);
if (after.found) fail('the refused tx was sequenced');
else pass('the refused tx was never sequenced');

console.log(failed ? '\nFAILED' : '\nlive Lighter trading clients OK');
process.exit(failed ? 1 : 0);
