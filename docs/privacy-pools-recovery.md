# Recovering existing Privacy Pools notes

Research only — nothing here is implemented yet. Every claim below was read
from source and, where marked, reproduced locally.

## Short answer

A user who deposited through privacypools.com with MetaMask **can** have their
notes recovered by this extension, using **only their wallet and one
signature**. No separate mnemonic is required — *provided* they used the
wallet-signature account type rather than a written-down phrase. Both exist,
and the two are not interchangeable.

## 1. How the secrets are generated

`generateMasterKeys(mnemonic)` in the SDK
(`@0xbow/privacy-pools-core-sdk`, read from `dist/esm/index-CQrg64NA.js`):

```js
key1 = mnemonicToAccount(mnemonic, { accountIndex: 0 }).getHdKey().privateKey
key2 = mnemonicToAccount(mnemonic, { accountIndex: 1 }).getHdKey().privateKey
masterNullifier = poseidon([key1])
masterSecret    = poseidon([key2])
```

Then, per deposit:

```js
generateDepositSecrets(keys, scope, index):
  nullifier = poseidon([keys.masterNullifier, scope, index])
  secret    = poseidon([keys.masterSecret,    scope, index])
precommitment = hashPrecommitment(nullifier, secret)   // poseidon
```

The input is a **BIP-39 mnemonic**. MetaMask's own seed phrase is *not* used
and is never available to a dapp.

## 2. Are notes recoverable from the wallet alone?

**Yes, for wallet-derived accounts.** The frontend derives the mnemonic from an
EIP-712 signature. From `privacy-pools-website/src/utils/walletSeed.ts` and
`seedSignature.ts`:

```
typed data:  domain { name: "Privacy Pools", version: "1" }
             DeriveSeed(string action, string context, bytes32 addressHash)
             action      = "Derive Account Seed"
             context     = "privacy-pools/wallet-seed:<v1|v2>"
             addressHash = keccak256(address_bytes)

r        = signature[0..32]                  // the r component only
salt     = raw lowercase address bytes
info     = utf8("privacy-pools/wallet-seed:<v1|v2>")
entropy  = HKDF(sha256, ikm = r, salt, info, v1 ? 16 : 32 bytes)
mnemonic = BIP39(entropy)                    // v1 = 12 words, v2 = 24 words
```

ECDSA signatures are deterministic (RFC 6979), which is what makes this
reproducible rather than a one-time secret.

**Reproduced locally** against a test key: v2 gives 24 words, v1 gives 12, both
stable across repeated signings, a different wallet gives a different phrase,
and the result is a valid BIP-39 phrase that `generateMasterKeys` accepts.

Guards worth copying, from `seedSignature.ts`:

- The signature must be exactly **65 bytes**. Contract accounts sign in other
  formats and are rejected outright.
- The recovered EIP-712 signer **must equal** the connected address.
- An EIP-7702-delegated EOA signs with its own key and passes.

## 3. Where the mnemonic lives

Nowhere persistent, by design. It is re-derived from a fresh signature each
time for wallet-derived accounts. For the other account type it is generated
randomly (`seedPhrase.ts`, `generateMnemonic(english, 128 | 256)`) and the user
is expected to write it down.

## 4. Can this extension discover existing notes?

Yes, and nothing about discovery is address-bound. `AccountService` scans
deposit indices from 0, derives each precommitment from the master keys, and
looks it up in a map keyed by `event.precommitment`. The depositing address is
never consulted — the same property that lets our own re-shields work.

So: obtain the mnemonic by one of the two routes, hand it to
`AccountService`, and the user's existing notes appear.

## 5. The import procedure the SDK supports

`AccountServiceConfig` accepts exactly two shapes:

```ts
{ mnemonic: string } | { account: PrivacyPoolAccount }
```

There is **no** signature-based entry point in the SDK — that logic lives only
in the website. The `entropyToMnemonic` symbols inside the SDK bundle are
bundled ethers internals, not a Privacy Pools helper.

On the mnemonic path the SDK builds **two** accounts, a current one and a
legacy one, and scans both, so a v1-era account is covered without a separate
import.

## What the user must be asked

The two account types are **not interchangeable**, and guessing wrong silently
finds no notes rather than erroring:

1. **Wallet-derived** — connect the same wallet, sign once. Needs the version
   (v1 12-word or v2 24-word); trying both is cheap and harmless.
2. **Written-down phrase** — paste 12 or 24 words.

## Consequence for this extension

A recovered account's mnemonic **is** the vault seed as far as note derivation
goes. If a user imports an existing Privacy Pools account, the vault must use
that mnemonic for note derivation, or their existing balance stays invisible.

That interacts badly with deriving trade owner keys from the same phrase — see
the key-reuse note in [security.md](security.md).
