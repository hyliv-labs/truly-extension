/**
 * In-memory chrome.* for the offline checks, so they exercise the real
 * modules rather than a reimplementation of them.
 *
 * Records what was called, which lets a test assert side effects that matter —
 * site-data cleanup between owners, for instance, is invisible in return
 * values but is the whole of E10.
 */

type Store = Record<string, unknown>;

export interface StubCalls {
  browsingDataRemove: { origins: string[] }[];
  tabsRemoved: number[][];
}

function makeArea(store: Store) {
  return {
    async get(key: string) {
      return key in store ? { [key]: store[key] } : {};
    },
    async set(items: Store) {
      Object.assign(store, items);
    },
    async remove(key: string) {
      delete store[key];
    },
    async clear() {
      for (const k of Object.keys(store)) delete store[k];
    },
  };
}

/** Installs the stub on globalThis and returns its call log. */
export function installChromeStub(): StubCalls {
  const calls: StubCalls = { browsingDataRemove: [], tabsRemoved: [] };

  (globalThis as Record<string, unknown>).chrome = {
    storage: { local: makeArea({}), session: makeArea({}) },
    browsingData: {
      async remove(options: { origins: string[] }) {
        calls.browsingDataRemove.push({ origins: options.origins });
      },
    },
    tabs: {
      // No open Lighter tabs by default; a test can override.
      async query() {
        return [];
      },
      async remove(ids: number[]) {
        calls.tabsRemoved.push(ids);
      },
    },
    alarms: {
      async create() {},
      async clear() {},
    },
  };

  return calls;
}
