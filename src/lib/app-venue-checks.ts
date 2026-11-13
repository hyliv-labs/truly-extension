/**
 * Before Bring back reads an app's address: does the app still hold anything
 * for it? A supply, a debt, a position or an open order is money the address
 * does not show, and shielding "what is there" would retire the address with
 * it still inside. Each app that can hold funds has a check here; an app that
 * cannot (a swap) has none.
 *
 * A check that cannot read its source refuses rather than guessing "empty".
 */

import type { Address } from 'viem';
import type { AppVenueId } from './app-venues';

type ExitCheck = (owner: Address) => Promise<string | null>;

const CHECKS: Partial<Record<AppVenueId, ExitCheck>> = {};

export async function appExitBlocker(venue: AppVenueId, owner: Address): Promise<string | null> {
  const check = CHECKS[venue];
  return check ? check(owner) : null;
}
