# E3 pre-implementation validation

Evidence for the six checks required before building the entry flow. Run
`pnpm check:withdrawal` and `pnpm check:account` to reproduce the live parts.

## 1. SDK version — pin 1.5.0

The live app pins `1.4.0`; this repo installs `1.5.0`. The risk was that the
two expect different circuits, since the on-chain verifier is fixed and a
mismatched zkey yields proofs that never verify.

**They expect identical circuits.** Both ship the same frozen
`ARTIFACT_HASHES`, all six values byte-identical:

| | commitment | withdraw |
| --- | --- | --- |
| wasm | `254d2130…` | `36cda227…` |
| vkey | `7d48b4eb…` | `666bd098…` |
| zkey | `494ae92d…` | `2a893b42…` |

They differ only in `AccountService` and the account error types — discovery
logic, not proving. 1.4.0 has no artifact-integrity table at all; 1.5.0 added
it.

**Recommendation: pin `1.5.0`.** It proves against the deployed verifier
(below), and it refuses to load an artifact whose hash is unknown, which 1.4.0
does not.

## 2. Withdrawal circuit — verified against the deployed verifier

`scripts/withdrawal-proof-check.ts` builds a real withdrawal proof over a
synthetic state and ASP tree (no funded deposit needed), in ~2.5s.

**Exactly 8 public signals**, matching both `zRelayRequest`'s
`z.array(z.string()).length(8)` and the verifier's `uint256[8]`. Observed
ordering, from a proof with `withdrawalAmount = 4000000` and `context = 12345`:

| # | Meaning |
| --- | --- |
| 0 | new commitment hash |
| 1 | existing nullifier hash |
| 2 | **withdrawn value** (`4000000`) |
| 3 | **state root** |
| 4 | state tree depth (`32` — LeanIMT pads) |
| 5 | **ASP root** |
| 6 | ASP tree depth (`32`) |
| 7 | **context** (`12345`) |

Proof shape is `pi_a[3]`, `pi_b[3][2]`, `pi_c[3]`, as the relayer's `zProof`
requires. All signals are strings.

**The decisive result:** `verifyProof` on the deployed WithdrawalVerifier
`0x022891F938Ae7fDC8Ab9Ead0FBf50aBA8C897D6d` (Arbitrum) **returns true**. The
zkey we ship matches the verifying key burned into the deployed contract.

Two silent conversions are required and are handled in the test: snarkjs emits
homogeneous coordinates with a trailing `1` the contract does not take, and G2
pair order is reversed relative to Solidity. Either wrong simply returns false.

Note the Arbitrum verifiers are the **same addresses** as Ethereum mainnet's —
deterministic deployment.

## 3. AccountService — RESOLVED, a full scan is 12 calls

The scan was first measured at **11,044 `eth_getLogs` calls**, which would not
work over anon-rpc. That turned out to be an artefact of the SDK's default
chunk size, not a property of the chain.

`scripts/log-range-check.ts` asks the provider what it will actually serve:

```
full range refused: query spans 110470437 blocks, but only 10000000 are allowed
pass 10000 / 100000 / 1000000 / 10000000 blocks
fail 50000000 blocks
Widest accepted window: 10000000 blocks => 12 calls for a full scan.
```

Arbitrum's public RPC serves **10,000,000-block ranges — 1000x the SDK's 10k
default.** `DataService` takes a per-chain `logFetchConfig`, so that default is
simply configurable:

```ts
new DataService([chainConfig], new Map([[42161, { blockChunkSize: 10_000_000 }]]))
```

With that, `scripts/account-service-check.ts` completes the full history scan:

```
Fetching deposits in 12 chunks, chunk size is: 10000000
Found 240 deposits
retrieveHistory completed against the live pool in 1.7s
an unfunded seed finds no notes, as it must
```

**12 calls, 1.7 seconds.** The 240 deposits independently match the ASP API's
`totalDeposits`, so the scan is seeing the whole pool — and with no Hypersync
dependency.

**Caveat, not yet fixed:** `DataService` takes an `rpcUrl` *string* and builds
its own transport — `createPublicClient({ transport: http(config.rpcUrl) })`.
It therefore talks to that URL **directly, bypassing anon-rpc**. Twelve calls
is cheap enough to route through anon-rpc, but doing so requires subclassing
`DataService` and overriding its fetch methods to use our own client. Until
that lands, discovery reveals to the RPC provider that this IP is interested in
the pool. It does not reveal which notes are ours.

Chunk size is also a property of *that* provider, not of Arbitrum: a different
`WXT_ARBITRUM_RPC_URL` may cap ranges far lower, so the setting belongs next to
the RPC config and a range error must fail loudly rather than silently retry.

The decisive negative still holds: an unfunded seed matches nothing. A false
match there would mean the matcher could mis-assign a real user's notes.

**Not yet verified:** discovery against a seed with real notes. That needs a
funded mnemonic, which no test can synthesise.

## 4. ASP screening lifecycle

A deposit is spendable when **its label appears in the ASP leaf set** — not
when the deposit transaction succeeds. The website's own client says so:
"Normal paths derive approval from the ASP leaf set."

Endpoints (`https://api.0xbow.io`, used for Arbitrum too), all requiring an
`X-Pool-Scope` header:

| Path | Returns |
| --- | --- |
| `/{chainId}/public/pool-info` | totals, accepted counts |
| `/{chainId}/public/mt-roots` | ASP root + the on-chain root |
| `/{chainId}/public/mt-leaves` | `aspLeaves` and `stateTreeLeaves` |

Live, for the Arbitrum USDC pool:

```
mtRoot        499752944287042352290331233123141516373761868218424916286213315985904064641
createdAt     2026-11-01T22:37:51Z      <-- 4.1 days old
onchainMtRoot 1253229788965778451728321638644540665608135670400689303087828490638927993875
              (identical to the pool's currentRoot())
aspLeaves 462 | stateTreeLeaves 603
totalDeposits 240 | accepted 239        <-- screening does reject
```

**The ASP root was 4.1 days old when measured.** Screening is published in
batches, not continuously. Rejection is also real: 1 of 240 deposits is not
accepted.

That looked like it broke the design — if every re-shield waited for the next
ASP batch, trades would be days apart. It does not, for one reason:

### Change notes inherit the original label

The ASP tree holds **labels**, not commitments. A label is assigned once, at
deposit. A partial withdrawal spends a note and writes a *new* commitment under
**the same label** — so the change note is approved the instant it exists,
because its label was approved days ago.

`scripts/withdrawal-proof-check.ts` proves this rather than asserting it:

```
pass the change note carries the ORIGINAL label (matches publicSignals[0])
pass generated a SECOND withdrawal, spending the change note
pass the deployed verifier ACCEPTS spending the change note under the UNCHANGED ASP root
```

The second proof is built against a **byte-identical ASP tree** — no leaf
added, no new screening — and the deployed Arbitrum verifier accepts it.

**So ASP batching delays only genuinely new deposits.** One screened deposit
funds a chain of trades, each leaving an immediately spendable remainder. The
re-shield of funds returning from Lighter is a new deposit and does wait for a
batch, but it is not what gates the next trade.

### The root a withdrawal must prove against

`scripts/asp-root-rule-check.ts`:

`PrivacyPool.sol`'s `validWithdrawal` modifier settles this:

```solidity
// Check the state root is known
if (!_isKnownRoot(_proof.stateRoot())) revert UnknownStateRoot();

// Check the ASP root is the latest
if (_proof.ASPRoot() != ENTRYPOINT.latestRoot()) revert IncorrectASPRoot();
```

The two roots are treated differently and it is easy to conflate them. The
**state** root goes through `_isKnownRoot()` — a genuine history. The **ASP**
root is **strict equality against one value**. The entrypoint exposes
`rootByIndex()`, but the pool never consults it: historical ASP roots are
readable and *not* accepted.

So a withdrawal proof is invalidated by any `updateRoot()` that lands between
proving and inclusion. **`IncorrectASPRoot` is therefore retryable, not
terminal** — refetch the tree, re-prove, resubmit. The label stays approved;
only the proof has to be rebuilt.

`scripts/asp-root-rule-check.ts` also confirms the ASP API's published `mtRoot`
is exactly the entrypoint's `latestRoot()`, so `mt-leaves` does describe the
tree the pool enforces.

**Rule adopted:** cache `mt-leaves`, and immediately before proving compare the
cached root against `latestRoot()` over anon-rpc, refetching only on
divergence. Fetching from `api.0xbow.io` seconds before every withdrawal would
tell 0xbow the exact time of each one; the root changes every few days, so the
cheap on-chain comparison gives the same safety without the timing leak.

### What actually limits trade frequency

Not screening — the remainder. Trades stall when the change note drops below
the next trade size plus the 0.1% relayer fee and the 1 USDC gas reserve.

## 5. USDC amounts

Read from `assetConfig(USDC)` on the entrypoint:

```
pool                 0x3706e38af05bf0158BCdbB46239f8289980b093f  (matches)
minimumDepositAmount 5000000      = 5 USDC   -> 6 decimals CONFIRMED
vettingFeeBPS        50           = 0.5% taken from every deposit
maxRelayFeeBPS       1000         = 10% ceiling the entrypoint enforces
```

**`maxDeposit` does not exist on the pool.** Neither `maxDeposit()` nor
`MAX_DEPOSIT()` responds. The `parseEther('10000')` in the website config is a
UI constant, never a contract value — so there was nothing to convert, and
replacing it with `parseUnits` would have invented a limit the chain does not
have.

Fees that now have to be modelled, neither previously accounted for:
- **0.5% entrypoint vetting fee** on every deposit, so a re-shield returns
  less than it sends
- **0.1% relayer fee** on withdrawal (`feeBPS: 10`, queried live)

And a hard floor: a re-shield landing under **5 USDC** is rejected by the
pool. With the 1 USDC gas reserve, an owner balance under ~6 USDC cannot be
re-shielded at all.

## 6. Runtime deployment checks — implemented

`src/lib/pool.ts` reads `SCOPE()`, `ASSET()`, `ENTRYPOINT()` and `dead()` and
refuses to proceed on any disagreement, returning the **on-chain** values so a
caller cannot keep using a stale configured scope. A pool that cannot answer
this surface is rejected — which is what a v2 address or a wrong chain looks
like.

## Status

Both blockers found in the first pass are resolved, and neither needed a new
dependency:

| Blocker | Resolution |
| --- | --- |
| 11,044 `eth_getLogs` calls | `blockChunkSize: 10_000_000` → **12 calls, 1.7s** |
| ASP batching is days | Change notes **inherit the approved label**; proven against the deployed verifier |

**E3 is unblocked.** What a deposit's lifecycle now looks like, and what the
UI must show:

- `pending-screening` — deposited on chain, label not yet in the ASP set. Not
  spendable. This is the only state that waits for a batch.
- `spendable` — label present. Its change notes are spendable immediately.
- `rejected` — the only exit is `ragequit`, which pays the **original
  depositor**, i.e. the retired owner address. That address's key stays
  derivable from the vault, so the funds are recoverable; the UI has to say so,
  because the address is otherwise never reused.

## Remaining before mainnet use

0. **Discovery bypasses anon-rpc.** `DataService` builds its own transport;
   it needs a subclass that routes through our client (see task 3 caveat).
1. **No funded seed has been tested.** Discovery and spendability are proven
   against synthetic trees and the deployed verifier, but not against a real
   note. This needs real mainnet USDC (5 USDC minimum, plus the 0.5% vetting
   fee) and an irreversible deposit — so it waits on an explicit go-ahead.
2. The relayer `quote` and `request` calls have never been exercised.
