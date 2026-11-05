/**
 * E7: return what is left of a trade to Privacy Pools, with gas paid in USDC.
 *
 * The owner address holds only USDC — never ETH. Sending it ETH to cover gas
 * would link it to whoever sent that ETH, which is the exact linkage this
 * extension exists to avoid. So the owner is delegated to a Simple7702Account
 * for one operation and Circle's Paymaster is permitted to pull USDC for gas.
 *
 * One user operation does all of it: the paymaster's permit rides in
 * paymasterData, then approve + deposit run as batched calls.
 */

import { createBundlerClient, toSimple7702SmartAccount } from 'viem/account-abstraction';
import { encodeFunctionData, erc20Abi, http, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { publicClient } from './chain';
import {
  BUNDLER_URL,
  CIRCLE_PAYMASTER,
  PAYMASTER_POST_OP_GAS_LIMIT,
  PAYMASTER_VERIFICATION_GAS_LIMIT,
  PRIVACY_POOL_ENTRYPOINT,
  USDC_ADDRESS,
  ARBITRUM_CHAIN_ID,
} from './config';
import {
  DEFAULT_PERMIT_AMOUNT,
  encodePaymasterData,
  signPaymasterPermit,
} from './permit';

export class ReshieldUnavailable extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'ReshieldUnavailable';
  }
}

/** Privacy Pools entrypoint deposit. */
const poolEntrypointAbi = [
  {
    type: 'function',
    name: 'deposit',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'asset', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'precommitment', type: 'uint256' },
    ],
    outputs: [{ type: 'uint256' }],
  },
] as const;

export interface ReshieldResult {
  readonly userOpHash: Hex;
  readonly deposited: bigint;
}

/**
 * Re-shield the owner's entire USDC balance, less what the paymaster may take
 * for gas.
 *
 * `precommitment` comes from the caller because it is derived from the vault
 * seed — this module never touches key derivation beyond the owner key it is
 * handed.
 */
export async function reshield(input: {
  privateKey: Hex;
  precommitment: bigint;
  /** Overridable so a tight balance can lower the gas allowance. */
  permitAmount?: bigint;
}): Promise<ReshieldResult> {
  if (!PRIVACY_POOL_ENTRYPOINT) {
    throw new ReshieldUnavailable(
      'No Privacy Pools entrypoint configured, so there is nowhere to re-shield to.',
    );
  }

  const owner = privateKeyToAccount(input.privateKey);
  const permitAmount = input.permitAmount ?? DEFAULT_PERMIT_AMOUNT;

  const balance = await publicClient.readContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [owner.address],
  });

  // The paymaster may pull up to permitAmount for gas, so depositing the full
  // balance would leave the operation unpayable. Reserve it rather than
  // discovering the shortfall mid-operation.
  if (balance <= permitAmount) {
    throw new ReshieldUnavailable(
      `Owner holds ${balance} USDC units, which does not cover the ${permitAmount} gas allowance.`,
    );
  }
  const depositAmount = balance - permitAmount;

  const account = await toSimple7702SmartAccount({
    client: publicClient,
    owner,
  });

  const bundlerClient = createBundlerClient({
    account,
    client: publicClient,
    transport: http(BUNDLER_URL),
  });

  const permitSignature = await signPaymasterPermit({
    privateKey: input.privateKey,
    permitAmount,
  });

  // The owner is a plain EOA with no code, so every re-shield needs its own
  // authorization. The delegate address comes from viem rather than being
  // hardcoded, so it cannot drift from the account implementation above.
  const authorization = await owner.signAuthorization({
    chainId: ARBITRUM_CHAIN_ID,
    nonce: await publicClient.getTransactionCount({ address: owner.address }),
    address: account.authorization.address,
  });

  const userOpHash = await bundlerClient.sendUserOperation({
    account,
    authorization,
    calls: [
      {
        to: USDC_ADDRESS,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: 'approve',
          args: [PRIVACY_POOL_ENTRYPOINT, depositAmount],
        }),
      },
      {
        to: PRIVACY_POOL_ENTRYPOINT,
        data: encodeFunctionData({
          abi: poolEntrypointAbi,
          functionName: 'deposit',
          args: [USDC_ADDRESS, depositAmount, input.precommitment],
        }),
      },
    ],
    paymaster: CIRCLE_PAYMASTER,
    paymasterData: encodePaymasterData({ permitAmount, permitSignature }),
    paymasterVerificationGasLimit: PAYMASTER_VERIFICATION_GAS_LIMIT,
    paymasterPostOpGasLimit: PAYMASTER_POST_OP_GAS_LIMIT,
  });

  return { userOpHash, deposited: depositAmount };
}

/** Owner addresses are single-use, so a leftover balance means a stuck trade. */
export async function ownerUsdcBalance(address: Address): Promise<bigint> {
  return publicClient.readContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [address],
  });
}
