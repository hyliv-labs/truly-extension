/**
 * Hyperliquid's public API, called straight from the worker. Kept apart from
 * hyperliquid-private.ts so the recovery scan can read accounts without
 * pulling in the Railgun client.
 */

import type { Address } from 'viem';
import { HYPERLIQUID_API, readAbstraction, readAccount, type HyperliquidAccount } from './hyperliquid';

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
