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
  const closedTabs = await closeLighterTabs();

  await chrome.browsingData.remove(
    { origins: [...LIGHTER_ORIGINS] },
    {
      cookies: true,
      localStorage: true,
      indexedDB: true,
      cacheStorage: true,
      serviceWorkers: true,
      webSQL: true,
    },
  );

  return { origins: [...LIGHTER_ORIGINS], closedTabs };
}

async function closeLighterTabs(): Promise<number> {
  const tabs = await chrome.tabs.query({
    url: ['https://*.lighter.xyz/*', 'https://mainnet.zklighter.elliot.ai/*'],
  });

  const ids = tabs
    .map((tab) => tab.id)
    .filter((id): id is number => typeof id === 'number' && !sparedTabIds.has(id));

  if (ids.length > 0) await chrome.tabs.remove(ids);
  return ids.length;
}
