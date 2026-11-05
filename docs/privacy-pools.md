# Privacy Pools SDK — findings

What reading `@0xbow/privacy-pools-core-sdk@1.5.0` established, and the one
thing that blocks E3.

## Established

- **Proving is snarkjs, so it is WebAssembly.** MV3's default
  `extension_pages` CSP blocks WASM outright, and the resulting error never
  mentions circuits. `'wasm-unsafe-eval'` is now set for that reason.
- **Proving must run in the offscreen document.** snarkjs needs DOM, workers
  and WASM; a service worker has none of them.
- **Artifacts are resolved with `new URL(artifactPath, baseUrl)`**, and
  `baseUrl` has no default — it must be passed, or the SDK throws. It is set to
  `chrome.runtime.getURL('privacy-pools/')`, an absolute extension URL; a bare
  relative path would resolve against the offscreen document and 404 inside
  the SDK.
- `new Circuits({ browser: true })` selects `fetch` over `fs`, which is the
  only option in an extension.

## The blocker

**The circuit artifacts are not obtainable from any published source.**

Four files are needed: `withdraw.wasm`, `withdraw.zkey`, `commitment.wasm`,
`commitment.zkey`.

- They are **not** shipped inside the npm package.
- `0xbow-io/privacy-pools-core` publishes releases, but **none carry release
  assets** (checked through v1.3.0).
- There is no `@0xbow/privacy-pools-circuits` or `-artifacts` package on npm.
- The SDK's own `circuits:setup` script compiles them from the monorepo's
  `circuits/` directory, which means a full circom compile and trusted setup —
  not viable inside the event, and the resulting keys would not match the
  deployed pool's verifier anyway.

**The ask for 0xbow:** the prebuilt artifacts matching the deployed Arbitrum
USDC pool, or the URL their own frontend serves them from. Everything else in
E3 is written and waiting; drop the four files into `public/privacy-pools/`
and proving works without further code changes.

Note that MV3 forbids remote code, so fetching them from a CDN at runtime is
not an alternative — they have to ship inside the extension.

## Still open for 0xbow

- Pool, entrypoint and relayer addresses for the Arbitrum USDC pool
- Minimum deposit and withdrawal, and the relayer's fee
- Whether a public withdrawal can be tied to other withdrawals from the same
  deposit via labels — if it can, separate accounts per trade are still
  linkable and the core claim weakens
- What happens to a re-shield deposit that screening rejects
