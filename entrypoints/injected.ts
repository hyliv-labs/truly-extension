/**
 * E5, MAIN half. Runs in the page's world — no `chrome.*` available here.
 *
 * Announces an EIP-1193 provider over EIP-6963 so Lighter's connect list shows
 * Truly, and relays every call to the ISOLATED content script.
 */

export default defineUnlistedScript(() => {
  const provider = createProvider();

  // The uuid identifies this provider instance and must stay stable across
  // announcements, or the dapp will list Truly once per announce.
  const info = Object.freeze({
    uuid: crypto.randomUUID(),
    name: 'Truly',
    // TODO: real icon before submission; EIP-6963 requires a data URI.
    icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=',
    rdns: 'xyz.hylivlabs.truly',
  });

  const announce = () =>
    window.dispatchEvent(
      new CustomEvent('eip6963:announceProvider', {
        detail: Object.freeze({ info, provider }),
      }),
    );

  // Announce once now, and again whenever a dapp asks — it may have published
  // its request before this script loaded.
  window.addEventListener('eip6963:requestProvider', announce);
  announce();
});

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

    if (data.error) {
      // EIP-1193 shape: dapps branch on `code`, notably 4001 for user rejection.
      entry.reject(
        Object.assign(new Error(data.error.message ?? 'Truly failed'), {
          code: data.error.code ?? 4900,
        }),
      );
    } else {
      entry.resolve(data.result);
    }
  });

  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();

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

    on(event: string, listener: (...args: unknown[]) => void) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(listener);
      return this;
    },

    removeListener(event: string, listener: (...args: unknown[]) => void) {
      listeners.get(event)?.delete(listener);
      return this;
    },

    // TODO(E8): emit accountsChanged when the orchestrator rotates the owner
    // between trades, and disconnect when a trade is retired.
  };
}
