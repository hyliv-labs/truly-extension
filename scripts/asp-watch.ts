/**
 * Watches the ASP for a label's approval, and says when it lands.
 *
 *   pnpm check:aspwatch <label>
 *
 * A deposit is on chain the moment it confirms, but it is NOT spendable until
 * 0xbow publishes a batch containing its label. That cadence is theirs, not
 * ours: measured across 43 RootUpdated events on the entrypoint, the median
 * gap is 23h, the range 1h to 145h.
 *
 * So this polls rather than guesses, and prints the real state each time:
 * whether the label is approved, and how long the ASP has been quiet.
 */

import { createPublicClient, http, parseAbiItem } from 'viem';
import { arbitrum } from 'viem/chains';

const SCOPE =
  '19314316433070648921215665277427138450050666275686107272761703472573535400848';
const ASP = 'https://api.0xbow.io/42161/public';
const ENTRYPOINT = '0x44192215FEd782896BE2CE24E0Bfbf0BF825d15E' as const;
const RPC = process.env.WXT_ARBITRUM_RPC_URL ?? 'https://arbitrum.gateway.tenderly.co';
const POLL_MS = Number(process.env.ASP_POLL_MS ?? 120_000);

const label = process.argv[2];
if (!label) {
  console.error('usage: pnpm check:aspwatch <label>');
  process.exit(2);
}

const client = createPublicClient({ chain: arbitrum, transport: http(RPC) });
const ROOT_UPDATED = parseAbiItem('event RootUpdated(uint256 _root, string _ipfsCID, uint256 _timestamp)');

async function aspLeaves(): Promise<string[]> {
  const res = await fetch(`${ASP}/mt-leaves`, { headers: { 'X-Pool-Scope': SCOPE } });
  if (!res.ok) throw new Error(`ASP mt-leaves ${res.status}`);
  const body = (await res.json()) as { aspLeaves?: unknown[] };
  return (body.aspLeaves ?? []).map(String);
}

/** Hours since the entrypoint last accepted a new ASP root. */
async function hoursSinceLastRoot(): Promise<number | null> {
  try {
    const head = await client.getBlockNumber();
    const logs = await client.getLogs({
      address: ENTRYPOINT,
      event: ROOT_UPDATED,
      fromBlock: head - 10_000_000n,
      toBlock: head,
    });
    const last = logs[logs.length - 1];
    if (!last) return null;
    const block = await client.getBlock({ blockNumber: last.blockNumber! });
    return (Date.now() / 1000 - Number(block.timestamp)) / 3600;
  } catch {
    return null;
  }
}

console.log(`watching label ${label.slice(0, 24)}…`);
console.log(`polling every ${Math.round(POLL_MS / 1000)}s. Ctrl-C to stop.\n`);

for (;;) {
  const stamp = new Date().toISOString().slice(11, 19);
  try {
    const leaves = await aspLeaves();
    if (leaves.includes(label)) {
      const quiet = await hoursSinceLastRoot();
      console.log(`[${stamp}] APPROVED — the label is in the ASP set (${leaves.length} leaves).`);
      console.log(`           Last root update ${quiet?.toFixed(1) ?? '?'}h ago. The note is now spendable.`);
      process.exit(0);
    }
    const quiet = await hoursSinceLastRoot();
    console.log(
      `[${stamp}] not yet — ${leaves.length} approved labels; ASP quiet for ${quiet?.toFixed(1) ?? '?'}h`,
    );
  } catch (error) {
    console.log(`[${stamp}] poll failed: ${(error as Error).message}`);
  }
  await new Promise((r) => setTimeout(r, POLL_MS));
}
