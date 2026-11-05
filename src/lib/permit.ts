/**
 * EIP-2612 permit for Circle's Paymaster, and the paymasterData it goes into.
 *
 * The byte layout comes from Circle's own sample, not from inference — a wrong
 * layout here does not throw, it just fails on mainnet with the user's money
 * already at the owner address.
 */

import {
  encodePacked,
  erc20Abi,
  maxUint256,
  parseErc6492Signature,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { publicClient } from './chain';
import { ARBITRUM_CHAIN_ID, CIRCLE_PAYMASTER, USDC_ADDRESS } from './config';

/** name() and version() are not on viem's erc20Abi. */
const permitAbi = [
  {
    type: 'function',
    name: 'version',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'string' }],
  },
  {
    type: 'function',
    name: 'nonces',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const;

const permitTypes = {
  // Circle's sample includes EIP712Domain explicitly, for compatibility with
  // their Sign Typed Data API.
  EIP712Domain: [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' },
    { name: 'verifyingContract', type: 'address' },
  ],
  Permit: [
    { name: 'owner', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;

/**
 * Sign a permit letting the paymaster pull `permitAmount` USDC for gas.
 *
 * The domain name and version are read on chain rather than hardcoded. They
 * are currently "USD Coin" and "2" on Arbitrum, but a wrong domain produces a
 * signature that simply does not recover — no error, just a rejected
 * operation.
 */
export async function signPaymasterPermit(input: {
  privateKey: Hex;
  permitAmount: bigint;
}): Promise<Hex> {
  const owner = privateKeyToAccount(input.privateKey);

  const [name, version, nonce] = await Promise.all([
    publicClient.readContract({
      address: USDC_ADDRESS,
      abi: erc20Abi,
      functionName: 'name',
    }),
    publicClient.readContract({
      address: USDC_ADDRESS,
      abi: permitAbi,
      functionName: 'version',
    }),
    publicClient.readContract({
      address: USDC_ADDRESS,
      abi: permitAbi,
      functionName: 'nonces',
      args: [owner.address],
    }),
  ]);

  const signature = await owner.signTypedData({
    domain: {
      name,
      version,
      // uint256 in the domain type, so it must be a bigint here.
      chainId: BigInt(ARBITRUM_CHAIN_ID),
      verifyingContract: USDC_ADDRESS,
    },
    types: permitTypes,
    primaryType: 'Permit',
    message: {
      owner: owner.address,
      spender: CIRCLE_PAYMASTER,
      value: input.permitAmount,
      nonce,
      // MUST be maxUint256: the paymaster cannot read block.timestamp under
      // 4337's opcode restrictions, so any real deadline is unverifiable.
      deadline: maxUint256,
    },
  });

  // Unwrap any ERC-6492 wrapper; the paymaster expects the inner signature.
  return parseErc6492Signature(signature).signature;
}

/**
 * paymasterData, exactly as Circle's sample packs it:
 *   uint8(0) | token address | uint256 permitAmount | permit signature
 *
 * encodePacked adds no length prefix, so the signature's length is implied by
 * the total. The leading 0 is a mode byte whose meaning Circle does not
 * document.
 */
export function encodePaymasterData(input: {
  permitAmount: bigint;
  permitSignature: Hex;
}): Hex {
  return encodePacked(
    ['uint8', 'address', 'uint256', 'bytes'],
    [0, USDC_ADDRESS, input.permitAmount, input.permitSignature],
  );
}

/**
 * USDC the paymaster is ALLOWED to pull for gas — a ceiling, not a charge. It
 * takes only the actual gas plus Circle's 10% surcharge, which on Arbitrum is
 * cents.
 *
 * Circle's sample permits 10 USDC, which is wrong here for two reasons: a $25
 * trade that took a loss can leave less than 10 USDC on Lighter, so re-shield
 * would refuse outright; and whatever is reserved stays behind at a retired,
 * single-use owner address on every trade.
 *
 * 1 USDC is generous for Arbitrum gas while keeping the stranded dust small.
 */
export const DEFAULT_PERMIT_AMOUNT = 1_000_000n;
