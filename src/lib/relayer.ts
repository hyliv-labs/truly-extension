/**
 * The Privacy Pools relayer (fastrelay.xyz).
 *
 * The relayer submits the withdrawal, so the pool sees ITS address as the
 * sender, not the owner's. That is what keeps the owner address unfunded and
 * unlinked — paying for the withdrawal from the owner would defeat the point.
 *
 * PRIVACY LIMIT, stated plainly: these are ordinary HTTPS calls from the
 * user's IP, and they carry the owner address as recipient. anon-rpc is a
 * JSON-RPC proxy and cannot carry them, so fastrelay can associate this IP
 * with that owner address. The transport is injectable so this can be routed
 * through something else later without touching the call logic.
 */

import type { Address, Hex } from 'viem';
import { PRIVACY_POOL_RELAYER_URL, ARBITRUM_CHAIN_ID, USDC_ADDRESS } from './config';

export class RelayerError extends Error {
  /** Transient failures are worth retrying; a rejected proof is not. */
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = 'RelayerError';
    this.retryable = retryable;
  }
}

/** Injectable so the transport can change without touching call logic. */
export type RelayerTransport = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

let transport: RelayerTransport = (url, init) => fetch(url, init);

export function setRelayerTransport(next: RelayerTransport): void {
  transport = next;
}

export interface FeeCommitment {
  readonly expiration: number;
  readonly asset: Address;
  /** Pre-encoded; this is the `data` the context commits to. Do not rebuild it. */
  readonly withdrawalData: Hex;
  readonly signedRelayerCommitment: Hex;
  readonly extraGas: boolean;
  readonly amount: string;
}

export interface RelayerQuote {
  /** Effective rate, INCLUDING amortised gas. Not the advertised base rate. */
  readonly feeBPS: bigint;
  readonly baseFeeBPS: bigint;
  readonly feeCommitment: FeeCommitment;
}

function relayerBase(): string {
  if (!PRIVACY_POOL_RELAYER_URL) {
    throw new RelayerError(
      'No Privacy Pools relayer configured. Without one the withdrawal would have to be paid for by the owner address, linking it to the deposit.',
      false,
    );
  }
  return PRIVACY_POOL_RELAYER_URL.replace(/\/+$/, '');
}

async function post(path: string, body: unknown): Promise<Response> {
  try {
    return await transport(`${relayerBase()}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (error) {
    // Network-level failure: the request may not have been seen at all.
    throw new RelayerError(
      `Could not reach the relayer: ${error instanceof Error ? error.message : String(error)}`,
      true,
    );
  }
}

/**
 * Ask the relayer what it will charge, and for its signed commitment to that.
 *
 * MUST be called before proving. The context is keccak(withdrawal, scope) and
 * the withdrawal's `data` carries the fee terms, so a fee agreed afterwards
 * changes the context and the pool reverts with ContextMismatch.
 *
 * The returned commitment expires in ~60s (measured), so nothing network-bound
 * may sit between this call and `submitWithdrawal`.
 */
export async function requestQuote(
  recipient: Address,
  amountUnits: bigint,
  options: { extraGas?: boolean } = {},
): Promise<RelayerQuote> {
  const response = await post('/relayer/quote', {
    chainId: ARBITRUM_CHAIN_ID,
    amount: amountUnits.toString(),
    asset: USDC_ADDRESS,
    recipient,
    extraGas: options.extraGas ?? false,
  });

  const text = await response.text();
  if (!response.ok) {
    // The relayer prices via CoW and can fail transiently; a 5xx or a
    // CoW-sourced error is worth re-quoting rather than abandoning.
    const transient = response.status >= 500 || text.includes('CowSwap') || text.includes('QUOTE_ERROR');
    throw new RelayerError(`Relayer quote failed (HTTP ${response.status}): ${text.slice(0, 300)}`, transient);
  }

  let parsed: {
    feeBPS?: string;
    baseFeeBPS?: string;
    feeCommitment?: Partial<FeeCommitment>;
  };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RelayerError(`Relayer returned a non-JSON quote: ${text.slice(0, 200)}`, true);
  }

  const commitment = parsed.feeCommitment;
  if (!commitment?.withdrawalData || !commitment.signedRelayerCommitment) {
    throw new RelayerError('Relayer quote carried no usable feeCommitment.', true);
  }
  if (typeof commitment.expiration !== 'number') {
    throw new RelayerError('Relayer quote has no expiration; its validity window is unknown.', true);
  }

  return {
    feeBPS: BigInt(parsed.feeBPS ?? '0'),
    baseFeeBPS: BigInt(parsed.baseFeeBPS ?? '0'),
    feeCommitment: commitment as FeeCommitment,
  };
}

/** Milliseconds left on a quote. Negative once expired. */
export function quoteTimeRemainingMs(quote: RelayerQuote): number {
  return quote.feeCommitment.expiration - Date.now();
}

/**
 * Whether there is still enough of the window left to be worth proving.
 *
 * Proving takes ~2.5s; submission and inclusion need headroom beyond that.
 * Starting a proof against a nearly-dead quote wastes the proof.
 */
export function quoteStillUsable(quote: RelayerQuote, neededMs = 15_000): boolean {
  return quoteTimeRemainingMs(quote) > neededMs;
}

export interface WithdrawalProofBundle {
  readonly processooor: Address;
  readonly data: Hex;
  readonly publicSignals: readonly string[];
  readonly proof: {
    readonly pi_a: readonly string[];
    readonly pi_b: readonly (readonly string[])[];
    readonly pi_c: readonly string[];
    readonly protocol?: string;
    readonly curve?: string;
  };
}

export interface SubmitResult {
  readonly txHash?: Hex;
  readonly raw: unknown;
}

/**
 * Submit the proof for relaying.
 *
 * `IncorrectASPRoot` here means the ASP published a new root between proving
 * and inclusion. That is retryable, but the retry must restart from the
 * association set AND re-quote — by then the 60s commitment is usually dead.
 */
export async function submitWithdrawal(
  bundle: WithdrawalProofBundle,
  quote: RelayerQuote,
  scope: bigint,
): Promise<SubmitResult> {
  const response = await post('/relayer/request', {
    withdrawal: { processooor: bundle.processooor, data: bundle.data },
    publicSignals: bundle.publicSignals,
    proof: bundle.proof,
    scope: scope.toString(),
    chainId: ARBITRUM_CHAIN_ID,
    feeCommitment: quote.feeCommitment,
  });

  const text = await response.text();
  if (!response.ok) {
    throw new RelayerError(
      `Relayer rejected the withdrawal (HTTP ${response.status}): ${text.slice(0, 300)}`,
      isRetryableRevert(text) || response.status >= 500,
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    raw = text;
  }
  const hash = (raw as { txHash?: string; hash?: string })?.txHash ?? (raw as { hash?: string })?.hash;
  return { txHash: hash as Hex | undefined, raw };
}

/**
 * Reverts worth retrying from the top.
 *
 * IncorrectASPRoot is a race, not a defect: the proof was valid when built.
 * ContextMismatch is NOT here — it means the withdrawal data was rebuilt
 * instead of using the relayer's, which retrying cannot fix.
 */
export function isRetryableRevert(message: string): boolean {
  return message.includes('IncorrectASPRoot') || message.includes('UnknownStateRoot');
}
