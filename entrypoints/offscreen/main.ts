/**
 * E2 / E3 host.
 *
 * The anon-rpc harness needs a DOM to hold its sandboxed iframe, and Railgun
 * needs IndexedDB, workers and WebAssembly. An MV3 service worker has none
 * of those, so both live here.
 *
 * The listener is registered by this small module, before the Railgun SDK is
 * imported. A static import of the SDK parses an 8 MB bundle first, and a
 * message sent during that parse gets "Receiving end does not exist" because
 * nothing is listening yet. The heavy modules load on the first message that
 * needs them.
 */

import '@truly/shims/railgun-browser';

/** Whether the anon-rpc host mounted. Reported by 'ping'. */
let hostMounted = false;
let hostError: string | null = null;

import { countRailgunRpcError, getRailgunSyncStatus } from '@truly/lib/railgun-sync-status';

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== 'truly:offscreen') return false;

  void handle(message as OffscreenMessage)
    .then((value) => {
      if (isResponse(value)) sendResponse(value);
      else sendResponse({ ok: true, value });
    })
    .catch((error: unknown) => sendResponse({ ok: false, error: text(error) }));
  return true;
});

void bootHost();

// The Railgun engine's RPC failures surface as unhandled rejections. Counting
// them is how a rate-limited stall shows up: progress stops moving while this
// number climbs. Measured: tenderly's public gateway returns 429 "rate limit
// exceeded" during the first sync, and the scan then sits at 67% for good.
addEventListener('unhandledrejection', (event) => {
  const message = event.reason instanceof Error ? event.reason.message : String(event.reason);
  if (/rate limit|429|retry limit|SERVER_ERROR|timeout/i.test(message)) countRailgunRpcError();
});

async function bootHost(): Promise<void> {
  try {
    const { mountOffscreenHost } = await import('@anon-rpc/browser-extension-harness/offscreen');
    mountOffscreenHost();
    hostMounted = true;
    console.info('[truly] offscreen: anon-rpc host mounted');
  } catch (error) {
    hostError = text(error);
    console.error('[truly] offscreen: anon-rpc host FAILED to mount:', error);
  }
}

interface OffscreenMessage {
  kind?: string;
  version?: 'v1' | 'v2';
  input?: unknown;
  mnemonic?: string;
  recipient?: string;
  amountUnits?: string;
  fromAddress?: string;
  shieldPrivateKey?: string;
  tokenAddress?: string;
}

function isResponse(value: unknown): value is { ok: boolean } {
  return typeof value === 'object' && value !== null && 'ok' in value;
}

async function handle(message: OffscreenMessage): Promise<unknown> {
  switch (message.kind) {
    case 'ping':
      return { hostMounted, hostError };

    case 'railgunSyncStatus':
      // Answered from a plain variable: never loads the SDK, never waits on
      // the sync it is reporting.
      return getRailgunSyncStatus();

    case 'circuitsReady': {
      const { assertArtifactsPresent } = await import('@truly/lib/proving');
      await assertArtifactsPresent();
      return true;
    }

    case 'metamaskSign': {
      const { requestSeedSignature, MetaMaskError } = await import('@truly/lib/metamask');
      try {
        return await requestSeedSignature(message.version ?? 'v2');
      } catch (error) {
        return {
          ok: false,
          error: text(error),
          reason: error instanceof MetaMaskError ? error.reason : 'failed',
        };
      }
    }

    case 'railgunBalances':
    case 'railgunUnshield':
    case 'railgunShield':
    case 'railgunShieldCall':
      return railgunMessage(message);

    case 'proveWithdrawal': {
      const { runWithdrawalProof } = await import('@truly/lib/prove-withdrawal-run');
      return runWithdrawalProof(message.input as Parameters<typeof runWithdrawalProof>[0]);
    }

    default:
      throw new Error(`unknown kind: ${String(message.kind)}`);
  }
}

async function railgunMessage(message: OffscreenMessage): Promise<unknown> {
  if (typeof message.mnemonic !== 'string' || message.mnemonic.length === 0) {
    throw new Error('Railgun needs the unlocked vault.');
  }
  const railgun = await import('@truly/lib/railgun-run');
  if (message.kind === 'railgunBalances') return railgun.runRailgunBalances(message.mnemonic);
  if (message.kind === 'railgunUnshield') {
    return railgun.runRailgunUnshield({
      mnemonic: message.mnemonic,
      recipient: String(message.recipient),
      amountUnits: String(message.amountUnits),
      fromAddress: String(message.fromAddress),
    });
  }
  if (message.kind === 'railgunShieldCall') {
    return railgun.runRailgunShieldCall({
      mnemonic: message.mnemonic,
      shieldPrivateKey: String(message.shieldPrivateKey),
      amountUnits: String(message.amountUnits),
    });
  }
  return railgun.runRailgunShield({
    mnemonic: message.mnemonic,
    shieldPrivateKey: String(message.shieldPrivateKey),
    amountUnits: String(message.amountUnits),
    fromAddress: String(message.fromAddress),
    ...(typeof message.tokenAddress === 'string' ? { tokenAddress: message.tokenAddress } : {}),
  });
}

function text(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

console.info('[truly] offscreen ready');
