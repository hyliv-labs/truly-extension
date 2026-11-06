/**
 * The Connect button's consent lets a waiting site skip the approval window,
 * so it must not be usable for anything else. Each property below is a way a
 * looser implementation would let a site connect without the user's click.
 *
 * Offline; part of `pnpm check`.
 */

import { installChromeStub } from './chrome-stub.ts';

installChromeStub();

const { grantConnectConsent, consumeConnectConsent } = await import('../src/lib/provider.ts');

let failed = false;
const fail = (m: string) => {
  console.error('FAIL', m);
  failed = true;
};
const pass = (m: string) => console.log('pass', m);
const expect = (got: boolean, want: boolean, what: string) =>
  got === want ? pass(what) : fail(`${what} (got ${got}, wanted ${want})`);

const LIGHTER = 'https://app.lighter.xyz';

await grantConnectConsent(LIGHTER);
expect(await consumeConnectConsent(LIGHTER), true, 'consent for the site the user clicked Connect for is honoured');
expect(await consumeConnectConsent(LIGHTER), false, 'consent is single-use: a second connect needs a second click');

await grantConnectConsent(LIGHTER);
expect(await consumeConnectConsent('https://evil.example'), false, 'consent for one site does not authorise another');
expect(await consumeConnectConsent(LIGHTER), false, 'a wrong-site attempt still burns the grant');

await grantConnectConsent(`${LIGHTER}/trade/ETH?x=1`);
expect(await consumeConnectConsent(LIGHTER), true, 'origins are compared, not full URLs');

expect(await consumeConnectConsent(LIGHTER), false, 'no grant means no consent');

// Expiry: a stale grant must not authorise a later, unrelated request.
await chrome.storage.session.set({
  'truly:connectConsent': { origin: LIGHTER, at: Date.now() - 3 * 60_000 },
});
expect(await consumeConnectConsent(LIGHTER), false, 'a grant older than two minutes has expired');

console.log(failed ? '\nFAILED' : '\nconnect consent is single-use, per-site and short-lived');
process.exit(failed ? 1 : 0);
