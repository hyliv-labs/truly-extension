/**
 * Tokens a Uniswap session on Arbitrum can bring back into Railgun.
 *
 * The user picks the pair on app.uniswap.org. Truly does not quote or send
 * the swap. On the way back it looks at these tokens, plus any ERC-20 that
 * was transferred to the fresh address after the unshield. A token the
 * Railgun proxy will not shield is reported and left on the address.
 */

import type { Address } from 'viem';

/** Arbitrum WETH. Native ETH is wrapped into this before it can be shielded. */
export const WETH_ADDRESS: Address = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1';

export interface ShieldableToken {
  readonly address: Address;
  readonly symbol: string;
  readonly decimals: number;
}

export const RAILGUN_RETURN_TOKENS: readonly ShieldableToken[] = [
  { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', symbol: 'USDC', decimals: 6 },
  { address: WETH_ADDRESS, symbol: 'WETH', decimals: 18 },
  { address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', symbol: 'USDT', decimals: 6 },
  { address: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', symbol: 'DAI', decimals: 18 },
  { address: '0x912CE59144191C1204E64559FE8253a0e49E6548', symbol: 'ARB', decimals: 18 },
];

export type UniswapAccountStatus = 'funding' | 'funded' | 'shielding' | 'done' | 'failed';

export interface UniswapTokenLine {
  readonly token: string;
  readonly symbol: string;
  readonly amount: string;
  readonly txHash?: string;
  readonly reason?: string;
}

/** Saved on the active trade. A retry continues from this, it does not fund twice. */
export interface UniswapAccountView {
  readonly status: UniswapAccountStatus;
  readonly detail: string;
  readonly amountIn: string;
  readonly ownerAddress?: string;
  readonly unshieldTx?: string;
  readonly shielded?: UniswapTokenLine[];
  readonly left?: UniswapTokenLine[];
  readonly error?: string;
}
