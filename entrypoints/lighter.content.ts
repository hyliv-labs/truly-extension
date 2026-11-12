/**
 * E5, ISOLATED half.
 *
 * The EIP-1193 provider must run in the page's MAIN world to be reachable by
 * Lighter's dapp code, but MAIN-world scripts have no `chrome.runtime`. So this
 * ISOLATED-world script is the relay: it injects the MAIN-world provider and
 * ferries messages between it and the background worker.
 */

export default defineContentScript({
  matches: ['https://*.lighter.xyz/*', 'https://*.uniswap.org/*', 'https://*.compound.xyz/*', 'https://*.compound.finance/*', 'https://*.hyperliquid.xyz/*'],
  runAt: 'document_start',

  async main() {
    injectMainWorldProvider();

    window.addEventListener('message', (event) => {
      // Only this page, and only our own envelope.
      if (event.source !== window) return;
      const data = event.data;
      if (data?.target !== 'truly:relay' || typeof data.id !== 'string') return;

      void forward(data);
    });

    chrome.runtime.onMessage.addListener((message: { kind?: string; event?: string; args?: unknown[] }) => {
      if (message?.kind !== 'providerEvent' || typeof message.event !== 'string') return;
      window.postMessage(
        { target: 'truly:event', event: message.event, args: message.args ?? [] },
        window.location.origin,
      );
    });
  },
});

async function forward(data: {
  id: string;
  method: string;
  params?: unknown[];
}): Promise<void> {
  // The same id on every attempt. If the worker dies mid-approval, the retry
  // continues that prompt instead of opening a second one or signing twice.
  const payload = {
    kind: 'provider' as const,
    // The origin is taken here, not from the page: a page cannot forge
    // its own content script's location.
    origin: window.location.origin,
    method: data.method,
    params: data.params ?? [],
    requestId: data.id,
  };

  let delay = 400;
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const response = await chrome.runtime.sendMessage(payload);
      reply(data.id, response);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Reloading the extension invalidates this content script. Retrying
      // cannot help, and a dead port during an approval can.
      const portClosed =
        message.includes('message port closed') ||
        message.includes('Receiving end does not exist') ||
        message.includes('Could not establish connection');
      if (!portClosed || attempt === 39) {
        reply(data.id, {
          ok: false,
          rpc: { code: 4900, message },
        });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(Math.round(delay * 1.5), 3_000);
    }
  }
}

function reply(
  id: string,
  response: {
    ok: boolean;
    value?: unknown;
    error?: string;
    /** EIP-1193 code preserved by the worker, when it had one. */
    rpc?: { code: number; message: string };
  },
): void {
  window.postMessage(
    response?.ok
      ? { target: 'truly:provider', id, result: response.value }
      : {
          target: 'truly:provider',
          id,
          error: response?.rpc ?? {
            code: 4900,
            message: response?.error ?? 'Truly failed',
          },
        },
    window.location.origin,
  );
}

function injectMainWorldProvider(): void {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('/injected.js');
  // Deliberately NOT type="module": that would defer execution and CORS-fetch
  // the file, so the provider could announce after the dapp has already built
  // its connect list. WXT emits an IIFE, which runs synchronously.
  script.onload = () => script.remove();
  // document_start can run before <head> exists.
  (document.head ?? document.documentElement).prepend(script);
}
