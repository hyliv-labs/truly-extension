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

export const APP_VENUE_IDS = ['oneinch', 'aave'] as const;
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
  /** Tokens this app hands out that Bring back should look for, beyond the usual ones. */
  readonly extraTokens?: readonly { readonly address: Address; readonly symbol: string; readonly decimals: number }[];
}

const GAS_WEI = 100_000_000_000_000n;

export const APP_VENUES: Record<AppVenueId, AppVenueSpec> = {
  oneinch: {
    id: 'oneinch',
    name: '1inch',
    url: 'https://app.1inch.io/swap?src=42161:USDC',
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
}
