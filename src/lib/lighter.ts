/**
 * E4: Lighter's bridge API.
 *
 * These are Lighter's own HTTP endpoints, not chain reads, so they do NOT go
 * through the anon-rpc harness — it anonymises RPC, and routing a Lighter API
 * call through it would not hide anything that matters. Lighter sees the user's
 * IP regardless, which is a stated limit in the README's CROPS section.
 *
 * Endpoint shapes below were verified against mainnet, not taken from docs:
 * createIntentAddress is form-encoded (NOT JSON) and its 200 response carries
 * no `message` field.
 */

import type { Address } from 'viem';
import { ARBITRUM_CHAIN_ID } from './config';

const API_BASE = 'https://mainnet.zklighter.elliot.ai/api/v1';

/**
 * Lighter's minimum for the CCTP intent-address deposit path. A withdrawal
 * that would land under this is refused before it is sent — the funds would
 * otherwise be stranded at the intent address.
 */
export const MIN_DEPOSIT_USDC = 5;

/** Fast withdrawal minimum. The $1 fee is NOT confirmed to sit on top. */
export const MIN_FAST_WITHDRAWAL_USDC = 4;

/** Secure withdrawal minimum; lands on Ethereum, not Arbitrum. */
export const MIN_SECURE_WITHDRAWAL_USDC = 1;

export class LighterApiError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = 'LighterApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, init);
  const text = await response.text();

  let json: (T & { code?: number; message?: string }) | undefined;
  try {
    json = JSON.parse(text);
  } catch {
    throw new LighterApiError(`Lighter returned non-JSON (${response.status})`);
  }

  // Lighter signals failure in the body's `code`, not only the HTTP status.
  if (!response.ok || (json?.code !== undefined && json.code !== 200)) {
    throw new LighterApiError(
      json?.message ?? `Lighter request failed (${response.status})`,
      json?.code,
    );
  }

  return json as T;
}

/**
 * Allocate the deposit address for this owner.
 *
 * amount=0 and is_external_deposit=true say the funds arrive from somewhere
 * Lighter did not send them from — here, the Privacy Pools relayer. Without
 * the flag Lighter expects the deposit to come from `from_addr` itself, which
 * would defeat the entire point: the relayer pays, not the owner.
 */
export async function createIntentAddress(owner: Address): Promise<Address> {
  const body = new URLSearchParams({
    chain_id: String(ARBITRUM_CHAIN_ID),
    from_addr: owner,
    amount: '0',
    is_external_deposit: 'true',
  });

  const result = await request<{ intent_address: string }>('/createIntentAddress', {
    method: 'POST',
    // Form-encoded, verified against mainnet. JSON is rejected.
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!result.intent_address) {
    throw new LighterApiError('Lighter returned no intent address');
  }
  return result.intent_address as Address;
}

export interface DepositStatus {
  readonly status: string;
  readonly step: string;
  /** Human-readable, e.g. "Waiting for user to deposit". Shown in the popup. */
  readonly description: string;
  readonly amount: string;
  readonly intentAddress: Address | '';
  readonly isExternalDeposit: boolean;
  /** Whether Lighter expects to use the fast bridge for the next deposit. */
  readonly isNextBridgeFast: boolean;
}

export async function getDepositStatus(owner: Address): Promise<DepositStatus> {
  const result = await request<{
    status: string;
    step: string;
    description: string;
    amount: string;
    intent_address: string;
    is_external_deposit: boolean;
    is_next_bridge_fast: boolean;
  }>(`/deposit/latest?l1_address=${owner}`);

  return {
    status: result.status,
    step: result.step,
    description: result.description,
    amount: result.amount,
    intentAddress: result.intent_address as Address | '',
    isExternalDeposit: result.is_external_deposit,
    isNextBridgeFast: result.is_next_bridge_fast,
  };
}

/**
 * deposit/latest does not document its status values, but the sibling
 * deposit/history endpoint enumerates: failed | pending | completed | claimable.
 * Whether /latest shares that vocabulary is NOT documented, so this stays a
 * family match and is only ever a secondary signal — checkDeposit treats the
 * existence of a Lighter account as the real proof of credit.
 */
export function isDepositComplete(status: DepositStatus): boolean {
  return /^(completed|complete|success|succeeded|done|credited|finished)$/.test(
    status.status.trim().toLowerCase(),
  );
}

/** A deposit that will not progress on its own. */
export function isDepositFailed(status: DepositStatus): boolean {
  return /(fail|error|reject|cancel|expire)/.test(status.status.toLowerCase());
}

/**
 * 'claimable' is in deposit/history's enum: the funds are there but will not
 * arrive by waiting. Polling through it would look exactly like a slow
 * deposit, which is the failure mode that costs a demo.
 */
export function isDepositClaimable(status: DepositStatus): boolean {
  return status.status.trim().toLowerCase() === 'claimable';
}

/**
 * Fast-bridge headroom. Observed as "0" on Arbitrum during the build, meaning
 * no capacity and the normal ~15-20 minute deposit instead.
 */
export async function getFastBridgeLimit(): Promise<string> {
  const result = await request<{ fast_bridge_limit: string }>('/fastbridge/info');
  return result.fast_bridge_limit;
}

/**
 * The Lighter account index for this owner, or null while none exists. A fresh
 * owner has no account until its first deposit is credited.
 */
export async function getAccountIndex(owner: Address): Promise<number | null> {
  try {
    const result = await request<{
      sub_accounts: { index: number; account_type?: number }[];
    }>(`/accountsByL1Address?l1_address=${owner}`);

    const first = result.sub_accounts?.[0];
    return first ? first.index : null;
  } catch (error) {
    // 21100 "account not found" is the expected answer for a fresh owner,
    // not a failure.
    if (error instanceof LighterApiError && error.code === 21100) return null;
    throw error;
  }
}
