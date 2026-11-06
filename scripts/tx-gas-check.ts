/**
 * The gas a signed transaction needs is read from its own bytes.
 *
 * Measured failure this guards: the Railgun unshield was given a fixed
 * 0.00005 ETH, the node wanted 0.0000570 ETH (gas limit x fee cap), refused
 * the broadcast, and the funding retried the same refused bytes forever.
 * Offline: signs with a throwaway key, sends nothing. Part of `pnpm check`.
 */
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { maxCostWei } from '../src/lib/tx-gas.ts';

let failed = false;
const fail = (m: string) => {
  console.error('FAIL', m);
  failed = true;
};
const pass = (m: string) => console.log('pass', m);

const account = privateKeyToAccount(generatePrivateKey());

{
  const gas = 1_200_000n;
  // 0.0475 gwei: with 1.2M gas this is the 0.0000570 ETH the node asked for.
  const maxFeePerGas = 47_534_736n;
  const raw = await account.signTransaction({
    chainId: 42161,
    nonce: 0,
    to: '0xFA7093CDD9EE6932B4eb2c9e1cde7CE00B1FA4b9',
    data: '0x1234',
    value: 0n,
    gas,
    maxFeePerGas,
    maxPriorityFeePerGas: 0n,
    type: 'eip1559',
  });
  const want = gas * maxFeePerGas;
  const got = maxCostWei(raw);
  if (got !== want) fail(`unshield cost read as ${got}, expected ${want}`);
  else if (got <= 50_000_000_000_000n) fail('the measured case should exceed the old fixed 0.00005 ETH');
  else pass(`a ~1.2M-gas unshield needs ${got} wei, more than the old fixed 0.00005 ETH`);
}

{
  const raw = await account.signTransaction({
    chainId: 42161,
    nonce: 1,
    to: '0x000000000000000000000000000000000000dEaD',
    value: 7n,
    gas: 21_000n,
    maxFeePerGas: 10n,
    maxPriorityFeePerGas: 0n,
    type: 'eip1559',
  });
  if (maxCostWei(raw) !== 21_000n * 10n + 7n) fail('value is not counted in the cost');
  else pass('the cost includes the value carried');
}

console.log(failed ? '\nFAILED' : '\ntx gas OK');
process.exit(failed ? 1 : 0);
