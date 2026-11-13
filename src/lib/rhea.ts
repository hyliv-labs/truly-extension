/**
 * Rhea Finance (NEAR): the DEX and the Burrow lending market behind
 * app.rhea.finance. Bring back refuses while any of them holds something for
 * the NEAR owner account. Contract ids are those in Rhea's live app config
 * (REF_FI_CONTRACT_ID, REF_DCL_SWAP_CONTRACT_ID, BURROW_CONTRACT_ID, ...),
 * and every view below was called on mainnet before it was written down.
 */

import { nearView } from './near-chain';

export const RHEA_APP = 'https://app.rhea.finance/';

const BURROW = 'contract.main.burrow.near';
const MEME_BURROW = 'meme-burrow.ref-labs.near';
const REF_EXCHANGE = 'v2.ref-finance.near';
const REF_DCL = 'dclv2.ref-labs.near';
const BOOST_FARM = 'boostfarm.ref-labs.near';
const XRHEA = 'xtoken.rhealab.near';

const positive = (value: unknown): boolean => {
  if (typeof value !== 'string' && typeof value !== 'number') return false;
  try {
    return BigInt(String(value).split('.')[0] ?? '0') > 0n;
  } catch {
    return false;
  }
};

/**
 * Anything held in a Burrow account: supplied, collateral or borrowed rows
 * with a balance, positions maps with an amount, or staked booster. Shapes
 * we do not recognise count as held: refusing is the safe reading.
 */
export function burrowHolds(account: unknown): string[] {
  if (account === null) return [];
  if (typeof account !== 'object') return ['an account Ghosty cannot read'];
  const held: string[] = [];
  const walk = (value: unknown, path: string) => {
    if (Array.isArray(value)) {
      for (const row of value) {
        if (row && typeof row === 'object' && 'token_id' in row) {
          if (positive((row as { balance?: unknown }).balance)) held.push(`${path} ${(row as { token_id: string }).token_id}`);
        } else walk(row, path);
      }
      return;
    }
    if (value && typeof value === 'object') {
      for (const [key, inner] of Object.entries(value)) {
        if (key === 'apr' || key === 'shares' || key === 'account_id' || key === 'unlock_timestamp' || key === 'farms' || key === 'has_non_farmed_assets' || key === 'is_locked') continue;
        if (typeof inner === 'string' || typeof inner === 'number') {
          if (positive(inner)) held.push(`${path} ${key}`);
        } else walk(inner, key === 'supplied' || key === 'collateral' || key === 'borrowed' ? key : path);
      }
    }
  };
  for (const key of ['supplied', 'collateral', 'borrowed', 'positions', 'booster_staking', 'booster_stakings']) {
    if (key in (account as Record<string, unknown>)) walk((account as Record<string, unknown>)[key], key);
  }
  return held;
}

export function mapHolds(map: unknown, label: string): string[] {
  if (map === null) return [];
  if (typeof map !== 'object' || Array.isArray(map)) return [`${label}: an answer Ghosty cannot read`];
  return Object.entries(map as Record<string, unknown>)
    .filter(([, amount]) => typeof amount !== 'string' || positive(amount))
    .map(([token]) => `${label} ${token}`);
}

/**
 * Why Bring back must wait, or null when Rhea holds nothing for the account.
 * Any failed read refuses: an unreadable position is not an empty one.
 */
export async function rheaExitBlocker(accountId: string): Promise<string | null> {
  const id = { account_id: accountId };
  let reads: [unknown, unknown, unknown, unknown, unknown, unknown, unknown, unknown, unknown];
  try {
    reads = await Promise.all([
      nearView(BURROW, 'get_account', id),
      nearView(BURROW, 'get_margin_account', id),
      nearView(MEME_BURROW, 'get_account', id),
      nearView(REF_EXCHANGE, 'get_deposits', id),
      nearView(REF_DCL, 'list_liquidities', id),
      nearView(REF_DCL, 'list_user_assets', id),
      nearView(REF_DCL, 'list_active_orders', id),
      nearView(BOOST_FARM, 'list_farmer_seeds', { farmer_id: accountId }),
      nearView(XRHEA, 'ft_balance_of', id),
    ]);
  } catch (error) {
    return `Ghosty could not read Rhea for this account (${error instanceof Error ? error.message : String(error)}). Nothing was moved; try again.`;
  }
  const [burrow, margin, meme, deposits, liquidities, assets, orders, seeds, xrhea] = reads;
  const held = [
    ...burrowHolds(burrow).map((row) => `Burrow ${row}`),
    ...(margin === null ? [] : ['a Burrow margin account']),
    ...burrowHolds(meme).map((row) => `Meme Burrow ${row}`),
    ...mapHolds(deposits, 'Rhea exchange balance'),
    ...(Array.isArray(liquidities) && liquidities.length === 0 ? [] : ['a concentrated-liquidity position']),
    ...mapHolds(assets, 'DCL balance'),
    ...(Array.isArray(orders) && orders.length === 0 ? [] : ['an open limit order']),
    ...mapHolds(seeds, 'farm'),
    ...(positive(xrhea) ? ['xRHEA'] : []),
  ];
  if (held.length === 0) return null;
  return `Rhea still holds funds for this account: ${held.slice(0, 4).join(', ')}${held.length > 4 ? '…' : ''}. Withdraw, repay and close them on Rhea first. Nothing was moved.`;
}
