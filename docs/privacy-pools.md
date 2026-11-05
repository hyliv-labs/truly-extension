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

## The artifacts — solved

They looked unobtainable: not in the npm package, no release assets on
`0xbow-io/privacy-pools-core` through v1.3.0, and no `-circuits` or
`-artifacts` package on npm. Compiling them locally would need a trusted setup
whose keys would not match the deployed verifier.

**They are committed to the repository**, just never released.
`scripts/fetch-circuits.ts` pulls them at build time from a pinned commit.

**Six files, from two different directories.** The split matters and comes
from the SDK's own `scripts/copy_circuits.sh`, not from guesswork:

| File | Source |
| --- | --- |
| `withdraw.zkey`, `commitment.zkey` | `packages/circuits/trusted-setup/final-keys/` |
| `withdraw.vkey`, `commitment.vkey` | `packages/circuits/trusted-setup/final-keys/` |
| `withdraw.wasm`, `commitment.wasm` | `packages/circuits/build/<name>/<name>_js/` |

The `final-keys` zkeys are the post-ceremony ones that match the deployed
verifier — **not** the `groth16_pkey.zkey` files under `build/`, which are the
pre-ceremony keys and would produce proofs that never verify. The `.vkey`
files are needed too, which is easy to miss.

**They must live under `artifacts/`.** The SDK resolves each file as
`<baseUrl>/artifacts/<name>`. Hosting them at the base instead gives a 404
*inside* the SDK that surfaces only as `Failed to generate proof`, naming no
path. This cost a debugging cycle and is the single easiest thing to get wrong.

**Integrity.** The SDK carries a frozen `ARTIFACT_HASHES` table and refuses to
load any artifact missing from it. `fetch-circuits.ts` verifies the SHA-256 of
every download against that same table, so a corrupted or substituted proving
key fails at build time rather than producing proofs that never verify. All six
match.

MV3 forbids remote code, so these ship inside the extension (~23 MiB) and are
never fetched at runtime.

**Verified end to end.** `pnpm check:circuits` generates a real Groth16
commitment proof against the bundled files and verifies it. **Proving takes
~1.3s**, so no part of the UI needs to plan for a long wait.

## snarkjs never lets the process exit

snarkjs starts a bn128 worker pool and never shuts it down, and the handle is
not reachable from the SDK's bundled scope. In Node the process therefore hangs
indefinitely *after* the proof has succeeded, which is indistinguishable from
proving never returning — it cost two runs that looked like 15-minute hangs.
`circuits-check.ts` exits explicitly for that reason.

This does not affect the extension, where the offscreen document is torn down
by Chrome rather than by the process exiting. It does mean any future Node-side
proving script must exit explicitly.

## Still open for 0xbow

- Pool, entrypoint and relayer addresses for the Arbitrum USDC pool
- Minimum deposit and withdrawal, and the relayer's fee
- Whether a public withdrawal can be tied to other withdrawals from the same
  deposit via labels — if it can, separate accounts per trade are still
  linkable and the core claim weakens
- What happens to a re-shield deposit that screening rejects
