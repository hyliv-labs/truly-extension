/**
 * E5, MAIN half. Runs in the page's world — no `chrome.*` available here.
 *
 * Announces an EIP-1193 provider over EIP-6963 so Lighter's connect list shows
 * Truly, and relays every RPC call to the ISOLATED content script.
 */

export default defineUnlistedScript(() => {
  const provider = createProvider();
  announce(provider);
  // The dapp may have published its request before we loaded.
  window.addEventListener('eip6963:requestProvider', () => announce(provider));
});

/** Minimal EIP-1193 surface: only what Lighter's connect + authorize flow needs. */
function createProvider() {
  const pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void }
  >();

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (data?.target !== 'truly:provider') return;
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    if (data.error) entry.reject(data.error);
    else entry.resolve(data.result);
  });

  return {
    isTruly: true,

    request({ method, params }: { method: string; params?: unknown[] }) {
      const id = crypto.randomUUID();
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        window.postMessage(
          { target: 'truly:relay', id, method, params },
          window.location.origin,
        );
      });
    },

    // TODO(E5): accountsChanged / chainChanged events once the orchestrator
    // swaps the active owner address between trades.
    on() {},
    removeListener() {},
  };
}

function announce(provider: unknown): void {
  window.dispatchEvent(
    new CustomEvent('eip6963:announceProvider', {
      detail: Object.freeze({
        info: {
          uuid: crypto.randomUUID(),
          name: 'Truly',
          // TODO: real icon before submission; must be a data URI per EIP-6963.
          icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=',
          rdns: 'xyz.hylivlabs.truly',
        },
        provider,
      }),
    }),
  );
}
