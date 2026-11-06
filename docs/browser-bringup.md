# Running in a real browser

Everything here was found the first time the extension was loaded into Chrome.
None of it is reproducible in Node, which is why `pnpm check` was green
throughout while the extension did nothing at all.

The common shape: **the component that reported the error was never the
component at fault.** Each failure surfaced somewhere downstream of its cause,
usually naming something that was working perfectly.

## How to diagnose, since the symptoms lie

Chrome's own error record is the fastest way in, and it is reachable over the
DevTools Protocol:

```bash
# Launch a THROWAWAY profile with the protocol enabled. Chrome 136+ ignores
# --remote-debugging-port on the default profile.
chrome --user-data-dir=/tmp/debug-profile --remote-debugging-port=9222
```

Then, from the `chrome://extensions` page's own context:

```js
chrome.developerPrivate.getExtensionsInfo({ includeDisabled: true }, console.log)
// -> manifestErrors, runtimeErrors, views, disableReasons
```

`chrome.developerPrivate.reload(id, { failQuietly: true })` reloads without
touching the UI, and `deleteExtensionErrors` clears stale ones first so what
you see next belongs to this load.

### Recovering an error you missed

A module that threw during import leaves an **errored module record**.
Re-importing it in the same page rethrows the original error, long after the
console event is gone:

```js
import('/chunks/offscreen-XXXX.js').catch(e => console.log(e.stack))
```

That is how `Class extends value undefined` was recovered after attaching too
late to see it.

## The failures, in the order they were found

### 1. `Service worker registration failed. Status code: 15`

The extension loaded, the popup rendered, the content script injected — and
every message sat unanswered, because the worker threw during import and so
never ran a line.

Two SDK dependencies assume Node:

| Dependency | Assumes | Symptom |
| --- | --- | --- |
| `maci-crypto` | `require("assert")` | `(0 , i.default) is not a function` |
| `ffjavascript` | `URL.createObjectURL` | `URL.createObjectURL is not a function` |

Both are called at **module level**, so neither is reachable by a guard in our
own code. `src/shims/assert.ts` and `src/shims/sw-globals.ts` supply them.

`ffjavascript` is the instructive one. It guards on `globalThis.Blob`, which
*does* exist in a service worker, and then calls `URL.createObjectURL`, which
does not — it was removed from `ServiceWorkerGlobalScope`. Its own data-URL
fallback was therefore never reached.

Two attempts failed before the shim worked, both worth knowing:

- A bare `import './sw-globals'` was **tree-shaken away**: no exports used,
  module dropped. It now exports a value the entrypoint reads.
- It was then **inlined into `background.js`**, which is too late — ESM
  evaluates every import before the importing body. `manualChunks` forces it
  into its own chunk, and imports run in source order.

Related: dynamic `import()` is **blocked** in a module service worker
(confirmed live: `TypeError`). That is why `ccipRead: false` is set on the
viem client — viem loads its CCIP handler by dynamic import.

### 2. The offscreen document loaded but was deaf

`mountOffscreenHost()` ran before `chrome.runtime.onMessage.addListener`, so
anything it threw killed the module before the listener existed. The document
sat there loaded and silent.

The giveaway: a ping addressed to the offscreen document was answered by the
**service worker's** default case — proof no offscreen listener existed.

The listener is now registered first, and the host mounted afterwards inside a
try/catch. `ping` reports `hostMounted` and `hostError`, so a caller can tell
*"offscreen is alive but anon-rpc is broken"* from *"offscreen is not there"*.

### 3. `events` was externalised to an empty object

The real throw behind #2:

```
TypeError: Class extends value undefined is not a constructor or null
```

`@metamask/safe-event-emitter` needs Node's `events`. It was not a dependency,
so vite externalised it to `__vite-browser-external` — which is literally
`module.exports = {}` — and `EventEmitter` came out `undefined`.

Fixed by installing the real `events` polyfill. Not worth hand-rolling:
`EventEmitter` semantics are subtle and already solved.

### 4. A blank env line is an empty string, not "unset"

`.env.example` leaves keys blank to mean *use the default*, and `config.ts`
used `??`, which only falls back on `undefined`.

`WXT_ANON_RPC_SPECIFIER=` therefore made the harness read the specifier
contract at address `''`:

```
invalid argument 0: hex string has length 0, want 40 for common.Address
```

Downstream, this surfaced as **"the pool does not answer the Privacy Pools v1
interface"** — which is untrue. `dead()`, `SCOPE()`, `ASSET()` and
`ENTRYPOINT()` all answer fine over a direct RPC. Every read was failing; the
pool guard was simply the first caller to notice.

`env()` now treats undefined, empty and whitespace-only alike as unset, and
`scripts/env-blank-check.ts` holds it there.

### 5. tor-js has no default gateway

With the specifier resolving, the worker booted and said so plainly:

```
tor-js worker: no gateway configured. ... There is no default gateway.
```

Browsers cannot open the raw TCP that Tor needs, so the worker relays through
a **KPS gateway**, which carries the traffic blind. The harness treats `config`
as opaque (SPEC §7.1) and hands it to the worker, whose schema is
`{ gateways: [...] }`.

`ANON_RPC_GATEWAYS` defaults to the gateway published in anon-rpc's
`adopters.json5`, whose own note reads:

> Demonstration gateway only: limited capacity, and it may disappear at any
> time — run your own for anything real.

**That is a live availability risk, not an engineering problem.** Privacy
Pools' own app takes the same approach and lets the user choose. Override with
`WXT_ANON_RPC_GATEWAYS` (comma-separated).

## What this changed about testing

`pnpm check` was green through every one of these. It always will be: none of
them exist outside a browser. The offline suite guards logic — index
allocation, sizing, retry policy — and cannot speak to module initialisation,
service-worker globals, bundler interop or transport.

So a browser load is not a final smoke test to run once. It is the only place
a whole category of defect is observable at all.
