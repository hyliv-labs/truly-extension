# Which Privacy Pools deployment Truly integrates with

Settled by on-chain evidence, not by repository names. Read this before
touching E3.

## Verdict

**`privacy-pools-core` (v1). Not the v2 monorepo.**

The plan said "Privacy Pools v2". That is wrong for Arbitrum: v2 exists only
on Sepolia. The Arbitrum USDC pool answers the **core** ABI.

| | privacy-pools-core | privacy-pools-v2-monorepo |
| --- | --- | --- |
| Arbitrum mainnet | **Yes — USDC, ETH and yUSND pools** | No |
| Only deployment found | Ethereum mainnet + Arbitrum | Sepolia (`11155111`), v6, 2026-04-30 |
| Architecture | Entrypoint + PrivacyPool + verifiers | AccessRouter, ASPRegistry, Keystore, PoolVault, PrivacyPoolRelay |
| SDK | `@0xbow/privacy-pools-core-sdk` | `core-sdk` / `evm-sdk` in-repo |

v2's contract set shares almost no surface with v1, so "v2" is a different
protocol rather than a newer revision to migrate onto. **No migration is
required**; the work already done targets the right protocol.

## Arbitrum One (42161) — USDC pool

Source: `privacy-pools-website/src/config/chainData.ts`, the config the live
app ships. Every value below was then confirmed against the chain.

| Item | Value |
| --- | --- |
| Pool | `0x3706e38af05bf0158BCdbB46239f8289980b093f` |
| Entrypoint | `0x44192215FEd782896BE2CE24E0Bfbf0BF825d15E` |
| Asset | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` (native USDC) |
| Scope | `19314316433070648921215665277427138450050666275686107272761703472573535400848` |
| Deployment block | `411197154` |
| Relayer | `https://fastrelay.xyz` |
| ASP | mainnet ASP (`https://api.0xbow.io`), even for Arbitrum |

The Arbitrum entrypoint is **not** the Ethereum one
(`0x6818809EefCe719E480a7526D76bD3e561526b46`). Using the mainnet address here
would send funds to a contract that does not exist on Arbitrum.

### On-chain verification

Read directly from the pool with the core ABI:

```
SCOPE()       19314316433070648921215665277427138450050666275686107272761703472573535400848
              -> identical to the website config
ASSET()       0xaf88d065e77c8cC2239327C5EDb3A432268e5831  -> native USDC
ENTRYPOINT()  0x44192215FEd782896BE2CE24E0Bfbf0BF825d15E  -> matches
currentRoot() 12532297889657784517283216386445406656081356704006893030878284906389279938757
dead()        false
pool bytecode 7720 bytes; entrypoint 122 bytes (proxy)
```

That the pool answers `SCOPE`, `ASSET`, `ENTRYPOINT`, `currentRoot` and `dead`
at all is the compatibility proof: those are core's surface, and v2 has no
such contract.

**The scope is read from the chain, not configured.** `SCOPE()` is the
authority; the config value is a cross-check.

## Relayer API

`https://fastrelay.xyz`, routes from `packages/relayer/src/routes/index.ts`:

| Route | Purpose |
| --- | --- |
| `GET /relayer/details?chainId&assetAddress` | fee and limits |
| `POST /relayer/quote` | fee commitment for a withdrawal |
| `POST /relayer/request` | submit the proof |

Live response for Arbitrum USDC:

```json
{ "feeBPS": "10", "feeReceiverAddress": "0xCcec679569E3c1E531e27F9561485f21f4B01eD1",
  "chainId": 42161, "assetAddress": "0xaf88...5831",
  "minWithdrawAmount": "0", "maxGasPrice": "40000000000" }
```

**Fee is 10 BPS (0.1%)** — far cheaper than assumed. On a $25 trade that is
2.5 cents, so the binding entry constraint is Lighter's 5 USDC deposit
minimum, not the relayer.

`minWithdrawAmount` is `"0"`: the relayer imposes no floor, so the floor must
be enforced by us.

### Request body (`zRelayRequest`, strict)

```ts
{
  withdrawal:    { processooor: Address, data: Hex },
  publicSignals: string[]   // EXACTLY 8
  proof:         { pi_a: [3], pi_b: [[2],[2],[2]], pi_c: [3], protocol?, curve? },
  scope:         bigint-ish,
  chainId:       number,
  feeCommitment?: { expiration, withdrawalData, asset, signedRelayerCommitment, extraGas, amount }
}
```

Snarkjs Groth16 output format, so the SDK's `WithdrawalProof` drops in. The
schema is `.strict()` — an extra field is rejected.

## Compatibility matrix

| Item | Status |
| --- | --- |
| Target protocol is core/v1 | **Verified** — pool answers core ABI on chain |
| Pool, entrypoint, asset, scope | **Verified** — config vs chain agree |
| Entrypoint `deposit(address,uint256,uint256)` | **Verified** — type signature matches the SDK ABI |
| Circuit artifacts | **Verified** — SHA-256 match the SDK's own frozen table; a real Groth16 proof generates and verifies in 1.3s |
| Relayer endpoint and fee | **Verified** — queried live |
| Relay request shape | **Verified** — read from the server's own zod schema |
| USDC address in our config | **Verified** — equals `ASSET()` |
| No v2 migration needed | **Verified** — v2 is Sepolia-only |
| **SDK version** | **Unverified** — the live app pins `1.4.0`; we installed `1.5.0` |
| **Withdrawal proof** | **Unverified** — only a *commitment* proof has been generated; the withdraw circuit and its 8 public signals are untested |
| **Note discovery against the real pool** | **Unverified** — `AccountService` has never run against Arbitrum |
| **ASP / screening flow** | **Unverified** — endpoint known, never called |
| `maxDeposit` | **Suspect** — config says `parseEther('10000')`, i.e. 1e22, against a 6-decimal asset. Do not treat as a USDC amount without checking |
| Deposit-event scanning | **Unverified** — start from block `411197154`, untested |

## Prerequisites for E3

1. Set `WXT_PRIVACY_POOL_ENTRYPOINT`, `WXT_PRIVACY_POOL_ADDRESS`,
   `WXT_PRIVACY_POOL_SCOPE` and `WXT_PRIVACY_POOL_RELAYER_URL` from the table
   above, then read `SCOPE()` at runtime and refuse to proceed if it disagrees.
2. Decide the SDK version. Either pin `1.4.0` to match the live app, or keep
   `1.5.0` and re-verify the artifact hashes, since the on-chain verifier is
   fixed and a mismatched zkey produces proofs that never verify.
3. Generate a **withdrawal** proof, not just a commitment proof, and check it
   yields exactly 8 public signals.
4. Run `AccountService` against Arbitrum from block `411197154` and confirm it
   finds a known deposit.
5. Only then wire the relayer: `details` → `quote` → `request`.

Entry is still gated on a pool deposit clearing ASP screening; none of the
above removes that wait.
