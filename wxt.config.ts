import { createRequire } from 'node:module';
import { defineConfig } from 'wxt';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);

export default defineConfig({
  hooks: {
    // The toolbar icon opens the side panel (background.ts). Chrome ignores
    // openPanelOnActionClick while a default_popup is set, so drop it.
    // popup.html is still built: Lighter's connect window opens it, and so
    // does the fallback for browsers without the side panel API.
    'build:manifestGenerated': (_wxt, manifest) => {
      if (manifest.action) delete manifest.action.default_popup;
    },
  },

  modules: ['@wxt-dev/module-react'],
  srcDir: '.',
  // Not '@': WXT already binds '@' and '~' to srcDir, which is the repo root here.
  alias: {
    '@truly': resolve('src'),
    /**
     * maci-crypto (transitively, via the Privacy Pools SDK) does
     * require("assert") and calls it at module level. There is no Node
     * builtin in a service worker and no `assert` package installed, so the
     * bundler's stub had no callable `.default` — the worker threw during
     * import and never registered (Chrome: "Service worker registration
     * failed. Status code: 15").
     */
    assert: resolve('src/shims/assert.cjs'),
  },
  /**
   * Keep the service-worker global shim in its OWN chunk.
   *
   * ESM evaluates every import before the importing module's body, so a shim
   * inlined into background.js runs too late: the SDK chunk has already been
   * evaluated and already thrown on URL.createObjectURL. Forcing it into a
   * separate chunk makes it a real import, and imports run in source order —
   * ours is first in background.ts.
   */
  vite: () => ({
    resolve: {
      // The Railgun SDK imports Node's crypto and buffer. In the offscreen
      // document those have to be the browser builds, or artifact checks and
      // AES throw on an empty module.
      alias: {
        crypto: require.resolve('crypto-browserify'),
        buffer: require.resolve('buffer/'),
        stream: require.resolve('stream-browserify'),
      },
    },
    plugins: [
      {
        name: 'truly:sw-globals-chunk',
        config(config: { build?: { lib?: unknown } }) {
          // NOT for the content-script builds. Those are lib mode (IIFE,
          // codeSplitting false), where manualChunks is rejected outright:
          // "output.manualChunks cannot be used when output.codeSplitting is
          // set to false". They never touch the SDK, so they do not need it.
          if (config.build?.lib) return;
          return {
            build: {
              rollupOptions: {
                output: {
                  manualChunks(id: string) {
                    return id.includes('src/shims/sw-globals') ? 'sw-globals' : undefined;
                  },
                },
              },
            },
          };
        },
      },
    ],
  }),

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
      // Uniswap's app, so Truly can be the wallet on a private swap there too.
      'https://*.uniswap.org/*',
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
      // Railgun: Arbitrum reads for the engine, proof artifacts, the PPOI
      // node, and the Arbitrum merkletree quicksync.
      'https://arbitrum.gateway.tenderly.co/*',
      'https://ipfs-lb.com/*',
      'https://ppoi.fdi.network/*',
      'https://rail-squid.squids.live/*',
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
        matches: ['https://*.lighter.xyz/*', 'https://*.uniswap.org/*'],
      },
    ],
  },
});
