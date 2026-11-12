/**
 * Hyperliquid's public API, called straight from the worker. Kept apart from
 * hyperliquid-private.ts so the recovery scan can read accounts without
 * pulling in the Railgun client.
 */

import type { Address } from 'viem';
import { HYPERLIQUID_API, readAbstraction, readAccount, usdcUnitsFromDecimal, type HyperliquidAccount, type LedgerRow } from './hyperliquid';

/** The address's Hyperliquid account: perp state, spot balances and open orders. */
export async function readHyperliquid(user: Address): Promise<HyperliquidAccount> {
  const [perp, spot, orders, mode] = await Promise.all([
    postHyperliquid('/info', { type: 'clearinghouseState', user }),
    postHyperliquid('/info', { type: 'spotClearinghouseState', user }),
    postHyperliquid('/info', { type: 'openOrders', user }),
    postHyperliquid('/info', { type: 'userAbstraction', user }).catch(() => 'unknown'),
  ]);
  return readAccount(perp, spot, orders, readAbstraction(mode));
}

/** Deposits, transfers and withdrawals since `startTime`. Throws if Hyperliquid did not answer with a list. */
export async function readLedger(user: Address, startTime: number): Promise<LedgerRow[]> {
  const rows = await postHyperliquid('/info', { type: 'userNonFundingLedgerUpdates', user, startTime: Math.max(0, Math.floor(startTime)) });
  if (!Array.isArray(rows)) throw new Error('Hyperliquid did not return its ledger. Nothing was retired; try again.');
  return rows as LedgerRow[];
}

/**
 * The two cheap reads (weight 2 each), for scanning many addresses without
 * hitting Hyperliquid's per-IP limit. Null when the read failed, so a scan
 * can say so instead of showing an empty account.
 */
export async function readHyperliquidBalance(user: Address): Promise<{ usdc: bigint; positions: number; tokens: string[] } | null> {
  try {
    const [perp, spot] = (await Promise.all([
      postHyperliquid('/info', { type: 'clearinghouseState', user }),
      postHyperliquid('/info', { type: 'spotClearinghouseState', user }),
    ])) as [{ marginSummary?: { accountValue?: string }; assetPositions?: { position?: { szi?: string } }[] }, { balances?: { coin?: string; total?: string }[] }];
    if (!perp || typeof perp !== 'object' || !spot || typeof spot !== 'object') return null;
    const balances = spot.balances ?? [];
    const spotUsdc = usdcUnitsFromDecimal(balances.find((row) => row.coin === 'USDC')?.total ?? '0');
    const perpValue = usdcUnitsFromDecimal(perp.marginSummary?.accountValue ?? '0');
    return {
      // A unified account shows the same USDC in both; the larger is the account.
      usdc: perpValue > spotUsdc ? perpValue : spotUsdc,
      positions: (perp.assetPositions ?? []).filter((row) => Number(row.position?.szi ?? '0') !== 0).length,
      tokens: balances.filter((row) => row.coin && row.coin !== 'USDC' && Number(row.total ?? '0') > 0).map((row) => row.coin!),
    };
  } catch {
    return null;
  }
}

export async function postHyperliquid(path: '/info' | '/exchange', body: unknown): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(`${HYPERLIQUID_API}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { status: 'err', response: text };
    }
    if (!response.ok && path === '/info') throw new Error(`Hyperliquid answered ${response.status}.`);
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}
