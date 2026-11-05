/**
 * E5, ISOLATED half.
 *
 * The EIP-1193 provider must run in the page's MAIN world to be reachable by
 * Lighter's dapp code, but MAIN-world scripts have no `chrome.runtime`. So this
 * ISOLATED-world script is the relay: it injects the MAIN-world provider and
 * ferries messages between it and the background worker over window.postMessage.
 */

export default defineContentScript({
  matches: ['https://*.lighter.xyz/*'],
  runAt: 'document_start',

  async main() {
    await injectMainWorldProvider();

    window.addEventListener('message', async (event) => {
      if (event.source !== window) return;
      const data = event.data;
      if (data?.target !== 'truly:relay') return;

      // TODO(E5): forward to the background worker and post the reply back as
      // { target: 'truly:provider', id, result | error }. Every request must be
      // refused while no trade is active.
      console.debug('[truly] relay received', data);
    });
  },
});

async function injectMainWorldProvider(): Promise<void> {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('/injected.js');
  script.type = 'module';
  // document_start can run before <head> exists.
  (document.head ?? document.documentElement).prepend(script);
  script.onload = () => script.remove();
}
