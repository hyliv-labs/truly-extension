import { defineConfig } from 'wxt';
import { resolve } from 'node:path';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  srcDir: '.',
  // Not '@': WXT already binds '@' and '~' to srcDir, which is the repo root here.
  alias: {
    '@truly': resolve('src'),
  },
  manifest: {
    name: 'Truly',
    // No background.type = 'module': WXT bundles the worker into one file and
    // strips it. That is safe here because the anon-rpc harness ships both its
    // Chromium and Firefox modes in that bundle, precisely so a service worker
    // never has to import() on demand.
    description:
      'Fund every Lighter trade from Privacy Pools through a fresh owner address, then re-shield.',
    permissions: [
      'storage',
      // Decrypted key material lives in chrome.storage.session, never a worker global:
      // the MV3 service worker is torn down after ~30s idle.
      'alarms',
      // The 15-minute auto-lock is an alarm, not a setTimeout, for the same reason.
      'offscreen',
      // Anon-RPC harness (WebRTC + sandboxed iframe) and ZK proof building need a DOM.
      'browsingData',
      // E10: clear Lighter site data between owner addresses.
      'tabs',
    ],
    host_permissions: [
      // The app (app.lighter.xyz) and the marketing site.
      'https://*.lighter.xyz/*',
      // Lighter's API is on a DIFFERENT registrable domain, so the pattern
      // above does not cover it. E4/E6 call this host from the worker.
      'https://mainnet.zklighter.elliot.ai/*',
    ],
    // Puts the anon-rpc worker at an opaque origin with its own CSP. The '*'
    // is a real wildcard, which is what keeps this entry stable even though
    // the asset directory is version-stamped.
    sandbox: {
      pages: ['anon-rpc/*/sandbox.html'],
    },

    content_security_policy: {
      // blob: in script-src is the easy one to miss: the worker runtime and
      // bundle are importScripts'd from blob URLs, and importScripts is checked
      // against script-src, not worker-src. Without it the load fails with a
      // message that never mentions CSP.
      sandbox:
        "sandbox allow-scripts; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; child-src 'self' blob:; worker-src 'self' blob:; connect-src *;",
    },

    web_accessible_resources: [
      {
        // The MAIN-world provider is injected by the ISOLATED relay.
        resources: ['injected.js'],
        matches: ['https://*.lighter.xyz/*'],
      },
    ],
  },
});
