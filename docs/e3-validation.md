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

## 3. AccountService — works, but the scan is not viable as-is

**BLOCKER.** `scripts/account-service-check.ts` constructs `DataService` and
`AccountService` against the real pool and begins scanning from block
`411197154`. It does not finish:

```
head block 521636396; 110439242 blocks since deployment
=> 11044 eth_getLogs calls at the SDK's default 10k chunk size
```

Eleven thousand sequential round trips. Impractical over a public RPC, and far
worse over anon-rpc, where every read is relayed through Tor. **This is the
real constraint on note discovery, not the matching logic.**

The official frontend does not hit an RPC for this at all: its config sets
`sdkRpcUrl: /api/hypersync-rpc?chainId=42161`, proxying through Hypersync,
which serves wide log ranges in one request. That is the same problem, already
solved, and it is why their `.env` has a `HYPERSYNC_KEY`.

Options, none yet chosen:
- Raise `blockChunkSize` far above 10k if a provider allows it
- Use a Hypersync-style endpoint for discovery only, accepting that it sees
  the query (it does not see which notes are ours, but it does see interest in
  this pool)
- Use the ASP's `mt-leaves`, which already returns all 603 state leaves and
  462 ASP leaves in one request

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
batches, not continuously. Two consequences:

- A re-shielded deposit may not be spendable for **days**, not minutes. The
  plan's "the next trade unlocks only after re-shield confirms" is therefore
  not achievable inside an event.
- Rejection is real: 1 of 240 deposits is not accepted.

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

## Remaining blockers for E3

1. **Note discovery is not viable over anon-rpc** (11,044 calls). Must be
   solved before entry can work.
2. **ASP batching is days, not minutes.** The one-trade-at-a-time design needs
   either multiple funded notes up front or a relaxed gate.
3. **No funded seed has been tested.** Discovery and spendability are unproven
   against real notes.
4. The relayer `quote` and `request` calls have never been exercised.
