/**
 * Hyperliquid, reached through its Arbitrum bridge. The user trades on
 * app.hyperliquid.xyz with the fresh address as the connected wallet.
 *
 * Funding: Railgun unshields USDC onto the fresh address, and that address
 * sends it to Bridge2. The bridge credits whoever SENT the USDC, which is why
 * the unshield can never go to the bridge directly: the sender would be the
 * Railgun contract, and the deposit would be credited to nobody we control.
 *
 * Bring back: the fresh address signs a `withdraw3` to itself (no gas, a flat
 * 1 USDC fee kept by Hyperliquid), the USDC lands on Arbitrum a few minutes
 * later, and it is shielded into Railgun like any other venue.
 *
 * Everything here is pure: building and checking actions, reading the API's
 * answers. The worker half that moves money is hyperliquid-private.ts.
 */

import type { Address } from 'viem';

export const HYPERLIQUID_APP = 'https://app.hyperliquid.xyz/trade';
export const HYPERLIQUID_API = 'https://api.hyperliquid.xyz';

/**
 * Bridge2 on Arbitrum One. A USDC transfer here credits the sender's
 * Hyperliquid account. Hyperliquid's docs now call it the legacy bridge and
 * prefer CCTP, but app.hyperliquid.xyz still deposits Arbitrum USDC through
 * this contract (read from its bundle, 2026-11-12), so it is the same path the
 * site's own Deposit button takes.
 */
export const HYPERLIQUID_BRIDGE: Address = '0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7';

/** Hyperliquid's minimum deposit. Less than this is NOT credited and is lost. */
export const HYPERLIQUID_MIN_DEPOSIT_UNITS = 5_000_000n;
/**
 * What Go ghost asks for at least. One USDC over the bridge minimum, so a
 * withdrawal (1 USDC fee) still has something to bring back.
 */
export const HYPERLIQUID_MIN_FUND_UNITS = 6_000_000n;
/** Kept by Hyperliquid on every withdrawal to Arbitrum. */
export const HYPERLIQUID_WITHDRAW_FEE_UNITS = 1_000_000n;

/**
 * User-signed actions carry the chain the wallet signed on. Arbitrum One,
 * the chain this extension always reports.
 */
export const HYPERLIQUID_SIGNATURE_CHAIN_ID = 42161;

export type HyperliquidAccountStatus = 'funding' | 'funded' | 'shielding' | 'done' | 'failed';

export type HyperliquidStep =
  /** Funding: the Railgun proof and unshield onto the fresh address. */
  | 'unshielding'
  /** Funding: the USDC transfer to Bridge2 is being sent. */
  | 'bridging'
  /** Funding: the transfer landed; waiting for Hyperliquid to credit it. */
  | 'crediting'
  /** Bring back: the withdraw3 action is being signed and sent. */
  | 'withdrawing'
  /** Bring back: Hyperliquid accepted it; waiting for USDC on Arbitrum. */
  | 'arriving'
  /** Bring back: the USDC is on the address and is going into Railgun. */
  | 'shielding';

export interface HyperliquidTokenLine {
  readonly token: string;
  readonly symbol: string;
  readonly amount: string;
  readonly txHash?: string;
  readonly reason?: string;
}

/**
 * The withdrawal, saved BEFORE it is sent. A retry resends these exact
 * fields (same nonce), so Hyperliquid can never process two withdrawals for
 * one click, and a worker restart in the middle knows what it is waiting for.
 */
export interface HyperliquidWithdrawal {
  /** The signed action's `time`, also the request nonce. */
  readonly nonce: number;
  /** Decimal USDC string, exactly as signed. */
  readonly amount: string;
  /** The address's USDC on Arbitrum before the withdrawal, in units. */
  readonly arbitrumBefore: string;
  readonly signature?: { readonly r: string; readonly s: string; readonly v: number };
  readonly acceptedAt?: number;
}

/** Saved on the active trade. A retry continues from this, it does not fund or withdraw twice. */
export interface HyperliquidAccountView {
  readonly status: HyperliquidAccountStatus;
  readonly step?: HyperliquidStep;
  readonly detail: string;
  readonly amountIn: string;
  readonly ownerAddress?: string;
  readonly unshieldTx?: string;
  /** The USDC transfer to Bridge2. Written before broadcast, so it is sent once. */
  readonly depositTx?: string;
  /** Signed deposit bytes, resent as-is on a retry. Never re-signed with a new nonce. */
  readonly depositRaw?: string;
  /** Hyperliquid's USDC total for the address before the deposit, in units. */
  readonly creditBefore?: string;
  /** Set once Hyperliquid showed the deposit. From then on funding never runs again. */
  readonly creditedAt?: number;
  readonly withdrawal?: HyperliquidWithdrawal;
  /** Which half a 'failed' status belongs to: Try again on Go ghost, or on Bring back. */
  readonly failedIn?: 'funding' | 'shielding';
  readonly shielded?: HyperliquidTokenLine[];
  readonly left?: HyperliquidTokenLine[];
  readonly error?: string;
}

/* --------------------------------------------------------------- Amounts */

/** "12.345678" (Hyperliquid's decimal USDC) -> 12345678 units. Extra digits are dropped, never rounded up. */
export function usdcUnitsFromDecimal(value: string | number | null | undefined): bigint {
  const text = String(value ?? '0').trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) throw new Error(`Hyperliquid returned an amount that is not a number: ${text}`);
  const negative = text.startsWith('-');
  const [whole, frac = ''] = text.replace('-', '').split('.');
  const units = BigInt(whole!) * 1_000_000n + BigInt(frac.slice(0, 6).padEnd(6, '0'));
  return negative ? -units : units;
}

/** 12345678 units -> "12.345678", trailing zeros trimmed. The form the withdraw action signs. */
export function usdcDecimalFromUnits(units: bigint): string {
  if (units < 0n) throw new Error('A withdrawal amount cannot be negative.');
  const whole = units / 1_000_000n;
  const frac = (units % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}

/* ---------------------------------------------------------------- Actions */

/** Field order matters: it is the order the EIP-712 types list. */
export interface Withdraw3Action {
  readonly type: 'withdraw3';
  readonly hyperliquidChain: 'Mainnet';
  readonly signatureChainId: string;
  readonly destination: string;
  readonly amount: string;
  readonly time: number;
}

export function withdrawAction(destination: Address, amount: string, time: number): Withdraw3Action {
  if (!/^0x[0-9a-fA-F]{40}$/.test(destination)) throw new Error('The withdrawal destination is not an address.');
  if (!/^\d+(\.\d{1,6})?$/.test(amount)) throw new Error('The withdrawal amount must be a decimal with at most 6 places.');
  if (usdcUnitsFromDecimal(amount) <= HYPERLIQUID_WITHDRAW_FEE_UNITS) {
    throw new Error('Hyperliquid keeps 1 USDC on every withdrawal, so less than that cannot be brought back.');
  }
  return {
    type: 'withdraw3',
    hyperliquidChain: 'Mainnet',
    signatureChainId: `0x${HYPERLIQUID_SIGNATURE_CHAIN_ID.toString(16)}`,
    // Hyperliquid compares addresses lower-case; the signed string must match what it rebuilds.
    destination: destination.toLowerCase(),
    amount,
    time,
  };
}

/** The EIP-712 payload the fresh address signs for a withdrawal. */
export function withdrawTypedData(action: Withdraw3Action) {
  return {
    domain: {
      name: 'HyperliquidSignTransaction',
      version: '1',
      chainId: Number.parseInt(action.signatureChainId, 16),
      verifyingContract: '0x0000000000000000000000000000000000000000' as Address,
    },
    types: {
      'HyperliquidTransaction:Withdraw': [
        { name: 'hyperliquidChain', type: 'string' },
        { name: 'destination', type: 'string' },
        { name: 'amount', type: 'string' },
        { name: 'time', type: 'uint64' },
      ],
    },
    primaryType: 'HyperliquidTransaction:Withdraw' as const,
    message: {
      hyperliquidChain: action.hyperliquidChain,
      destination: action.destination,
      amount: action.amount,
      time: BigInt(action.time),
    },
  };
  // Signed with signTypedDataLoose (typed-data.ts): viem's own signer refuses the ':' in the type name.
}

/** Split a 65-byte signature into the {r, s, v} Hyperliquid's /exchange expects. */
export function splitSignature(signature: string): { r: string; s: string; v: number } {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new Error('Not a 65-byte signature.');
  const r = `0x${signature.slice(2, 66)}`;
  const s = `0x${signature.slice(66, 130)}`;
  let v = Number.parseInt(signature.slice(130, 132), 16);
  if (v < 27) v += 27;
  return { r, s, v };
}

export function exchangeBody(action: Withdraw3Action, signature: { r: string; s: string; v: number }) {
  return { action, nonce: action.time, signature };
}

/**
 * What /exchange said. `{status:"ok"}` is accepted. A nonce that was already
 * used means an earlier send of this same action was accepted, which is what
 * a retry after a lost response looks like.
 */
export function readExchangeAnswer(body: unknown): 'accepted' | 'duplicate' | { error: string } {
  const answer = body as { status?: string; response?: unknown } | null;
  if (answer?.status === 'ok') {
    const inner = answer.response as { type?: string; data?: { status?: string; error?: string } } | undefined;
    if (inner?.data && typeof inner.data === 'object' && 'error' in inner.data && inner.data.error) {
      return { error: String(inner.data.error) };
    }
    return 'accepted';
  }
  const message = typeof answer?.response === 'string' ? answer.response : JSON.stringify(body);
  if (/nonce/i.test(message) && /(already|used|duplicate)/i.test(message)) return 'duplicate';
  return { error: message };
}

/* ------------------------------------------------------------------- Info */

/**
 * How the account keeps its USDC. "default" and "disabled" keep perp margin in
 * the perp clearinghouse; a unified or portfolio-margin account shows every
 * balance in the spot clearinghouse and the perp state is not meaningful.
 */
export type HyperliquidAbstraction = 'default' | 'disabled' | 'unifiedAccount' | 'portfolioMargin' | 'dexAbstraction' | 'unknown';

export function readAbstraction(body: unknown): HyperliquidAbstraction {
  return body === 'default' || body === 'disabled' || body === 'unifiedAccount' || body === 'portfolioMargin' || body === 'dexAbstraction' ? body : 'unknown';
}

export function isUnified(mode: HyperliquidAbstraction): boolean {
  return mode === 'unifiedAccount' || mode === 'portfolioMargin';
}

export interface HyperliquidAccount {
  readonly mode: HyperliquidAbstraction;
  /** Perp account value in USDC units (margin plus unrealised PnL). */
  readonly accountValue: bigint;
  /** What withdraw3 can take right now, in units. */
  readonly withdrawable: bigint;
  /** Coins with a non-zero perp position. */
  readonly openPositions: string[];
  readonly openOrders: number;
  /** Spot USDC, in units, and how much of it is held by orders. */
  readonly spotUsdc: bigint;
  readonly spotUsdcHold: bigint;
  /** Spot tokens other than USDC with a balance. They cannot be withdrawn to Arbitrum here. */
  readonly spotOther: { coin: string; total: string }[];
}

interface ClearinghouseState {
  marginSummary?: { accountValue?: string };
  withdrawable?: string;
  assetPositions?: { position?: { coin?: string; szi?: string } }[];
}

interface SpotState {
  balances?: { coin?: string; total?: string; hold?: string }[];
}

export function readAccount(perp: unknown, spot: unknown, orders: unknown, mode: HyperliquidAbstraction = 'default'): HyperliquidAccount {
  const state = (perp ?? {}) as ClearinghouseState;
  const balances = ((spot ?? {}) as SpotState).balances ?? [];
  const usdc = balances.find((row) => row.coin === 'USDC');
  const spotUsdc = usdc ? usdcUnitsFromDecimal(usdc.total ?? '0') : 0n;
  const spotUsdcHold = usdc ? usdcUnitsFromDecimal(usdc.hold ?? '0') : 0n;
  // Unified: the spot balance is the whole account, and what is not held by
  // margin or orders is what can leave. The perp numbers would count it twice.
  const unified = isUnified(mode);
  return {
    mode,
    accountValue: unified ? 0n : usdcUnitsFromDecimal(state.marginSummary?.accountValue ?? '0'),
    withdrawable: unified ? (spotUsdc > spotUsdcHold ? spotUsdc - spotUsdcHold : 0n) : usdcUnitsFromDecimal(state.withdrawable ?? '0'),
    openPositions: (state.assetPositions ?? [])
      .filter((row) => row.position && Number(row.position.szi ?? '0') !== 0)
      .map((row) => row.position?.coin ?? '?'),
    openOrders: Array.isArray(orders) ? orders.length : 0,
    spotUsdc,
    spotUsdcHold,
    spotOther: balances
      .filter((row) => row.coin && row.coin !== 'USDC' && Number(row.total ?? '0') > 0)
      .map((row) => ({ coin: row.coin!, total: row.total ?? '0' })),
  };
}

/** Everything in USDC the address has on Hyperliquid, perp and spot together. */
export function totalUsdc(account: HyperliquidAccount): bigint {
  return account.accountValue + account.spotUsdc;
}

/**
 * Why Bring back cannot run yet, or null. Ghosty never closes a position or
 * sells a token for the user: the site does that, and this only refuses.
 */
export function hyperliquidExitBlocker(account: HyperliquidAccount): string | null {
  if (account.openPositions.length > 0) {
    return `Close your ${account.openPositions.join(', ')} position${account.openPositions.length > 1 ? 's' : ''} on Hyperliquid first. Nothing was withdrawn.`;
  }
  if (account.openOrders > 0) {
    return `Cancel your ${account.openOrders} open order${account.openOrders > 1 ? 's' : ''} on Hyperliquid first. Nothing was withdrawn.`;
  }
  if (account.spotOther.length > 0) {
    return `Sell ${account.spotOther.map((row) => `${row.total} ${row.coin}`).join(', ')} for USDC on Hyperliquid first. Only USDC comes back to Arbitrum. Nothing was withdrawn.`;
  }
  return null;
}

/** One row of userNonFundingLedgerUpdates. Only withdrawals are read. */
export interface LedgerRow {
  readonly time: number;
  readonly delta: { readonly type: string; readonly usdc?: string; readonly fee?: string };
}

/**
 * USDC withdrawn to Arbitrum at or after `since`, as it arrives there. Read
 * live (2026-11-12): a withdraw row's `usdc` equals the amount the bridge paid
 * out on Arbitrum, with the 1 USDC `fee` listed separately.
 */
export function withdrawnSince(rows: readonly LedgerRow[], since = 0): bigint {
  return rows
    .filter((row) => row.delta?.type === 'withdraw' && row.time >= since)
    .reduce((sum, row) => sum + usdcUnitsFromDecimal(row.delta.usdc ?? '0'), 0n);
}

/**
 * Has the deposit been credited? Hyperliquid shows it within about a minute.
 * A 1 USDC allowance covers a fee or a funding payment moving the total.
 */
export function depositCredited(before: bigint, now: bigint, deposited: bigint): boolean {
  return now + 1_000_000n >= before + deposited;
}

/** Has the withdrawal reached the address on Arbitrum? Hyperliquid's fee comes off the amount. */
export function withdrawalArrived(before: bigint, now: bigint, amount: bigint): boolean {
  return now >= before + amount - HYPERLIQUID_WITHDRAW_FEE_UNITS;
}
