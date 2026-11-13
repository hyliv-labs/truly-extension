# Truly (Ghosty)

## NEAR HACKATHON: private cross-chain exit and entry with NEAR Intents

**Problem.** A shielded balance is only private until you spend it. Leaving
Railgun normally means unshielding to an address you own, then bridging, and
that address links the pool exit to wherever the money goes next. Coming in
is the same problem in reverse.

**What we built.** Ghosty (this extension) now uses NEAR Intents 1Click as its
cross-chain layer, in both directions:

- **Send out.** Shielded USDC on Arbitrum is unshielded *straight into a
  one-time 1Click deposit address*, and arrives on any of 30+ chains as the
  asset you pick (ZEC, USDCx on Aleo, SOL, BTC, USDC on Base/Solana/NEAR…).
  The transaction is signed by a fresh, never-reused owner key. No address of
  yours ever sits between the shielded pool and the destination. If solvers
  cannot fill it, 1Click refunds to that fresh owner and Ghosty shields the
  refund back into Railgun.
- **Bring in.** Ghosty quotes a one-time deposit address on the origin chain.
  You pay it from any wallet, ideally a shielded one: Zashi (shielded ZEC to the
  transparent deposit address) or an Aleo wallet (private-to-public transfer).
  The USDC lands at a fresh owner on Arbitrum, and Ghosty shields it into
  Railgun.
- **Zcash from any wallet.** The deposit card shows a ZIP-321 QR
  (`zcash:<address>?amount=…`) that Zashi, Zingo, YWallet and Edge scan with
  the amount filled in. A unified address (`u1…`) pasted from any wallet is
  reduced to its transparent receiver, which 1Click accepts, and the panel shows
  which `t1…` that is. Entries are quoted FLEX_INPUT, so an exchange that takes
  its withdrawal fee out of the amount, or a second payment to make up a short
  one, still swaps.

So value moves between Railgun, Zcash, Aleo and 30+ public chains with no
public address of the user's in between.

**What NEAR does here.** NEAR Intents is the settlement layer: 1Click gets a
quote from solvers, returns a one-time deposit address, and delivers on the
destination chain or refunds. Ghosty never bridges or swaps itself.

### Try it

1. `pnpm install && pnpm build`, then load `.output/chrome-mv3` as an unpacked
   extension (chrome://extensions → Developer mode → Load unpacked).
2. Create or restore a vault. Open the side panel.
3. **Bring in:** home → **Any chain · NEAR Intents** → **Bring in** → pick
   *USDC on Ethereum* (or ZEC, USDCx on Aleo, SOL) → amount → your refund
   address → the dry quote appears → **Get deposit address** → pay exactly the
   shown amount to the shown address → see the steps go *deposit → solvers fill
   → USDC at a fresh address → shielded into Railgun*.
4. **Send out:** **Any chain · NEAR Intents** → **Send out** → pick a
   destination asset → amount of shielded USDC → your address on that chain →
   **Send privately** → see *unshield into NEAR Intents → solvers fill →
   delivered*, with the Arbitrum unshield and destination tx links.
5. **One journey:** after a Bring in lands, **Trade with it** opens Go ghost
   on the fresh balance (also from a home card if the panel was closed while it
   finished). **Add funds** and a Go ghost with too little both offer the
   private route in; after **Bring back**, **Send out to another chain** opens
   the exit. So: shielded ZEC → Railgun → a fresh account on Uniswap or
   Lighter → back into Railgun → out to any chain.
6. Without the extension: `pnpm check:intents` dry-quotes every featured route
   in both directions; `pnpm check` runs the offline checks
   (`scripts/near-intents-check.ts`) for the fee math and quote validation.

### Built during the hackathon

Everything NEAR-related was written in the window. Diff:
[`pre-hackathon...near-intents`](https://github.com/hyliv-labs/truly-extension/compare/pre-hackathon...near-intents).
The extension itself (Railgun funding of fresh owners, Lighter/Uniswap/Compound
venues) existed before and is the baseline.
Hyperliquid, 1inch, Aave, dYdX and Lido were also added in the window (12–13
Nov). They are not NEAR integrations and are not part of what is submitted for
judging, except that Lido is funded through a NEAR Intents exit; a Bring in can
fund any of them the same way it funds any venue.

| File | What it does |
| --- | --- |
| `src/lib/near-intents.ts` | 1Click client; checks every quote against the request (recipient, refund address, assets, amount, signature, expiry) before money moves; exact Railgun fee math |
| `src/lib/intents-private.ts` | Exit and entry state machines: quote, unshield to the deposit address, poll status, shield back; resumable after a worker restart |
| `src/lib/intents.ts` | The saved view the panel renders; what each 1Click status means, including a short deposit |
| `src/lib/zcash.ts` | Zcash addresses from any wallet: t1/t3/tex1 checks, unified-address decoding (F4Jumble, ZIP-316) to the transparent receiver, ZIP-321 payment links; tested against the official ZIP-316 vectors |
| `entrypoints/popup/Intents.tsx` | Send out / Bring in screens with a live dry quote; deposit QR and payment link |
| `scripts/near-intents-check.ts`, `scripts/near-intents-live-check.ts` | Offline checks and live dry quotes |

### Design notes

- **Exact deposit.** Railgun takes 0.25% inside the unshield
  (`base = amount − ⌊amount·bps/10000⌋`). Ghosty quotes EXACT_INPUT for the
  amount that will actually arrive and unshields the matching gross, so the
  deposit equals `amountIn` to the unit. Rounding the other way would put one
  extra unit on the address and trigger a refund with a fee.
- **Flexible entries.** A person paying from their own wallet cannot always
  hit an amount to the unit (exchange fees, "send max"). Entries ask for
  FLEX_INPUT: 1Click swaps any total from 1% under the quote upward, and adds up
  several payments to the same address. If the total is short, the panel shows
  how much more to send. Confidential mode does not offer FLEX_INPUT, so there
  the entry stays EXACT_INPUT and the panel says a short deposit is refunded.
- **Quote checks.** A quote whose echoed recipient, refund address, assets or
  amount differ from the request is refused. So is one without a signature, a
  deposit address, or with an inactive address.
- **Saved before moving.** The quote (deposit address, correlation id, 1Click's
  signature, deadlines) is stored before the proof is built. A retry continues
  the same deposit address and never builds a second proof for it.
- **Refunds stay private.** Exit refunds go to the fresh owner and are shielded
  back automatically. Entry refunds go to the user's own origin address.
- **No leaks to dapps.** An owner in a NEAR Intents move is never exposed to a
  connected site (`eth_accounts` returns nothing), and abandon is refused while
  money is with 1Click.
- **Change note.** Only the 1x2/2x2/3x2 Railgun circuits are bundled, so an exit
  always leaves a little shielded change.

### Limits (stated, not hidden)

- **Confidential Intents** needs a 1Click partner key. Without one, quotes are
  *public intents*: the chain shows no link between the Railgun exit and the
  delivery, but 1Click and solvers can match deposit to payout. A key can be
  entered at runtime in the panel; none is bundled.
- 1Click is called directly, not over anon-rpc, so 1Click sees the user's IP
  next to the quote.
- Zcash routes use **transparent** addresses: 1Click refuses unified and
  Sapling addresses (checked live). Ghosty uses the transparent receiver of a
  pasted unified address and says so; a unified address with no transparent
  part, or a `zs1…`, is refused with where the wallet shows its `t1…`. The
  privacy comes from paying from a shielded balance, or receiving into a
  wallet that shields. Aleo deliveries arrive as a public balance.
- Exact amounts and timing can correlate deposit and delivery; round amounts
  and waiting help.
- Bring in uses Circle's paymaster when the fresh owner has no ETH; up to
  ~1 USDC of the permit reserve can stay at the retired owner.
- **Gas link on Send out.** The unshield is a normal transaction, so the fresh
  owner needs a little ETH. Ghosty tops it up from an earlier owner of the same
  vault, which links those two owners on chain (not the user's wallet, and not
  the destination). A Railgun broadcaster would remove this link; it is not
  wired in yet.
- Live-verified so far: every featured route quotes in both directions (dry),
  and real (non-dry) quote and status responses match the checks. The first
  money-moving runs are listed below as they happen.

---

A Chrome extension that funds each perp trade from Privacy Pools through a
fresh owner address, and returns what's left to the pool when the trade closes.

**One trade, one address, never reused.** Lighter sees a brand-new account
every time, with no on-chain link to the last one.

> **Status: not production ready.** It has been run on Arbitrum mainnet with
> small real amounts (Railgun-funded fresh owners trading on Lighter, then
> shielding back). The NEAR Intents section above says which of its own steps
> are live-verified. [What is not proven](#what-is-not-proven) was written
> before those mainnet runs and is kept as the original record.

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

## Hyperliquid

Hyperliquid is a venue like Lighter, Uniswap and Compound: its own fresh
address, funded from Railgun, brought back into Railgun, never reused.

```
Railgun ──unshield──▶ fresh owner ──USDC transfer──▶ Bridge2 ──▶ Hyperliquid account
   ▲                                                                    │
   └── shield (ETH gas, or USDC via paymaster) ◀── Arbitrum ◀── withdraw3 ┘
```

- **Go ghost** unshields onto the fresh owner, which sends the USDC to
  Hyperliquid's Arbitrum bridge. The bridge credits whoever sent the USDC,
  so the unshield never goes to the bridge directly (the sender would be the
  Railgun contract). The signed transfer is saved before it is broadcast and a
  retry resends those bytes, so a crash never deposits twice. Minimum 6 USDC:
  Hyperliquid loses deposits under 5 and keeps 1 on the way back.
- **Trade** on app.hyperliquid.xyz with Ghosty as the wallet. Enable trading
  asks Ghosty to sign Hyperliquid's ApproveAgent; after that the site's own
  agent key signs orders, so there is no prompt per order. Hyperliquid's
  site data is cleared between Hyperliquid addresses.
- **Bring back** refuses while a position, an open order or a non-USDC spot
  token remains (Ghosty never trades for you). Otherwise the owner signs a
  `withdraw3` to itself, saved with its nonce before it is sent so a retry can
  only resend the same withdrawal; Hyperliquid's ledger confirms whether a
  send whose answer was lost went through. The USDC reaches Arbitrum in 3 to 5
  minutes and is shielded into Railgun. A withdrawal you made on Hyperliquid's
  own site is found in the ledger and waited for too. The address is retired
  only once Hyperliquid shows nothing left; otherwise what arrived is shielded
  and the account stays open for another Bring back.
- Unified-account mode is handled offline (the spot balance is the account);
  not verified live.
- The recovery scan reads every derived address's Hyperliquid balance too,
  and shows a failed read instead of an empty account.

Verified: the `withdraw3` and `ApproveAgent` signatures match Hyperliquid's
own Python SDK byte for byte (`scripts/hyperliquid-check.ts`); the live
`/info` and ledger reads parse; Bridge2 reads as not paused. On
app.hyperliquid.xyz, Hyperliquid's own Connect modal lists Truly and picking
it connects a fresh owner (browser test, throwaway vault). The site then asks
the wallet to accept its Terms of Use before Enable trading; the test stops
there, since accepting terms is the user's call. Enable trading's
ApproveAgent request, sent to the provider directly, is shown, approved and
recovers to that owner. viem refuses Hyperliquid's type names (they contain a
`:`), so these are hashed by `src/lib/typed-data.ts` with viem's own encoder
minus that one check.

Not yet run with money: a bridge deposit, a trade, a withdrawal. Whether the
1 USDC fee comes out of the amount or on top is not documented; a live ledger
row shows the amount paid on Arbitrum with the fee listed apart, and if a
full-balance withdrawal is refused Bring back asks once for 1 USDC less.
Stated limits:
Hyperliquid's docs call Bridge2 the legacy bridge and prefer CCTP, though its
site still deposits Arbitrum USDC through Bridge2; a withdrawal can be refused
when the bridge is short of liquidity, in which case nothing leaves Hyperliquid
and Bring back says so. The extension calls Hyperliquid's API directly, as
the site does, so Hyperliquid sees the same IP as the site.

## 1inch, Aave, dYdX, Lido

Four more apps on one shared core (`src/lib/app-venues.ts`, `app-venue-private.ts`,
`app-venue-checks.ts`). Each gets its own fresh address, funded from Railgun; the
user acts on the app's own site with Ghosty as the wallet; Bring back refuses while
the app still holds anything for that address, then shields every token the
address holds (including ones it received in a swap) and retires it.

| App | Site | Funded with | Bring back refuses while |
| --- | --- | --- | --- |
| 1inch | 1inch.com/swap | USDC + gas | nothing (a swap leaves tokens on the address) |
| Aave v3 | app.aave.com (Arbitrum market) | USDC + gas | any reserve's aToken or debt token, or `getUserAccountData`, shows a position; reserves read from the Pool each time |
| dYdX v4 | dydx.trade | USDC + gas | equity, a position or an order on dYdX; USDC in the dYdX wallet or on Noble; a CCTP leg possibly in flight |
| Lido | stake.lido.fi (Arbitrum direct staking) | ETH, delivered by a NEAR Intents exit | the ETH left and no wstETH arrived yet (Lido's slow route) |

- **dYdX** derives its account from a "dYdX Chain Onboarding" signature. Ghosty
  records the resulting `dydx1…`/`noble1…` addresses when the site asks, never the
  signature, and can derive them itself (signatures are deterministic). The
  derivation matches dYdX's own `v4-client-js`. dydx.trade switches to Ethereum
  mainnet before that signature; for that site only, Ghosty accepts chain 1 for
  signing and refuses any transaction until the site switches back to Arbitrum.
- **Lido** stakes ETH, not USDC. Go ghost on Lido sends USDC out of Railgun through
  NEAR Intents (USDC → ETH on Arbitrum, 1Click) to the fresh address, so no earlier
  address pays it gas. Bring back shields the wstETH into the Railgun wallet behind
  the same recovery phrase; Ghosty's balance shows USDC only, so it is not shown there.
  Unstaking wstETH is an Ethereum-mainnet affair and is not offered here.

Verified without money (browser test on the live sites, throwaway vault): each
site sees Ghosty over EIP-6963 and gets its own fresh owner; on dydx.trade the
switch to chain 1, the two onboarding signatures (identical), the refused
transaction, the switch back and the recorded `dydx1…` address (equal to dYdX's
own derivation of that signature). Live reads: Aave's check passes an empty
address and refuses a real supplier; dYdX's check refuses a real account with
USDC left; 1Click quotes USDC → ETH on Arbitrum.

Not yet run with money. Stated limits: dYdX's v9.9 upgrade (planned 17 Nov 2026)
moves its USDC to Injective and its docs say withdrawals to other chains are
rejected afterwards; Ghosty warns on the Go ghost screen and has not verified that
Withdraw to Arbitrum keeps working. dYdX's deposit leaves an unlimited USDC
allowance to Skip's spender on the address (harmless once the address is
shielded and retired). The dYdX transit rule is a time window (45 minutes), not a
proof. 1inch limit and Fusion orders do not lock funds, so an order left open
simply fails after Bring back.

## CROPS

The Ethereum Foundation's Mandate defines the Protocol cluster's job through
**CROPS: Censorship Resistance, Open Source and Free (as in Freedom), Privacy,
Security** ([EF Protocol priorities,
2026-09-07](https://blog.ethereum.org/2026/09/07/protocol-priorities)). These
are protocol properties rather than an app checklist, so what follows is how
Truly relates to each — not a claim to satisfy them.

**CR — Censorship Resistance.** Entry is a relayed withdrawal and exit is an
ERC-4337 user operation, so both depend on a relayer and a bundler that can
refuse service. Truly does not fix that: a rejected re-shield leaves funds at
the owner address, recoverable from the seed. Privacy Pools withdrawals are
also screening-dependent by design, which is a deliberate compliance
trade-off, not censorship resistance.

**O — Open Source and Free.** MIT, no API keys, no backend, no account. Every
dependency is public. Build artifacts are fetched from public repositories and
hash-verified rather than vendored opaquely.

**P — Privacy.** One trade, one owner address, one Lighter account, never
reused — enforced by a burned index and covered by a regression test. Deposit
notes derive from the vault rather than the depositing address, so a re-shield
sent from a fresh address is still spendable by the same vault. Chain reads go
through [anon-rpc](https://github.com/ethereum/anon-rpc), running a
hash-pinned client in a sandboxed worker; the default is `tor-js`, which
really anonymises, and the published `passthrough` worker is deliberately not
used because it fulfils calls with an ordinary fetch. Lighter's cookies,
localStorage and IndexedDB are cleared before *and* after every trade.

**S — Security.** Owner keys derive at `m/44'/60'/7702'/0/i`, deliberately
clear of the Privacy Pools SDK's master-key paths — a collision found and
fixed during the build, with a test that fails if it returns. Circuit
artifacts are verified against the SDK's own hash table at build time. The
seed is sealed with scrypt + AES-GCM and never leaves the background worker.
The re-shield permit is capped at 1 USDC, so a compromised paymaster cannot
take more than that.

### Stated limits

Being specific about these matters more than the claims above.

- **Positions are public.** Lighter is a public order book; Truly hides *who*
  is trading, not *what* is traded.
- **Lighter sees your IP.** anon-rpc anonymises RPC, not Lighter's own API or
  website. Routing those needs Tor or similar, which is out of scope for v1.
- **Screening-dependent.** Privacy Pools withdrawals depend on 0xbow's
  screening. A rejected re-shield leaves funds at the owner address.
- **The bundler is contacted directly.** The ERC-4337 bundler call in
  `reshield.ts` uses a plain HTTP transport, not anon-rpc, so that provider
  sees the request's origin IP. Chain *reads* are anonymised; this one write
  path is not.
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

Written before the mainnet test runs of 6–10 Nov 2026, and kept as that
record. Stated plainly, because the tests above prove less than they might
appear to.

- **E3, the entry path, is not built.** No relayer client, no withdrawal
  proof, no note discovery. Without it there is no way to fund a trade from
  the pool, so no end-to-end cycle exists to run.
- **Nothing calls the re-shield.** `reshieldActiveTrade` has no trigger yet.
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
