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

// Only claims ports named 'anon-rpc.worker', so it coexists with the proof
// handling below.
mountOffscreenHost();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== 'truly:offscreen') return false;

  switch (message.kind) {
    case 'ping':
      sendResponse({ ok: true });
      return true;

    // TODO(E3): 'proof' — build the Privacy Pools withdrawal proof.

    default:
      sendResponse({ ok: false, error: `unknown kind: ${message.kind}` });
      return true;
  }
});

console.info('[truly] offscreen ready');
