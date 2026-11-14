/**
 * Railgun USDC spend rules on Arbitrum.
 *
 * The proof engine lives in railgun-run.ts and is loaded only by the offscreen
 * document. This file stays free of that import so the service worker does not
 * pull the SDK into its bundle. A caller still cannot skip the rules: the
 * quote and the unshield both go through planRailgunUnshield, and the unshield
 * amount is the grossed-up margin, never the whole private balance.
 *
 * PPOI is a broadcaster policy, not a contract rule. Truly self-broadcasts,
 * so a shield can be spent once it is in the UTXO tree. The engine is told
 * to treat those notes as spendable (see SELF_BROADCAST_SPEND_BUCKETS).
 * ShieldBlocked and Spent stay out. A balance the engine still reports as
 * pending — not scanned, or blocked — is not planned.
 */

import { USDC_ADDRESS } from './config';
import { MIN_DEPOSIT_USDC } from './lighter';

const LIGHTER_MIN_UNITS = BigInt(MIN_DEPOSIT_USDC) * 1_000_000n;

/** Railgun proxy on Arbitrum. From @railgun-community/shared-models network-config. */
export const RAILGUN_PROXY_ARBITRUM = '0xFA7093CDD9EE6932B4eb2c9e1cde7CE00B1FA4b9';

export const RAILGUN_USDC = USDC_ADDRESS;

/**
 * Buckets a self-broadcast may spend. There is no age check. Spendable is the
 * PPOI-valid set; the others are in the tree with no completed PPOI proof.
 * ShieldBlocked and Spent are intentionally absent.
 */
export const SELF_BROADCAST_SPEND_BUCKETS = [
  'Spendable',
  'ShieldPending',
  'MissingExternalPOI',
  'MissingInternalPOI',
  'ProofSubmitted',
] as const;

export class RailgunFundingError extends Error {
  readonly code: 'pending-ppoi' | 'insufficient';

  constructor(code: RailgunFundingError['code'], message: string) {
    super(message);
    this.name = 'RailgunFundingError';
    this.code = code;
  }
}

export interface RailgunUnshieldPlan {
  readonly spendUnits: bigint;
  readonly feeUnits: bigint;
  readonly netUnits: bigint;
}

/**
 * Spend the shielded balance as soon as the engine can see it. Age is not a
 * rule. `pendingUnits` is balance that is not in the tree yet, and it is never
 * spent, even when it would cover the trade.
 */
export function planRailgunUnshield(input: {
  spendableUnits: bigint;
  pendingUnits: bigint;
  desiredNetUnits: bigint;
  feeUnits: bigint;
}): RailgunUnshieldPlan {
  if (input.desiredNetUnits < LIGHTER_MIN_UNITS) {
    throw new RailgunFundingError(
      'insufficient',
      'The trade is below the Lighter deposit minimum.',
    );
  }
  if (input.feeUnits < 0n || input.spendableUnits < 0n || input.pendingUnits < 0n) {
    throw new RailgunFundingError('insufficient', 'The Railgun fee cannot be negative.');
  }

  const netUnits = input.spendableUnits - input.feeUnits;

  if (netUnits < input.desiredNetUnits) {
    if (input.pendingUnits > 0n && input.spendableUnits + input.pendingUnits - input.feeUnits >= input.desiredNetUnits) {
      throw new RailgunFundingError(
        'pending-ppoi',
        'This Railgun balance is not spendable yet. The shield has to finish syncing into the tree before Ghosty can self-broadcast it.',
      );
    }
    throw new RailgunFundingError(
      'insufficient',
      'Not enough Railgun USDC to fund this trade.',
    );
  }

  return {
    spendUnits: input.spendableUnits,
    feeUnits: input.feeUnits,
    netUnits,
  };
}

/**
 * Smallest amount to put on the unshield so that, after `feeBps` is taken out
 * of it, at least `netUnits` remains. Basis points, same unit Railgun publishes
 * (25 = 0.25%).
 */
/**
 * USDC to shield on the way back, after reserving the Circle paymaster allowance.
 *
 * The paymaster pulls USDC before the shield runs, and only the actual gas
 * plus its surcharge — the reserve is a ceiling. What it does not take stays
 * at the owner. Shielding the whole balance would leave the operation unable
 * to pay for itself.
 */
export function railgunShieldAfterGasReserve(balance: bigint, gasReserve: bigint): bigint {
  if (gasReserve <= 0n) {
    throw new RailgunFundingError('insufficient', 'The Railgun return needs a USDC gas reserve.');
  }
  if (balance <= gasReserve) {
    throw new RailgunFundingError(
      'insufficient',
      'The USDC at this owner does not cover the gas reserve, so it was not shielded.',
    );
  }
  return balance - gasReserve;
}

export function railgunGrossForNet(netUnits: bigint, feeBps: bigint): bigint {
  if (netUnits <= 0n) {
    throw new RailgunFundingError('insufficient', 'The Railgun unshield amount must be positive.');
  }
  if (feeBps < 0n || feeBps >= 10_000n) {
    throw new RailgunFundingError('insufficient', 'The Railgun fee is not a usable rate.');
  }
  const keep = 10_000n - feeBps;
  return (netUnits * 10_000n + keep - 1n) / keep;
}
