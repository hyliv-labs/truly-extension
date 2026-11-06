# Truly

A Chrome extension that funds each perp trade from Privacy Pools through a
fresh owner address, and returns what's left to the pool when the trade closes.

**One trade, one address, never reused.** Lighter sees a brand-new account
every time, with no on-chain link to the last one.

> **Status: not production ready.** The money path is written and covered by
> offline tests, but no trade has been run on mainnet. See
> [What is not proven](#what-is-not-proven).

## Why

Perp venues see everything you do. Funding a fresh account from an address
that previously funded another account links the two, and so does reusing a
browser session. Truly breaks both links: a new key per trade, funded through
a relayer so nothing on chain connects it to you, and Lighter's site data
cleared between owners.

## How it works

```
Privacy Pools ──relayer──▶ fresh owner address ──▶ Lighter account
      ▲                                                   │
      └────── re-shield, gas paid in USDC ◀── withdraw ────┘
```

1. Derive a brand-new owner key — the index only ever increases
2. Allocate a Lighter deposit address for it
3. The Privacy Pools relayer funds that address, so no address of yours pays
4. Trade on Lighter, with the extension as the connected wallet
5. Withdraw the whole balance back to the owner address
6. Re-shield into Privacy Pools, with gas paid in USDC via EIP-7702 and
   Circle's Paymaster — the owner never needs ETH
7. Retire the key and clear Lighter's site data

## CROPS

**C — Confidentiality.** Chain reads go through
[anon-rpc](https://github.com/ethereum/anon-rpc), running a hash-pinned client
in a sandboxed worker, so the RPC provider does not learn which addresses are
being watched together. The default worker is `tor-js`, which really
anonymises; the published `passthrough` worker is deliberately *not* used,
because it fulfils calls with an ordinary fetch. Keys never leave the
background worker, and the seed is sealed with scrypt + AES-GCM.

**O — Observability.** The popup shows a live count of reads that actually
returned through anon-rpc, the current trade phase, and the reason whenever a
money-moving step is blocked. Nothing fails silently: if reads cannot be
anonymised, trades refuse to start and say so.

**P — Privacy.** One trade, one owner address, one Lighter account, never
reused — enforced by a burned index and covered by a regression test. Deposit
notes derive from the vault rather than the depositing address, so a re-shield
sent from a fresh address is still spendable by the same vault. Lighter's
cookies, localStorage and IndexedDB are cleared before *and* after every
trade.

**S — Security.** Owner keys derive at `m/44'/60'/7702'/0/i`, deliberately
clear of the Privacy Pools SDK's master-key paths — a collision found and
fixed during the build, with a test that fails if it returns. Circuit
artifacts are verified against the SDK's own hash table at build time. The
re-shield permit is capped at 1 USDC, so a compromised paymaster cannot drain
the balance.

### Stated limits

Being specific about these matters more than the claims above.

- **Positions are public.** Lighter is a public order book; Truly hides *who*
  is trading, not *what* is traded.
- **Lighter sees your IP.** anon-rpc anonymises RPC, not Lighter's own API or
  website. Routing those needs Tor or similar, which is out of scope for v1.
- **Screening-dependent.** Privacy Pools withdrawals depend on 0xbow's
  screening. A rejected re-shield leaves funds at the owner address.
- **Timing is a signal.** A withdrawal and the deposit it funds are close
  together in time. v1 does not add delay or batching.
- **Trade size is a signal.** Amounts are not split or rounded.
- **The browser is trusted.** A compromised browser sees everything.

## Develop

Requires Node 22+ and pnpm.

```bash
pnpm install
cp .env.example .env.local   # fill in the Privacy Pools addresses
pnpm dev                     # launches Chrome with the extension loaded
pnpm check                   # offline invariant tests
pnpm check:circuits          # generates and verifies a real Groth16 proof
pnpm check:lighter           # live check against Lighter's mainnet API
```

Build artifacts (the anon-rpc harness and the Privacy Pools circuits) are
fetched and hash-verified at build time, not committed.

## Load a build by hand

```bash
pnpm build
```

Then open `chrome://extensions`, enable **Developer mode**, choose **Load
unpacked**, and select `.output/chrome-mv3`.

Without `WXT_PRIVACY_POOL_*` set, the extension loads and the vault works, but
no trade can start — the money path is blocked and the popup says why.

## Layout

| Path | Role |
| --- | --- |
| `entrypoints/background.ts` | Service worker. Keys, trade state, provider requests. |
| `entrypoints/injected.ts` | EIP-1193 provider, MAIN world, announced over EIP-6963. |
| `entrypoints/lighter.content.ts` | ISOLATED relay between the provider and the worker. |
| `entrypoints/offscreen/` | anon-rpc harness, ZK proving, MetaMask recovery. |
| `entrypoints/approval/` | Signature and connect prompts. |
| `src/lib/` | Vault, notes, trade state, exit, re-shield, orchestrator. |
| `docs/` | Verified API behaviour and the open unknowns. |

Design notes worth reading before changing anything:
[privacy-pools.md](docs/privacy-pools.md),
[privacy-pools-recovery.md](docs/privacy-pools-recovery.md),
[lighter-api.md](docs/lighter-api.md), [security.md](docs/security.md).

## What is not proven

Stated plainly, because the tests above prove less than they might appear to.

- **No mainnet trade has been run.** Not one end-to-end cycle.
- **The provider has never been exercised against Lighter's site.** It is
  written to EIP-6963 and EIP-1193 but unverified against the real dapp.
- **The anon-rpc harness has never booted in the extension.** It is verified
  by package docs and manifest configuration only.
- **E7 has never executed on chain.** The paymaster encoding matches Circle's
  sample byte for byte and is asserted offline, but no user operation has been
  submitted.
- **MetaMask recovery is tested against fakes**, never a real MetaMask.
- Pool scope, relayer and entrypoint addresses are still unset.

## AI use

Built with Claude Code as a pair programmer: implementation, SDK and API
archaeology, and test design. Every external claim that the code depends on
was verified against source or a live endpoint rather than taken from a model
or from documentation alone — several turned out to contradict the docs, and
those are recorded in `docs/`.

## License

MIT — see [LICENSE](LICENSE).
