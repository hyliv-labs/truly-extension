/**
 * App venues (app-venues.ts): routing by host, and that the manifest covers
 * every app. A host the manifest misses gets no injected wallet, and a host
 * the table misses would be handed to the wrong venue's address.
 */

import { readFileSync } from 'node:fs';
import { APP_VENUE_IDS, APP_VENUES, appVenueFromHost, isAppVenue } from '../src/lib/app-venues.ts';
import { venueFromOrigin } from '../src/lib/trade.ts';

let failed = false;
const expect = (label: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) console.log('pass', label);
  else {
    console.error('FAIL', label, 'got', JSON.stringify(got), 'want', JSON.stringify(want));
    failed = true;
  }
};

const manifest = readFileSync(new URL('../wxt.config.ts', import.meta.url), 'utf8');
const content = readFileSync(new URL('../entrypoints/lighter.content.ts', import.meta.url), 'utf8');
for (const id of APP_VENUE_IDS) {
  const spec = APP_VENUES[id];
  expect(`${spec.name}: one tab pattern per domain`, spec.tabPatterns.length, spec.domains.length);
  for (const domain of spec.domains) {
    expect(`${spec.name}: ${domain} routes to it`, venueFromOrigin(`https://app.${domain}`), id);
    expect(`${spec.name}: ${domain} itself routes to it`, appVenueFromHost(domain), id);
    expect(`${spec.name}: a lookalike of ${domain} does not`, appVenueFromHost(`${domain}.evil.com`), null);
    expect(`${spec.name}: not${domain} does not`, appVenueFromHost(`not${domain}`), null);
  }
  for (const pattern of spec.tabPatterns) {
    expect(`${spec.name}: manifest host permission and resource match ${pattern}`, manifest.split(`'${pattern}'`).length - 1, 2);
    expect(`${spec.name}: content script matches ${pattern}`, content.includes(`'${pattern}'`), true);
  }
  expect(`${spec.name}: has a logo`, (() => { try { readFileSync(new URL(`../public/apps/${id}.png`, import.meta.url)); return true; } catch { return false; } })(), true);
  expect(`${spec.name}: minimum is at least 1 USDC`, spec.minUnits >= 1_000_000n, true);
}
expect('isAppVenue refuses other venues', [isAppVenue('compound'), isAppVenue('hyperliquid'), isAppVenue('x')], [false, false, false]);
expect('the existing venues still route', [venueFromOrigin('https://app.uniswap.org'), venueFromOrigin('https://app.lighter.xyz'), venueFromOrigin('https://app.hyperliquid.xyz')], ['uniswap', 'lighter', 'hyperliquid']);

if (failed) process.exit(1);
console.log('app-venues: all checks passed');
