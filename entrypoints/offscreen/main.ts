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

    // TODO(E3): 'proveWithdrawal' — needs the circuit artifacts and the pool
    // addresses before it can do anything but fail.

    default:
      sendResponse({ ok: false, error: `unknown kind: ${message.kind}` });
      return true;
  }
});

console.info('[truly] offscreen ready');
