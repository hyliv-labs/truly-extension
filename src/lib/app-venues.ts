/**
 * Apps that work like Compound: a fresh address is funded from Railgun with
 * USDC and a little ETH, the user acts on the app's own site with Ghosty as
 * the wallet, and Bring back shields what the address holds once the app
 * holds nothing for it.
 *
 * One table, so adding an app is a row here, a position check (if the app
 * can hold funds), its hosts in the manifest, and a logo. Pure: no chrome,
 * no network. The worker half is app-venue-private.ts.
 */

import type { Address } from 'viem';
import { AAVE_APP } from './aave';
import { DYDX_APP } from './dydx';

/** Lido's wstETH on Arbitrum (docs.lido.fi deployed contracts; read live: wstETH, 18 decimals). */
export const WSTETH_ARBITRUM: Address = '0x5979D7b546E38E414F7E9822514be443A4800529';

export const APP_VENUE_IDS = ['oneinch', 'aave', 'dydx', 'lido'] as const;
export type AppVenueId = (typeof APP_VENUE_IDS)[number];

export interface AppVenueSpec {
  readonly id: AppVenueId;
  readonly name: string;
  /** Where "Open <name>" goes. */
  readonly url: string;
  /** Registrable domains. A host matches the domain itself or any subdomain. */
  readonly domains: readonly string[];
  /** Match patterns for the manifest, the content script and tab queries. Must mirror `domains`. */
  readonly tabPatterns: readonly string[];
  readonly minUnits: bigint;
  /** The verb on the ready screen: "Swap as usual." */
  readonly ready: string;
  /** What the address should hold in ETH after funding, for the app's own transactions. */
  readonly gasWei: bigint;
  /** Bring back: what the user does on the app first. */
  readonly doThere: string;
  readonly returnBlurb: string;
  /** Shown once the address is funded. */
  readonly fundedDetail: string;
  /**
   * Funded in something other than USDC: a NEAR Intents exit from Railgun
   * delivers this asset to the fresh address. Lido stakes ETH, and the
   * address holding ETH that no earlier address sent keeps it unlinked.
   */
  readonly fundVia?: { readonly intentsAssetId: string; readonly symbol: string; readonly decimals: number };
  /** Shown on Go ghost before funding: something the user must know first. */
  readonly caution?: string;
  /** Tokens this app hands out that Bring back should look for, beyond the usual ones. */
  readonly extraTokens?: readonly { readonly address: Address; readonly symbol: string; readonly decimals: number }[];
}

const GAS_WEI = 100_000_000_000_000n;

export const APP_VENUES: Record<AppVenueId, AppVenueSpec> = {
  oneinch: {
    id: 'oneinch',
    name: '1inch',
    // app.1inch.io now redirects here (301).
    url: 'https://1inch.com/swap',
    domains: ['1inch.io', '1inch.com'],
    tabPatterns: ['https://*.1inch.io/*', 'https://*.1inch.com/*'],
    minUnits: 1_000_000n,
    ready: 'Swap',
    gasWei: GAS_WEI,
    doThere: 'Finish the swap',
    returnBlurb:
      'When you finish on 1inch, this reads the address and shields USDC, WETH, USDT, DAI, ARB and anything else it received. A token Railgun cannot take stays there, and gets named.',
    fundedDetail: 'USDC is on this address. Swap on 1inch with Ghosty as the wallet, on Arbitrum. Truly does not swap for you.',
  },
  aave: {
    id: 'aave',
    name: 'Aave',
    url: AAVE_APP,
    domains: ['aave.com'],
    tabPatterns: ['https://*.aave.com/*'],
    minUnits: 1_000_000n,
    ready: 'Supply',
    gasWei: GAS_WEI,
    doThere: 'Repay and withdraw',
    returnBlurb:
      'Repay any borrow and withdraw your supply on Aave first. This will not shield while any supply or debt is still open in an Aave market.',
    fundedDetail: 'USDC is on this address. Supply or borrow on Aave’s Arbitrum market with Ghosty as the wallet. Repay and withdraw there before bringing it back.',
  },
  dydx: {
    id: 'dydx',
    name: 'dYdX',
    url: DYDX_APP,
    domains: ['dydx.trade'],
    tabPatterns: ['https://*.dydx.trade/*'],
    // dYdX's deposit route (CCTP through Noble) has its own minimum and fees; 5 keeps clear of them.
    minUnits: 5_000_000n,
    ready: 'Trade',
    gasWei: GAS_WEI,
    doThere: 'Close, then withdraw to Arbitrum',
    returnBlurb:
      'Close your positions on dYdX and Withdraw to Arbitrum, to this same address. Withdrawals take about 20 minutes to land. This will not shield while anything is still on dYdX, in its wallet, or on the way.',
    fundedDetail:
      'USDC is on this address. On dydx.trade connect Ghosty, sign dYdX’s onboarding message, and Deposit from Arbitrum. To come back, Withdraw to Arbitrum to this same address.',
    caution:
      'dYdX’s v9.9 upgrade (planned for 17 Nov 2026) moves its USDC to Injective, and its docs say withdrawals to other chains are rejected after it. Ghosty has not verified that Withdraw to Arbitrum still works afterwards. Fund only what you will bring back before then.',
  },
  lido: {
    id: 'lido',
    name: 'Lido',
    url: 'https://stake.lido.fi/',
    domains: ['lido.fi'],
    tabPatterns: ['https://*.lido.fi/*'],
    minUnits: 5_000_000n,
    ready: 'Stake',
    // Funded in ETH, which pays its own gas: no top-up from an earlier address.
    gasWei: 0n,
    doThere: 'Stake for wstETH',
    returnBlurb:
      'Stake on Lido first, or don’t: this shields the wstETH, and any ETH left over as WETH. wstETH keeps earning inside your private balance.',
    fundedDetail:
      'ETH is on this address, delivered by NEAR Intents. On stake.lido.fi (Arbitrum) connect Ghosty and Stake: you get wstETH. Bring back shields it.',
    fundVia: { intentsAssetId: 'nep141:arb.omft.near', symbol: 'ETH', decimals: 18 },
    extraTokens: [{ address: WSTETH_ARBITRUM, symbol: 'wstETH', decimals: 18 }],
  },
};

export function isAppVenue(value: unknown): value is AppVenueId {
  return typeof value === 'string' && (APP_VENUE_IDS as readonly string[]).includes(value);
}

export function appVenueFromHost(host: string): AppVenueId | null {
  const lower = host.toLowerCase();
  for (const id of APP_VENUE_IDS) {
    if (APP_VENUES[id].domains.some((domain) => lower === domain || lower.endsWith(`.${domain}`))) return id;
  }
  return null;
}

export type AppAccountStatus = 'funding' | 'funded' | 'shielding' | 'done' | 'failed';

export interface AppTokenLine {
  readonly token: string;
  readonly symbol: string;
  readonly amount: string;
  readonly txHash?: string;
  readonly reason?: string;
}

/** Saved on the trade. Same shape as Compound's, so the screens treat them alike. */
export interface AppAccountView {
  readonly status: AppAccountStatus;
  readonly detail: string;
  readonly amountIn: string;
  readonly ownerAddress?: string;
  readonly unshieldTx?: string;
  readonly shielded?: AppTokenLine[];
  readonly left?: AppTokenLine[];
  readonly error?: string;
  /** Funding through a NEAR Intents exit (fundVia): which move, and the least it delivers. */
  readonly viaIntents?: { readonly correlationId: string; readonly minOut: string };
}

/**
 * Lido: refuse while a stake may still be on its way. ETH mostly gone from
 * the address (it was staked) with no wstETH yet means the slow route.
 */
export function lidoExitBlocker(held: { funded: bigint; eth: bigint; wst: bigint }): string | null {
  if (held.wst === 0n && held.eth * 2n < held.funded) {
    return 'The ETH left this address and no wstETH has arrived yet. Lido’s slower route takes several minutes; bring it back once wstETH shows. Nothing was moved.';
  }
  return null;
}
