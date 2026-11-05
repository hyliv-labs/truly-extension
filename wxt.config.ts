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
      'https://*.lighter.xyz/*',
      // TODO(E5): confirm against Lighter's real app + API hostnames before relying on this.
    ],
    web_accessible_resources: [
      {
        // The MAIN-world provider is injected by the ISOLATED relay.
        resources: ['injected.js'],
        matches: ['https://*.lighter.xyz/*'],
      },
    ],
  },
});
