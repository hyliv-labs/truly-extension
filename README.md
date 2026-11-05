# Truly

A Chrome extension that funds each perp trade from a shielded pool through a
fresh owner address, and returns what's left to the pool when the trade closes.
One trade, one address, never reused.

> Status: early. The scaffold builds and loads; the trade flow is not wired up yet.

## Develop

Requires Node 22+ and pnpm.

```bash
pnpm install
pnpm dev          # launches Chrome with the extension loaded, hot-reloading
```

## Load a build by hand

```bash
pnpm build
```

Then open `chrome://extensions`, turn on **Developer mode**, choose
**Load unpacked**, and select `.output/chrome-mv3`.

## Layout

| Path | Role |
| --- | --- |
| `entrypoints/background.ts` | Service worker. Holds keys, runs the trade state machine. |
| `entrypoints/injected.ts` | EIP-1193 provider, MAIN world. Announced over EIP-6963. |
| `entrypoints/lighter.content.ts` | ISOLATED relay between the provider and the worker. |
| `entrypoints/offscreen/` | Hosts the Anon-RPC harness and proof building — both need a DOM. |
| `entrypoints/popup/` | Unlock, balance, trade progress. |

### Why the provider is two files

The provider has to run in the page's MAIN world for the dapp to reach it, but
MAIN-world scripts can't call `chrome.runtime`. So `injected.ts` speaks
`window.postMessage` to `lighter.content.ts`, which is the only half that can
talk to the background worker.

### Why there's an offscreen document

An MV3 service worker has no DOM, no WebRTC and no workers. The Anon-RPC harness
and the proof builder need all three, so the worker delegates to an offscreen
page. Chrome permits exactly one per extension.

## License

MIT — see [LICENSE](LICENSE).
