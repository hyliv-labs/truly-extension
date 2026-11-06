/**
 * Exercises the relayer's read-only endpoints: /relayer/details and
 * /relayer/quote. No funds, no proof, no submission.
 *
 * The quote matters structurally, not just for the fee: the withdrawal's
 * context is keccak(withdrawal, SCOPE), and the withdrawal data carries the
 * relayer's fee terms. So the quote must come BEFORE proving -- a fee agreed
 * afterwards would change the context and the pool would revert with
 * ContextMismatch.
 *
 * Network-bound, so it is not part of `pnpm check`.
 */

const BASE = process.env.WXT_PRIVACY_POOL_RELAYER_URL ?? 'https://fastrelay.xyz';
const CHAIN_ID = 42161;
const USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const RECIPIENT = '0x000000000000000000000000000000000000dEaD';

let failed = false;
const fail = (m: string) => {
  console.error('FAIL', m);
  failed = true;
};
const pass = (m: string) => console.log('pass', m);

const show = (v: unknown) => JSON.stringify(v, null, 2).split('\n').slice(0, 24).join('\n');

try {
  const detailsUrl = `${BASE}/relayer/details?chainId=${CHAIN_ID}&assetAddress=${USDC}`;
  const dRes = await fetch(detailsUrl);
  if (!dRes.ok) {
    fail(`/relayer/details returned ${dRes.status}`);
  } else {
    const details = (await dRes.json()) as Record<string, unknown>;
    pass(`/relayer/details: feeBPS=${details.feeBPS} minWithdraw=${details.minWithdrawAmount}`);
    if (String(details.feeBPS) !== '10') {
      fail(`details.feeBPS is ${details.feeBPS}, not the 10 BPS recorded in config.ts`);
    } else {
      pass('details.feeBPS is 10 — but that is only the BASE fee; see the quotes below');
    }
    console.log(show(details));
  }

  // Quote. The exact body shape is not documented; send the plausible one and
  // let the relayer's own validation describe what it wants. A 4xx with a
  // field-level message is a SUCCESSFUL probe -- it means the route exists and
  // validates, which is what we need to know before building the real call.
  const amount = '10000000'; // 10 USDC
  const body = {
    chainId: CHAIN_ID,
    amount,
    asset: USDC,
    recipient: RECIPIENT,
    extraGas: false,
  };
  const qRes = await fetch(`${BASE}/relayer/quote`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await qRes.text();
  console.log(`\n/relayer/quote -> HTTP ${qRes.status}`);
  console.log(text.slice(0, 1200));

  if (qRes.status === 404) {
    fail('/relayer/quote does not exist at this base URL');
  } else if (qRes.ok) {
    pass('/relayer/quote accepted the request and returned a quote');
    const quote = JSON.parse(text) as Record<string, unknown>;
    const keys = Object.keys(quote);
    pass(`quote fields: ${keys.join(', ')}`);

    // THE QUOTE'S TTL SETS THE E3 STEP ORDER. Everything between quoting and
    // submitting has to fit inside it: computing the context, fetching the ASP
    // tree, and in-browser proving (~2.5s). Anything that does NOT depend on
    // the quote must happen BEFORE it, or a slow Tor fetch expires the quote.
    const commitment = quote.feeCommitment as { expiration?: number } | undefined;
    if (typeof commitment?.expiration === 'number') {
      const ttlMs = commitment.expiration - Date.now();
      const ttlSec = Math.round(ttlMs / 1000);
      pass(`feeCommitment TTL is ${ttlSec}s (expiration ${commitment.expiration})`);
      if (ttlSec < 30) {
        fail(`a ${ttlSec}s TTL is too short to fetch the ASP tree over Tor and prove`);
      } else {
        console.log(
          `  => quote LAST, after the ASP tree and the latestRoot() check.\n` +
            `     Proving is ~2.5s, so ${ttlSec}s is workable only if nothing\n` +
            `     network-bound sits between the quote and the request.`,
        );
      }
    } else {
      fail('the quote has no feeCommitment.expiration — its TTL is unknown');
    }
    // The fee commitment is what must be folded into the withdrawal data
    // before the context is computed.
    if (!keys.some((k) => k.toLowerCase().includes('commitment'))) {
      console.log(
        '  NOTE: no *commitment field. Check whether feeCommitment is optional for this relayer.',
      );
    }
  } else {
    // Still informative: the schema error names the fields.
    pass(`route exists and validates (HTTP ${qRes.status}); the error names the required fields`);
  }

  // THE FEE IS NOT 10 BPS. details.feeBPS is a BASE rate; the quote adds the
  // relay transaction's gas, which is a FIXED cost. So the effective rate
  // grows as the withdrawal shrinks, and a small re-shield can be eaten alive.
  // Measure the curve rather than assuming a constant.
  console.log('\n  effective relayer fee by withdrawal size:');
  const rows: Array<{ usdc: number; bps: number; cost: number }> = [];
  for (const usdc of [5, 10, 25, 50, 100, 250]) {
    const res = await fetch(`${BASE}/relayer/quote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, amount: String(usdc * 1_000_000) }),
    });
    if (!res.ok) {
      console.log(`    ${usdc} USDC -> HTTP ${res.status}`);
      continue;
    }
    const q = (await res.json()) as { feeBPS: string; baseFeeBPS: string };
    const bps = Number(q.feeBPS);
    const cost = (usdc * bps) / 10_000;
    rows.push({ usdc, bps, cost });
    console.log(
      `    ${String(usdc).padStart(3)} USDC -> ${String(bps).padStart(4)} BPS = $${cost.toFixed(3)}` +
        ` (base ${q.baseFeeBPS})`,
    );
  }

  const worst = rows[0];
  const best = rows[rows.length - 1];
  if (worst && best && worst.bps > best.bps) {
    pass('fee is fixed-cost dominated: the rate falls as the withdrawal grows');
    console.log(
      `  => RELAYER_FEE_BPS must not be a constant. At the 5 USDC floor it is\n` +
        `     ${worst.bps} BPS, ${(worst.bps / best.bps).toFixed(1)}x the rate at ${best.usdc} USDC.`,
    );
  }
  if (worst && worst.bps > 100) {
    fail(
      `at the ${worst.usdc} USDC pool minimum the relayer takes ${worst.bps} BPS ` +
        `($${worst.cost.toFixed(2)}) — sizing must account for this`,
    );
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

process.exit(failed ? 1 : 0);
