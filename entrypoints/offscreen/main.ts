/**
 * E2 / E3 host.
 *
 * The anon-rpc harness needs a DOM to hold its sandboxed iframe, and the
 * Privacy Pools proof builder needs real DOM plus workers. An MV3 service
 * worker has neither, so both live here.
 *
 * Chrome allows exactly one offscreen document per extension. Rather than
 * letting the harness create its own and fight ours for the slot, we mount its
 * host here and pass offscreenUrl: false in the worker.
 */

import { mountOffscreenHost } from '@anon-rpc/browser-extension-harness/offscreen';
import { assertArtifactsPresent } from '@truly/lib/proving';
import { requestSeedSignature, MetaMaskError } from '@truly/lib/metamask';
import { runWithdrawalProof } from '@truly/lib/prove-withdrawal-run';

/** Whether the anon-rpc host mounted. Reported by 'ping'. */
let hostMounted = false;
let hostError: string | null = null;

/**
 * THE LISTENER IS REGISTERED FIRST, before the anon-rpc host is mounted.
 *
 * It used to be the other way round, and that made any failure inside
 * mountOffscreenHost() fatal to the entire document: the module threw, the
 * listener was never added, and the offscreen page sat there loaded and
 * completely deaf. The service worker then reported 'offscreen document
 * disconnected' / 'Receiving end does not exist', which names neither
 * anon-rpc nor the real error.
 *
 * Registering first means a broken harness costs us anon-rpc — loudly — but
 * not proving, not MetaMask recovery, and not the ability to say what went
 * wrong.
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== 'truly:offscreen') return false;

  switch (message.kind) {
    case 'ping':
      // Reports the host's state too, so a caller can tell 'offscreen is
      // alive but anon-rpc is broken' from 'offscreen is not there'.
      sendResponse({ ok: true, value: { hostMounted, hostError } });
      return true;

    case 'circuitsReady':
      // Answered here rather than in the worker: only this document can fetch
      // the artifacts and run the WASM that uses them.
      assertArtifactsPresent()
        .then(() => sendResponse({ ok: true, value: true }))
        .catch((error: Error) => sendResponse({ ok: false, error: error.message }));
      return true;

    case 'metamaskSign':
      // Held here rather than in the popup: MetaMask's approval window takes
      // focus and closes the popup, which would tear down the port mid-request.
      requestSeedSignature(message.version)
        .then((value) => sendResponse({ ok: true, value }))
        .catch((error: unknown) =>
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            reason: error instanceof MetaMaskError ? error.reason : 'failed',
          }),
        );
      return true;

    case 'proveWithdrawal':
      // snarkjs needs real DOM, workers and WebAssembly, none of which the
      // service worker has — so the orchestration stays there and only the
      // proof crosses.
      //
      // message.input carries the note's nullifier and secret, i.e. spend
      // authority. It is never logged here and never included in an error.
      runWithdrawalProof(message.input)
        .then((value) => sendResponse({ ok: true, value }))
        .catch((error: unknown) =>
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : 'Proof generation failed.',
          }),
        );
      return true;

    default:
      sendResponse({ ok: false, error: `unknown kind: ${message.kind}` });
      return true;
  }
});

// Mounted AFTER the listener, and never allowed to take the document down
// with it. Only claims ports named 'anon-rpc.worker', so it coexists with the
// proof handling above.
try {
  mountOffscreenHost();
  hostMounted = true;
  console.info('[truly] offscreen: anon-rpc host mounted');
} catch (error) {
  hostError = error instanceof Error ? error.message : String(error);
  console.error('[truly] offscreen: anon-rpc host FAILED to mount:', error);
}

console.info('[truly] offscreen ready; anon-rpc host mounted:', hostMounted);
