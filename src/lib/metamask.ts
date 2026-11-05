/**
 * Talking to MetaMask directly, extension to extension.
 *
 * MetaMask's Chrome manifest declares `externally_connectable` with
 * `ids: ["*"]`, and its background branches on `sender.id` being present —
 * an extension caller is handed the EIP-1193 provider rather than the
 * multichain one. `createExternalExtensionProvider` is documented as being
 * "intended for use by 3rd party extensions".
 *
 * This runs in the OFFSCREEN DOCUMENT, never the popup: MetaMask's approval
 * window takes focus, which closes the popup and would tear down the port
 * mid-signature.
 */

import { createExternalExtensionProvider } from '@metamask/providers';
import type { Address, Hex } from 'viem';
import { buildSeedDerivationTypedData, type SeedVersion } from './wallet-seed';

/** How long to wait for the user to act in MetaMask's own UI. */
const APPROVAL_TIMEOUT_MS = 3 * 60 * 1000;

/** EIP-1193. 4001 is the user rejecting a request. */
const USER_REJECTED = 4001;

export class MetaMaskError extends Error {
  constructor(
    message: string,
    readonly reason:
      | 'not-installed'
      | 'connection-rejected'
      | 'signature-rejected'
      | 'timeout'
      | 'no-account'
      | 'failed',
  ) {
    super(message);
    this.name = 'MetaMaskError';
  }
}

/** The minimum of EIP-1193 this flow needs; lets tests pass a fake. */
export interface MinimalProvider {
  request<T>(args: { method: string; params?: unknown[] }): Promise<T | null | undefined>;
}

export interface MetaMaskSignature {
  readonly address: Address;
  readonly signature: Hex;
}

function isRejection(error: unknown): boolean {
  return (error as { code?: number } | null)?.code === USER_REJECTED;
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new MetaMaskError(`${label} timed out.`, 'timeout')),
          APPROVAL_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

/**
 * Connect to MetaMask and sign the Privacy Pools seed payload.
 *
 * Returns the signature to its caller and keeps no copy. The caller is
 * expected to derive from it and discard it — it is seed-equivalent material,
 * so it is never logged, stored or sent anywhere.
 */
export async function requestSeedSignature(
  version: SeedVersion,
  provider: MinimalProvider = createProvider(),
): Promise<MetaMaskSignature> {
  let accounts: string[] | null | undefined;
  try {
    accounts = await withTimeout(
      provider.request<string[]>({ method: 'eth_requestAccounts' }),
      'Connecting to MetaMask',
    );
  } catch (error) {
    if (error instanceof MetaMaskError) throw error;
    if (isRejection(error)) {
      throw new MetaMaskError('You declined the connection in MetaMask.', 'connection-rejected');
    }
    // A missing MetaMask surfaces as a port that never connects.
    throw new MetaMaskError(
      'Could not reach MetaMask. Is it installed and unlocked?',
      'not-installed',
    );
  }

  const address = accounts?.[0] as Address | undefined;
  if (!address) {
    throw new MetaMaskError('MetaMask returned no account.', 'no-account');
  }

  const typedData = buildSeedDerivationTypedData(address, version);

  let signature: Hex | null | undefined;
  try {
    signature = await withTimeout(
      provider.request<Hex>({
        method: 'eth_signTypedData_v4',
        // MetaMask takes [address, JSON string] in that order.
        params: [address, JSON.stringify(typedData)],
      }),
      'Waiting for the signature',
    );
  } catch (error) {
    if (error instanceof MetaMaskError) throw error;
    if (isRejection(error)) {
      throw new MetaMaskError('You declined the signature in MetaMask.', 'signature-rejected');
    }
    throw new MetaMaskError('MetaMask could not sign the message.', 'failed');
  }

  if (!signature) {
    throw new MetaMaskError('MetaMask returned no signature.', 'failed');
  }

  return { address, signature };
}

function createProvider(): MinimalProvider {
  // 'stable' resolves to MetaMask's published Chrome extension id.
  return createExternalExtensionProvider('stable') as unknown as MinimalProvider;
}
