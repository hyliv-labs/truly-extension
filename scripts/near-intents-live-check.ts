/**
 * Live 1Click check: dry quotes only. No deposit address is created and no
 * funds move. Confirms the routes Ghosty features still quote, in both
 * directions, and that each answer passes the same checks money relies on.
 *
 * Run: pnpm check:intents
 */

import {
  ARB_USDC_ASSET,
  FEATURED_ASSETS,
  createOneClickClient,
  formatUnits,
  getQuote,
  type OneClickToken,
} from '../src/lib/near-intents.ts';

const client = createOneClickClient();
const tokens: OneClickToken[] = await client.tokens();
const byId = new Map(tokens.map((token) => [token.assetId, token]));
console.log(`1Click lists ${tokens.length} tokens on ${new Set(tokens.map((t) => t.blockchain)).size} chains`);

// Recipient / refund addresses that 1Click accepts as well-formed. Nothing is
// ever sent to them: every quote below is dry.
const SAMPLE_ADDRESS: Record<string, string> = {
  zec: 't1Hsc1LR8yKnbbe3twRp88p6vFfC5t7DLbs',
  aleo: 'aleo1kelm7k8786anyygg788ntlgkx4uqkmkpj7k5ugfuqchd8rnf858sun3qcr',
  sol: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
  btc: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
  near: 'intents.near',
};
const EVM = '0x1111111111111111111111111111111111111111';
const addressFor = (chain: string) => SAMPLE_ADDRESS[chain] ?? EVM;

let failed = 0;
for (const featured of FEATURED_ASSETS) {
  const token = byId.get(featured.assetId);
  if (!token) {
    console.log(`MISSING ${featured.label}: not in /v0/tokens`);
    failed += 1;
    continue;
  }
  for (const direction of ['exit', 'entry'] as const) {
    const usd = 20;
    const units =
      direction === 'exit'
        ? 20_000_000n
        : BigInt(Math.round((usd / (token.price || 1)) * 10 ** token.decimals));
    try {
      const { quote } = await getQuote(client, {
        dry: true,
        originAsset: direction === 'exit' ? ARB_USDC_ASSET : featured.assetId,
        destinationAsset: direction === 'exit' ? featured.assetId : ARB_USDC_ASSET,
        amountUnits: units,
        recipient: direction === 'exit' ? addressFor(token.blockchain) : EVM,
        refundTo: direction === 'exit' ? EVM : addressFor(token.blockchain),
        slippageBps: 100,
        deadlineMinutes: 60,
      });
      const outDecimals = direction === 'exit' ? token.decimals : 6;
      console.log(
        `ok   ${direction.padEnd(5)} ${featured.label.padEnd(18)} in ${quote.amountInFormatted} -> out ${formatUnits(quote.amountOut, outDecimals)} (~${quote.timeEstimate}s)`,
      );
    } catch (error) {
      failed += 1;
      console.log(`FAIL ${direction.padEnd(5)} ${featured.label.padEnd(18)} ${error instanceof Error ? error.message : String(error)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}
if (failed > 0) {
  console.log(`${failed} route(s) did not quote. Liquidity moves; check before a demo.`);
  process.exit(1);
}
console.log('all featured routes quote in both directions');
