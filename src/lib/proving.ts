/**
 * E3: Privacy Pools withdrawal proofs.
 *
 * Runs ONLY in the offscreen document. snarkjs needs real DOM, workers and
 * WebAssembly, none of which an MV3 service worker has — which is also why
 * extension_pages carries 'wasm-unsafe-eval'.
 *
 * The circuit artifacts are not shipped in the SDK and 0xbow publishes no
 * release assets, so they must be placed in public/privacy-pools/ and served
 * from the extension's own origin. MV3 forbids remote code, so fetching them
 * from a CDN is not an alternative.
 */

import { Circuits, PrivacyPoolSDK } from '@0xbow/privacy-pools-core-sdk';
import { CIRCUIT_ARTIFACT_PATH } from './config';

export class CircuitArtifactsMissing extends Error {
  constructor() {
    super(
      'Privacy Pools circuit artifacts are not bundled. Place withdraw.wasm, withdraw.zkey, commitment.wasm and commitment.zkey in public/privacy-pools/ — ask the 0xbow booth for the files matching the deployed pool.',
    );
    this.name = 'CircuitArtifactsMissing';
  }
}

let sdk: PrivacyPoolSDK | null = null;

/**
 * The SDK resolves artifacts with `new URL(path, baseUrl)`, so baseUrl must be
 * an absolute extension URL — a bare relative path would resolve against the
 * offscreen document and silently 404 inside the SDK.
 */
function artifactBaseUrl(): string {
  return chrome.runtime.getURL(CIRCUIT_ARTIFACT_PATH);
}

/** Fail with a precise message rather than letting the SDK throw mid-proof. */
export async function assertArtifactsPresent(): Promise<void> {
  const probe = new URL('withdraw.wasm', artifactBaseUrl()).toString();
  try {
    const response = await fetch(probe, { method: 'HEAD' });
    if (!response.ok) throw new CircuitArtifactsMissing();
  } catch (error) {
    if (error instanceof CircuitArtifactsMissing) throw error;
    throw new CircuitArtifactsMissing();
  }
}

export async function getSdk(): Promise<PrivacyPoolSDK> {
  if (sdk) return sdk;

  await assertArtifactsPresent();

  // browser: true uses fetch rather than fs, which is the only option here.
  const circuits = new Circuits({ browser: true, baseUrl: artifactBaseUrl() });
  sdk = new PrivacyPoolSDK(circuits);
  return sdk;
}
