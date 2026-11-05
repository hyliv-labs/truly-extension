/**
 * E2 / E3 host.
 *
 * The Anon-RPC harness needs a sandboxed iframe and WebRTC, and the Privacy
 * Pools proof builder needs real DOM + workers. An MV3 service worker has
 * neither, so the worker forwards reads and proof jobs here.
 *
 * Chrome allows exactly one offscreen document per extension, so the worker
 * must check chrome.runtime.getContexts before createDocument.
 */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== 'truly:offscreen') return false;

  switch (message.kind) {
    case 'ping':
      sendResponse({ ok: true });
      return true;

    // TODO(E2): 'rpc' — forward to the Anon-RPC harness and return the result.
    // TODO(E3): 'proof' — build the Privacy Pools withdrawal proof.

    default:
      sendResponse({ ok: false, error: `unknown kind: ${message.kind}` });
      return true;
  }
});

console.info('[truly] offscreen ready');
