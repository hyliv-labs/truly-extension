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
    // background.type is NOT set here — it is set on defineBackground in
    // entrypoints/background.ts, which is what WXT reads. E3 made the worker a
    // module: the Privacy Pools SDK has dynamic import()s, and the default
    // single-IIFE worker bundle cannot code-split. See the comment there.
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
      // Bootstrap read of the anon-rpc specifier, on ETHEREUM mainnet.
      'https://ethereum-rpc.publicnode.com/*',
      // Where the anon-client proxies Arbitrum reads, and the 4337 bundler.
      'https://arb1.arbitrum.io/*',
      'https://public.pimlico.io/*',
      // The Privacy Pools relayer and the ASP. Without these the worker's
      // fetches are subject to CORS, and the JSON POSTs to /relayer/quote and
      // /relayer/request need a preflight those servers may not answer. Every
      // check of these ran in Node, which has no CORS, so the gap was
      // invisible until the extension actually ran.
      //
      // Overriding WXT_PRIVACY_POOL_RELAYER_URL or WXT_ASP_API_BASE needs a
      // matching entry here.
      'https://fastrelay.xyz/*',
      'https://api.0xbow.io/*',
    ],
    // Puts the anon-rpc worker at an opaque origin with its own CSP. The '*'
    // is a real wildcard, which is what keeps this entry stable even though
    // the asset directory is version-stamped.
    sandbox: {
      pages: ['anon-rpc/*/sandbox.html'],
    },

    content_security_policy: {
      // snarkjs compiles the Privacy Pools circuits to WebAssembly, and MV3's
      // default extension_pages policy blocks WASM outright. Without this the
      // proof builder fails in the offscreen document with a CSP error that
      // does not mention the circuits.
      extension_pages:
        "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';",
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
