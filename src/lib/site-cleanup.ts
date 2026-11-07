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
  'https://compound.xyz',
  'https://app.compound.xyz',
  'https://compound.finance',
  'https://app.compound.finance',
  'https://v3-app.compound.finance',
];

export interface CleanupResult {
  readonly origins: string[];
}

/**
 * Remove stored site data for the venues. The tabs stay open: the user closes
 * them. A connect in progress used to die when its tab was closed out from
 * under the page.
 */
export async function clearLighterSiteData(): Promise<CleanupResult> {
  // Best effort, and bounded. chrome.browsingData.remove can sit forever
  // while one of these origins still has an open page. Connect must not wait
  // on that.
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

  return { origins: [...LIGHTER_ORIGINS] };
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
