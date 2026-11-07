/**
 * Compound III on Arbitrum. The user supplies on app.compound.xyz.
 * Truly does not supply, borrow, or withdraw.
 *
 * A supply is not a token in the wallet. It sits inside the Comet market, so
 * Shield back has to see an empty position before it reads the address.
 * The four markets below are the Arbitrum deployments: base token and reward
 * config were read from chain.
 */

import { type Address } from 'viem';

export const COMPOUND_APP = 'https://app.compound.xyz/?market=usdc-arb';

export const COMPOUND_REWARDS: Address = '0x88730d254A2f7e6AC8388c3198aFd694bA9f7fae';

export const COMPOUND_MARKETS: readonly { readonly comet: Address; readonly label: string }[] = [
  { comet: '0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf', label: 'USDC' },
  { comet: '0xA5EDBDD9646f8dFF606d7448e414884C7d905dCA', label: 'USDC.e' },
  { comet: '0xd98Be00b5D27fc98112BdE293e487f8D4cA57d07', label: 'USDT' },
  { comet: '0x6f7D514bbD4aFf3BcD1140B7344b32f063dEe486', label: 'WETH' },
];

export type CompoundAccountStatus = 'funding' | 'funded' | 'shielding' | 'done' | 'failed';

export interface CompoundTokenLine {
  readonly token: string;
  readonly symbol: string;
  readonly amount: string;
  readonly txHash?: string;
  readonly reason?: string;
}

/** Saved on the active trade. A retry continues from this, it does not fund twice. */
export interface CompoundAccountView {
  readonly status: CompoundAccountStatus;
  readonly detail: string;
  readonly amountIn: string;
  readonly ownerAddress?: string;
  readonly unshieldTx?: string;
  readonly shielded?: CompoundTokenLine[];
  readonly left?: CompoundTokenLine[];
  readonly error?: string;
}
