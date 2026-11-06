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

// Only claims ports named 'anon-rpc.worker', so it coexists with the proof
// handling below.
mountOffscreenHost();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== 'truly:offscreen') return false;

  switch (message.kind) {
    case 'ping':
      sendResponse({ ok: true });
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

console.info('[truly] offscreen ready');
