/**
 * E10: clear Lighter's site data between owner addresses.
 *
 * Two trades that share a session are linked no matter how carefully their
 * funding is separated: a cookie, a localStorage entry or an IndexedDB record
 * left behind ties the new owner to the old one from Lighter's side.
 *
 * Runs BEFORE connecting a new owner as well as after retiring one. After-only
 * would trust that the previous cleanup happened, and the first trade after an
 * install or a crash has no "previous" at all.
 */

/** Tuple, because chrome.browsingData requires a non-empty origins list. */
const LIGHTER_ORIGINS: [string, ...string[]] = [
  'https://lighter.xyz',
  'https://app.lighter.xyz',
  // The API is on a different registrable domain and keeps its own storage.
  'https://mainnet.zklighter.elliot.ai',
  'https://uniswap.org',
  'https://app.uniswap.org',
];

export interface CleanupResult {
  readonly origins: string[];
  readonly closedTabs: number;
}

/**
 * Tabs left open on purpose. A Lighter tab with eth_requestAccounts still
 * in flight is one of these: closing it is what makes the dapp say the
 * connection was cancelled the moment a trade starts.
 */
const sparedTabIds = new Map<number, number>();

export function spareLighterTab(tabId: number): void {
  sparedTabIds.set(tabId, (sparedTabIds.get(tabId) ?? 0) + 1);
}

export function releaseLighterTab(tabId: number): void {
  const next = (sparedTabIds.get(tabId) ?? 0) - 1;
  if (next <= 0) sparedTabIds.delete(tabId);
  else sparedTabIds.set(tabId, next);
}

/**
 * Remove every trace of the current Lighter session.
 *
 * Open tabs are closed first: a live page holds its state in memory and will
 * happily write the old session back the moment it is cleared.
 */
export async function clearLighterSiteData(): Promise<CleanupResult> {
  // Best effort, and bounded. Closing tabs and chrome.browsingData.remove can
  // sit forever when one of these origins still has an open page — the tab we
  // just spared so the dapp can finish connecting. Connect must not wait on that.
  const closedTabs = await within(5_000, closeLighterTabs(), 0);
  await within(
    5_000,
    chrome.browsingData
      .remove(
        { origins: [...LIGHTER_ORIGINS] },
        {
          cookies: true,
          localStorage: true,
          indexedDB: true,
          cacheStorage: true,
          serviceWorkers: true,
          webSQL: true,
        },
      )
      .catch((error: unknown) => {
        console.warn('[truly] site cleanup failed', error);
      }),
    undefined,
  );

  return { origins: [...LIGHTER_ORIGINS], closedTabs };
}

function within<T>(ms: number, work: Promise<T>, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.warn('[truly] site cleanup is still running; connect will not wait for it');
      resolve(fallback);
    }, ms);
    void work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        console.warn('[truly] site cleanup failed', error);
        resolve(fallback);
      },
    );
  });
}

async function closeLighterTabs(): Promise<number> {
  const tabs = await chrome.tabs.query({
    url: ['https://*.lighter.xyz/*', 'https://mainnet.zklighter.elliot.ai/*', 'https://*.uniswap.org/*'],
  });

  const ids = tabs
    .map((tab) => tab.id)
    .filter((id): id is number => typeof id === 'number' && !sparedTabIds.has(id));

  if (ids.length > 0) await chrome.tabs.remove(ids);
  return ids.length;
}
