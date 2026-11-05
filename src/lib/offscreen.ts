/**
 * Offscreen document lifecycle.
 *
 * Chrome permits exactly one per extension, and createDocument throws if one
 * already exists. The worker is torn down and restarted constantly under MV3,
 * so this runs far more often than it creates anything.
 */

const OFFSCREEN_PATH = 'offscreen.html';

/** Concurrent callers must not race into two createDocument calls. */
let creating: Promise<void> | null = null;

export async function ensureOffscreenDocument(): Promise<void> {
  if (await hasOffscreenDocument()) return;

  // A second caller awaits the first attempt rather than starting its own.
  if (creating) return creating;

  creating = chrome.offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      // WEB_RTC: the KPS transport. IFRAME_SCRIPTING: the §6 sandboxed iframe
      // the anon-client runs inside.
      reasons: [
        chrome.offscreen.Reason.WEB_RTC,
        chrome.offscreen.Reason.IFRAME_SCRIPTING,
      ],
      justification:
        'Hosts the anon-rpc sandboxed worker and Privacy Pools proof building, neither of which can run in a service worker.',
    })
    .catch(async (error: unknown) => {
      // Lost a race with another context: that is a success, not a failure.
      if (await hasOffscreenDocument()) return;
      throw error;
    })
    .finally(() => {
      creating = null;
    });

  return creating;
}

async function hasOffscreenDocument(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
  });
  return contexts.length > 0;
}
