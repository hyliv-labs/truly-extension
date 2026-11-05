# Security notes

## Fixed: trade owner keys collided with the Privacy Pools master secret

**Status: fixed. Owners now derive at `m/44'/60'/7702'/0/i`, and
`scripts/e1-check.ts` asserts no owner key across 25 indices equals either
master-key preimage. The guard was verified to fail on the old path.**

The original problem, kept because the reasoning is what matters:

E1 derives trade owner keys at `m/44'/60'/1'/0/i`. The Privacy Pools SDK
derives its master keys as:

```js
key1 = mnemonicToAccount(mnemonic, { accountIndex: 0 })  // m/44'/60'/0'/0/0
key2 = mnemonicToAccount(mnemonic, { accountIndex: 1 })  // m/44'/60'/1'/0/0
masterSecret = poseidon([key2])
```

viem's `accountIndex` maps to `m/44'/60'/<accountIndex>'/0/0`, so **owner #0 is
byte-for-byte the same private key as `key2`** — the preimage of
`masterSecret`. Verified directly: for the standard public test phrase, both
derivations produce an identical 32-byte key.

### Why it matters

Owner #0 is the key that signs on Lighter's website. It is the most exposed key
in the system, and it is also the preimage of half the material that derives
every note in the pool. Anyone who learns it can compute `masterSecret` with a
single Poseidon hash.

That alone does not drain the pool — `masterNullifier` is derived from a
different key and is still required — but reusing one key across two unrelated
cryptographic systems is indefensible, and it collapses a defence-in-depth
boundary that should exist. It is also the kind of thing a reviewer finds
immediately.

The risk grows if a user imports an existing Privacy Pools account, because
then the same phrase provably controls real funds in the pool.

### The fix, as applied

Owners derive at `m/44'/60'/7702'/0/i`. The SDK only ever reads accountIndex 0
and 1, so no owner index can coincide with either.

This changed every derived owner address, which is why it had to land before
any mainnet funds. Note derivation was unaffected — it depends on the mnemonic
alone — and `scripts/notes-check.ts` pins three precommitments captured before
the move to prove it.

## Deliberate choices

- **No `http()` RPC client for chain reads.** Every chain read goes through the
  anon-rpc harness; if it is unavailable, reads throw and trades refuse to
  start. A fallback would deanonymise the user at exactly the moment they
  believe they are protected. *Known exception:* the ERC-4337 bundler in
  `reshield.ts` uses `http()` directly, and the bootstrap specifier read uses
  `fetch` once. Both are stated limits, not oversights.
- **The anon-rpc passthrough worker is never used.** It is published and would
  appear to work, but it fulfils calls with an ordinary fetch and anonymises
  nothing.
- **Owner addresses are single-use**, and the index advances only on a
  completed trade.
- **Lighter sees the user's IP.** Lighter's API is not routed through anon-rpc,
  which only anonymises RPC. This is a stated limit for the README's CROPS
  section.
