# Lighter API — verified behaviour

What was checked against mainnet or found in the docs, and what is still
unknown. Written down because several of these differ from what the API
reference implies, and because an unknown that looks like a known one is how
a demo stalls.

## Verified against mainnet

Run `pnpm check:lighter` to re-confirm.

| Fact | Detail |
| --- | --- |
| Host | `https://mainnet.zklighter.elliot.ai/api/v1` |
| `createIntentAddress` | `POST`, **form-encoded**, not JSON |
| Its 200 response | `{code, intent_address}` — there is **no** `message` field |
| Intent address stability | Same owner always gets the same intent address. Resume depends on this. |
| `deposit/latest` | Needs `?l1_address=` or returns code 20001 |
| `accountsByL1Address` | Returns code **21100** for an owner with no account — the expected answer for a fresh owner, not an error |
| `fast_bridge_limit` | Read **"0"** on Arbitrum during the build |

## From the docs

- **Fast withdrawals settle via Arbitrum.** Secure withdrawals finalise on
  Ethereum. This is what makes E7's Arbitrum paymaster design viable, so it is
  worth re-checking if the exit path ever changes.
- Minimums: 5 USDC deposit (CCTP intent-address path), 4 USDC fast withdrawal,
  1 USDC secure withdrawal.
- `deposit/history` enumerates `failed | pending | completed | claimable`.
- Withdrawals can be requested over the API, but `tx_info` must be signed
  client-side with Lighter's own SDK/WASM signer. v1 sidesteps this by having
  the user withdraw on Lighter's site.

## Still unknown

Each of these is a guess if treated as known.

- **Whether `deposit/latest` uses the same status vocabulary as
  `deposit/history`.** Only `pending` has ever been observed from `/latest`.
  This is why `checkDeposit` treats the *existence of a Lighter account* as the
  real proof of credit, and the status string only as a secondary signal.
- **The $1 fast-withdrawal fee.** Not in the docs at all. Whether it sits on
  top of the 4 USDC minimum or inside it is unconfirmed, so the exit threshold
  is set conservatively.
- **What `fast_bridge_limit` means**, and what `"0"` implies. Undocumented.
  Assumed to mean no fast capacity, hence the ~15–20 minute deposit path.
- The numeric `tx_type` for a withdrawal via `sendTx`.
