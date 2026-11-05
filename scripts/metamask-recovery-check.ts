/**
 * The MetaMask recovery flow, exercised against fake providers.
 *
 * Every failure here is one the user must SEE: the rule is that recovery never
 * silently falls back to another wallet or creates an unrelated empty vault,
 * because both look like success while losing access to the real account.
 */

import { privateKeyToAccount } from 'viem/accounts';
import { recoverTypedDataAddress, type Hex } from 'viem';
import {
  requestSeedSignature,
  MetaMaskError,
  type MinimalProvider,
} from '../src/lib/metamask.ts';
import {
  buildSeedDerivationTypedData,
  deriveMnemonicFromWalletSignature,
} from '../src/lib/wallet-seed.ts';

let failed = false;
const fail = (msg: string) => {
  console.error('FAIL', msg);
  failed = true;
};
const pass = (msg: string) => console.log('pass', msg);

const account = privateKeyToAccount(`0x${'cd'.repeat(32)}` as Hex);

/** Stands in for MetaMask, recording exactly what was asked of it. */
function fakeMetaMask(options: {
  accounts?: string[];
  rejectConnect?: boolean;
  rejectSign?: boolean;
  signWith?: ReturnType<typeof privateKeyToAccount>;
  unreachable?: boolean;
}): MinimalProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async request<T>({ method, params }: { method: string; params?: unknown[] }) {
      calls.push(method);
      if (options.unreachable) throw new Error('Could not establish connection.');

      if (method === 'eth_requestAccounts') {
        if (options.rejectConnect) throw Object.assign(new Error('User rejected'), { code: 4001 });
        return (options.accounts ?? [account.address]) as T;
      }

      if (method === 'eth_signTypedData_v4') {
        if (options.rejectSign) throw Object.assign(new Error('User rejected'), { code: 4001 });
        const [, json] = params as [string, string];
        const signer = options.signWith ?? account;
        return (await signer.signTypedData(JSON.parse(json))) as T;
      }

      throw new Error(`unexpected method ${method}`);
    },
  };
}

// --- happy path -------------------------------------------------------------

{
  const provider = fakeMetaMask({});
  const { address, signature } = await requestSeedSignature('v2', provider);

  if (address.toLowerCase() !== account.address.toLowerCase()) {
    fail(`returned ${address}, expected ${account.address}`);
  } else {
    pass('returns the connected account');
  }

  if (provider.calls[0] !== 'eth_requestAccounts') {
    fail(`connected with ${provider.calls[0]} instead of eth_requestAccounts`);
  } else if (provider.calls[1] !== 'eth_signTypedData_v4') {
    fail(`signed with ${provider.calls[1]} instead of eth_signTypedData_v4`);
  } else {
    pass('connects, then signs with eth_signTypedData_v4');
  }

  // 65 bytes, or the derivation would reject it downstream.
  if ((signature.length - 2) / 2 !== 65) {
    fail(`signature is ${(signature.length - 2) / 2} bytes, expected 65`);
  } else {
    pass('signature is 65 bytes');
  }

  const recovered = await recoverTypedDataAddress({
    ...buildSeedDerivationTypedData(address, 'v2'),
    signature,
  });
  if (recovered.toLowerCase() !== address.toLowerCase()) {
    fail('signature does not recover to the reported account');
  } else {
    pass('signature recovers to the account MetaMask reported');
  }

  // End to end: this is the mnemonic that must unlock the real account.
  const mnemonic = await deriveMnemonicFromWalletSignature(signature, address, 'v2');
  if (mnemonic.split(' ').length !== 24) {
    fail(`derived ${mnemonic.split(' ').length} words, expected 24`);
  } else {
    pass('derives a 24-word mnemonic from the MetaMask signature');
  }

  // Determinism across a fresh connection is what makes this recovery at all.
  const second = await requestSeedSignature('v2', fakeMetaMask({}));
  const again = await deriveMnemonicFromWalletSignature(second.signature, second.address, 'v2');
  if (again !== mnemonic) {
    fail('a second MetaMask session derived a different mnemonic');
  } else {
    pass('a second session derives the same mnemonic');
  }
}

// --- failures the user must see --------------------------------------------

async function expectReason(
  label: string,
  reason: string,
  run: () => Promise<unknown>,
): Promise<void> {
  try {
    await run();
    fail(`${label}: succeeded when it should have failed`);
  } catch (error) {
    if (!(error instanceof MetaMaskError)) {
      fail(`${label}: threw ${String(error)} rather than MetaMaskError`);
    } else if (error.reason !== reason) {
      fail(`${label}: reason was '${error.reason}', expected '${reason}'`);
    } else {
      pass(`${label} -> ${reason}`);
    }
  }
}

await expectReason('MetaMask not installed', 'not-installed', () =>
  requestSeedSignature('v2', fakeMetaMask({ unreachable: true })),
);

await expectReason('connection rejected', 'connection-rejected', () =>
  requestSeedSignature('v2', fakeMetaMask({ rejectConnect: true })),
);

await expectReason('signature rejected', 'signature-rejected', () =>
  requestSeedSignature('v2', fakeMetaMask({ rejectSign: true })),
);

await expectReason('no accounts returned', 'no-account', () =>
  requestSeedSignature('v2', fakeMetaMask({ accounts: [] })),
);

// --- the dangerous one ------------------------------------------------------

// A provider that reports one account but signs with another would derive a
// DIFFERENT, empty account. That must be caught, not accepted: the user would
// otherwise be told they have no funds.
{
  const imposter = privateKeyToAccount(`0x${'ef'.repeat(32)}` as Hex);
  const { address, signature } = await requestSeedSignature(
    'v2',
    fakeMetaMask({ signWith: imposter }),
  );

  const recovered = await recoverTypedDataAddress({
    ...buildSeedDerivationTypedData(address, 'v2'),
    signature,
  });

  if (recovered.toLowerCase() === address.toLowerCase()) {
    fail('mismatched signer was not detectable');
  } else {
    pass('a signature from a different key is detectable by recovery');
  }

  try {
    await deriveMnemonicFromWalletSignature(signature, address, 'v2');
    fail('derivation ACCEPTED a signature from the wrong signer');
  } catch {
    pass('derivation refuses a signature from the wrong signer');
  }
}

// v1 must still work, and be a different account from v2.
{
  const v1 = await requestSeedSignature('v1', fakeMetaMask({}));
  const v1Mnemonic = await deriveMnemonicFromWalletSignature(v1.signature, v1.address, 'v1');
  if (v1Mnemonic.split(' ').length !== 12) {
    fail(`v1 derived ${v1Mnemonic.split(' ').length} words, expected 12`);
  } else {
    pass('v1 recovery derives a 12-word mnemonic');
  }
}

process.exitCode = failed ? 1 : 0;
