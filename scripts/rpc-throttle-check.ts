/**
 * The RPC throttle that keeps the first Railgun sync alive.
 *
 * Without it, the sync's slow-scan phase fires hundreds of calls at once,
 * public RPCs answer 429, ethers gives up, and the sync stalls at 67%. Each
 * property below is a way a looser throttle would bring that stall back, or
 * would quietly break unrelated requests.
 *
 * Offline; part of `pnpm check`.
 */

import { createThrottledFetch } from '../src/lib/rpc-throttle.ts';

let failed = false;
const fail = (m: string) => {
  console.error('FAIL', m);
  failed = true;
};
const pass = (m: string) => console.log('pass', m);

const RPC = 'https://arb1.arbitrum.io/rpc';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- concurrency is capped -------------------------------------------------
{
  let inFlight = 0;
  let peak = 0;
  const base = (async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await sleep(15);
    inFlight -= 1;
    return new Response('{"jsonrpc":"2.0","id":1,"result":"0x1"}', { status: 200 });
  }) as typeof fetch;
  const f = createThrottledFetch(base, { hosts: ['arb1.arbitrum.io'], concurrency: 4, maxRetries: 3, baseDelayMs: 1, maxDelayMs: 5 });
  await Promise.all(Array.from({ length: 200 }, () => f(RPC, { method: 'POST', body: '{}' })));
  if (peak > 4) fail(`a 200-call burst reached ${peak} in flight; the cap is 4`);
  else pass(`a 200-call burst never exceeds 4 in flight (peak ${peak})`);
}

// --- a 429 is retried until it succeeds -------------------------------------
{
  let calls = 0;
  const base = (async () => {
    calls += 1;
    return calls <= 2
      ? new Response('slow down', { status: 429 })
      : new Response('{"jsonrpc":"2.0","id":1,"result":"0x1"}', { status: 200 });
  }) as typeof fetch;
  const f = createThrottledFetch(base, { hosts: ['arb1.arbitrum.io'], concurrency: 2, maxRetries: 5, baseDelayMs: 1, maxDelayMs: 5 });
  const res = await f(RPC, { method: 'POST', body: '{}' });
  if (res.status !== 200 || calls !== 3) fail(`429 handling: status ${res.status} after ${calls} calls`);
  else pass('two 429s are retried and the third attempt succeeds');
}

// --- tenderly's rate limit arrives as a JSON-RPC error inside a 200 --------
{
  let calls = 0;
  const base = (async () => {
    calls += 1;
    return calls === 1
      ? new Response('{"id":243,"jsonrpc":"2.0","error":{"code":-32005,"message":"rate limit exceeded"}}', { status: 200 })
      : new Response('{"jsonrpc":"2.0","id":1,"result":"0x1"}', { status: 200 });
  }) as typeof fetch;
  const f = createThrottledFetch(base, { hosts: ['arb1.arbitrum.io'], concurrency: 2, maxRetries: 5, baseDelayMs: 1, maxDelayMs: 5 });
  const body = await (await f(RPC, { method: 'POST', body: '{}' })).text();
  if (calls !== 2 || !body.includes('"result"')) fail('a -32005 "rate limit exceeded" inside a 200 was not retried');
  else pass('a JSON-RPC -32005 rate limit inside a 200 is retried too');
}

// --- it gives up eventually, so a dead endpoint cannot hang forever --------
{
  let calls = 0;
  const base = (async () => {
    calls += 1;
    return new Response('slow down', { status: 429 });
  }) as typeof fetch;
  const f = createThrottledFetch(base, { hosts: ['arb1.arbitrum.io'], concurrency: 2, maxRetries: 3, baseDelayMs: 1, maxDelayMs: 2 });
  const res = await f(RPC, { method: 'POST', body: '{}' });
  if (res.status !== 429 || calls !== 4) fail(`expected to stop after 3 retries (4 calls), made ${calls}`);
  else pass('a persistent 429 is returned after maxRetries, not retried forever');
}

// --- unrelated hosts pass straight through ----------------------------------
{
  let calls = 0;
  const base = (async () => {
    calls += 1;
    return new Response('nope', { status: 429 });
  }) as typeof fetch;
  const f = createThrottledFetch(base, { hosts: ['arb1.arbitrum.io'], concurrency: 1, maxRetries: 5, baseDelayMs: 1, maxDelayMs: 2 });
  await f('https://rail-squid.squids.live/squid-railgun-arbitrum-v2/graphql');
  if (calls !== 1) fail('a non-RPC host was retried or throttled');
  else pass('requests to other hosts are neither throttled nor retried');
}

// --- a POST body survives a retry -------------------------------------------
{
  const seen: string[] = [];
  let calls = 0;
  const base = (async (_u: unknown, init?: RequestInit) => {
    calls += 1;
    seen.push(String(init?.body));
    return calls === 1 ? new Response('x', { status: 429 }) : new Response('{"result":"0x1"}', { status: 200 });
  }) as typeof fetch;
  const f = createThrottledFetch(base, { hosts: ['arb1.arbitrum.io'], concurrency: 1, maxRetries: 3, baseDelayMs: 1, maxDelayMs: 2 });
  await f(RPC, { method: 'POST', body: '{"method":"eth_getLogs"}' });
  if (seen[0] !== seen[1] || !seen[1]?.includes('eth_getLogs')) fail(`retry resent a different body: ${JSON.stringify(seen)}`);
  else pass('a retry resends the identical request body');
}

console.log(failed ? '\nFAILED' : '\nRPC throttle: capped, retries rate limits, gives up, leaves other hosts alone');
process.exit(failed ? 1 : 0);
