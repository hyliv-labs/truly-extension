/**
 * E5, MAIN half. Runs in the page's world — no `chrome.*` available here.
 *
 * Announces an EIP-1193 provider over EIP-6963 so Lighter's connect list shows
 * Truly, and relays every call to the ISOLATED content script.
 */

import { mascotDataUri } from '@truly/lib/brand';

export default defineUnlistedScript(() => {
  const provider = createProvider();

  // The uuid identifies this provider instance and must stay stable across
  // announcements, or the dapp will list Truly once per announce.
  const info = Object.freeze({
    uuid: crypto.randomUUID(),
    name: 'Truly',
    // EIP-6963 requires a data URI, so it is inlined rather than fetched —
    // a page cannot read an extension asset. The previous value was a valid
    // but EMPTY 0x0 svg, which listed Truly as a blank tile beside wallets
    // that all have marks.
    icon: mascotDataUri('happy'),
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

  // EIP-6963 is the correct discovery path and Truly announces on it. But a
  // dapp that offers a curated wallet list plus a generic "injected" option
  // reads window.ethereum for that option, and a 6963-only wallet is then
  // reachable solely through whatever "view all" affordance the dapp happens
  // to render. Lighter's list is static -- the same six appear in a profile
  // where none of them are installed -- so without this Truly depends on that
  // affordance existing.
  //
  // NEVER clobbers an existing provider. If MetaMask or anything else is
  // already there, it keeps the slot: silently replacing another wallet's
  // provider would hijack every dapp on the page, which is exactly the
  // behaviour 6963 was written to end.
  try {
    if (!('ethereum' in window)) {
      Object.defineProperty(window, 'ethereum', {
        value: provider,
        configurable: true,
        writable: false,
      });
      window.dispatchEvent(new Event('ethereum#initialized'));
    }
  } catch {
    // A page may have locked the property. 6963 still works; nothing to do.
  }
});

function createProvider() {
  const pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void }
  >();
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;

    // accountsChanged / disconnect, forwarded by the content script when a
    // trade starts or ends. The page never has chrome.runtime, so this is
    // the only way the event reaches a listener it registered with `on`.
    if (data?.target === 'truly:event' && typeof data.event === 'string') {
      const handlers = listeners.get(data.event);
      if (!handlers) return;
      const args = Array.isArray(data.args) ? data.args : [];
      for (const handler of handlers) handler(...args);
      return;
    }

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
  };
}
