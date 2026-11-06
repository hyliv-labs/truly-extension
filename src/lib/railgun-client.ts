/**
 * Service-worker side of a Railgun unshield and shield.
 *
 * The proof is built in the offscreen document (railgun-run.ts). This file
 * must not import @railgun-community/wallet. The unshield is signed by the
 * trade owner and broadcast on the anon-rpc client: that is the one step
 * Circle's paymaster cannot buy, because the USDC is still inside the note.
 * A fresh owner has no ETH, so an earlier address from the same vault tops
 * it up first. The signed bytes are stored before the broadcast, and a retry
 * sends those same bytes.
 *
 * The return shield is a 7702 user operation. The owner approves the proxy
 * and shields in one batch, and Circle's paymaster pulls USDC for gas. The
 * owner does not need ETH for that step.
 *
 * The mnemonic crosses to the offscreen document, the same way a withdrawal
 * secret crosses for a Privacy Pools proof. It is not logged and not written
 * into an error.
 */

import { createBundlerClient, toSimple7702SmartAccount } from 'viem/account-abstraction';
import {
  encodeFunctionData,
  erc20Abi,
  http,
  keccak256,
  type Address,
  type Hash,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  ARBITRUM_CHAIN_ID,
  BUNDLER_URL,
  CIRCLE_PAYMASTER,
  PAYMASTER_POST_OP_GAS_LIMIT,
  PAYMASTER_VERIFICATION_GAS_LIMIT,
  USDC_ADDRESS,
} from './config';
import { ensureOffscreenDocument } from './offscreen';
import { publicClient } from './chain';
import { DEFAULT_PERMIT_AMOUNT, encodePaymasterData, signPaymasterPermit } from './permit';
import { RAILGUN_PROXY_ARBITRUM, railgunGrossForNet, railgunShieldAfterGasReserve } from './railgun';
import { readUserOperationReceipt } from './reshield';
import { discardReshield, getActiveTrade, updateActiveTrade, type ActiveTrade } from './trade';
import { ownerAt, requireUnlockedMnemonic } from './vault';
import type { PopulatedRailgunTx, RailgunBalanceSnapshot } from './railgun-run';

export interface RailgunUsdcBalances {
  readonly spendableUnits: bigint;
  readonly pendingUnits: bigint;
  readonly feeBps: bigint;
}

export interface RailgunUnshieldResult {
  readonly txHash: Hash;
  readonly amountUnits: bigint;
  readonly expectedNetUnits: bigint;
}

const SHIELD_MESSAGE = 'RAILGUN_SHIELD';

export async function railgunUsdcBalances(): Promise<RailgunUsdcBalances> {
  const mnemonic = await requireUnlockedMnemonic();
  const snapshot = await ask<RailgunBalanceSnapshot>({ kind: 'railgunBalances', mnemonic });
  return {
    spendableUnits: BigInt(snapshot.spendableUnits),
    pendingUnits: BigInt(snapshot.pendingUnits),
    feeBps: BigInt(snapshot.feeBps),
  };
}

/**
 * Unshield `netUnits` of USDC, after the on-chain fee, to the Lighter intent
 * address. Refuses to build a second proof while a previous one may have
 * been broadcast.
 */
export async function unshieldRailgunForTrade(netUnits: bigint): Promise<RailgunUnshieldResult> {
  const trade = await getActiveTrade();
  if (!trade) throw new Error('No trade is active.');
  if (!trade.intentAddress) throw new Error('Lighter has not issued a deposit address yet.');
  if (trade.withdrawal?.status === 'confirmed' && trade.withdrawal.txHash) {
    return {
      txHash: trade.withdrawal.txHash as Hash,
      amountUnits: BigInt(trade.withdrawal.amount),
      expectedNetUnits: netUnits,
    };
  }
  if (trade.withdrawal?.status === 'pending') {
    return settlePendingUnshield(trade, netUnits);
  }

  const owner = await ownerAt(trade.ownerIndex);
  await ensureUnshieldGas(trade.ownerIndex, owner.address);
  const mnemonic = await requireUnlockedMnemonic();
  const balances = await railgunUsdcBalances();
  const gross = railgunGrossForNet(netUnits, balances.feeBps);
  const populated = await ask<PopulatedRailgunTx>({
    kind: 'railgunUnshield',
    mnemonic,
    recipient: trade.intentAddress,
    amountUnits: gross.toString(),
    fromAddress: owner.address,
  });
  const signed = await signPopulated(owner.privateKey, populated);
  await updateActiveTrade({
    withdrawal: {
      status: 'pending',
      txHash: signed.hash,
      raw: signed.raw,
      label: 'railgun',
      amount: gross.toString(),
      childrenCountAtStart: 0,
      startedAt: Date.now(),
    },
  });
  await broadcast(signed.raw);
  await publicClient.waitForTransactionReceipt({ hash: signed.hash });
  await updateActiveTrade({
    withdrawal: {
      status: 'confirmed',
      txHash: signed.hash,
      raw: signed.raw,
      label: 'railgun',
      amount: gross.toString(),
      childrenCountAtStart: 0,
      startedAt: trade.startedAt,
      confirmedAt: Date.now(),
    },
  });
  return { txHash: signed.hash, amountUnits: gross, expectedNetUnits: netUnits };
}

/** Confirm or resend the stored Railgun funding transaction. Never builds another proof. */
export async function settleRailgunFunding(): Promise<'landed' | 'pending' | 'reverted' | 'none'> {
  const trade = await getActiveTrade();
  if (trade?.withdrawal?.status !== 'pending' || trade.withdrawal.label !== 'railgun') return 'none';
  const hash = trade.withdrawal.txHash as Hash | undefined;
  if (!hash) return 'pending';
  const receipt = await publicClient.getTransactionReceipt({ hash }).catch(() => null);
  if (receipt?.status === 'success') {
    await updateActiveTrade({
      withdrawal: { ...trade.withdrawal, status: 'confirmed', confirmedAt: Date.now() },
    });
    return 'landed';
  }
  if (receipt?.status === 'reverted') {
    await updateActiveTrade({ withdrawal: undefined });
    return 'reverted';
  }
  if (trade.withdrawal.raw) await broadcast(trade.withdrawal.raw as Hex);
  return 'pending';
}

/**
 * Move the owner's USDC back into the same Railgun wallet the trade was
 * funded from. Gas is paid in USDC through Circle's paymaster, so this does
 * not ask the owner for ETH. A stored user-operation hash is waited on, not
 * rebuilt. An older ETH-paid shield (one that stored raw bytes) is resent
 * as those bytes.
 */
export async function shieldOwnerUsdcToRailgun(): Promise<{ txHash: Hash; amountUnits: bigint }> {
  const trade = await getActiveTrade();
  if (!trade) throw new Error('No active trade to shield.');
  if (trade.reshield?.status === 'confirmed' && trade.reshield.userOpHash) {
    return { txHash: trade.reshield.userOpHash as Hash, amountUnits: BigInt(trade.reshield.deposited) };
  }
  if (trade.reshield?.status === 'pending' && trade.reshield.userOpHash) {
    return settlePendingShield(trade);
  }

  const owner = await ownerAt(trade.ownerIndex);
  const balance = await usdcBalance(owner.address);
  const amount = railgunShieldAfterGasReserve(balance, DEFAULT_PERMIT_AMOUNT);

  const mnemonic = await requireUnlockedMnemonic();
  const signature = await privateKeyToAccount(owner.privateKey).signMessage({ message: SHIELD_MESSAGE });
  const shieldPrivateKey = keccak256(signature);
  const call = await ask<{ to: string; data: string }>({
    kind: 'railgunShieldCall',
    mnemonic,
    shieldPrivateKey,
    amountUnits: amount.toString(),
  });
  if (call.to.toLowerCase() !== RAILGUN_PROXY_ARBITRUM.toLowerCase()) {
    throw new Error('Railgun returned a shield aimed at the wrong contract.');
  }

  const userOpHash = await sendShieldOperation({
    privateKey: owner.privateKey,
    shieldTo: call.to as Address,
    shieldData: call.data as Hex,
    amount,
    onSubmitted: async (hash) => {
      await updateActiveTrade({
        reshield: {
          status: 'pending',
          userOpHash: hash,
          depositIndex: 0,
          deposited: amount.toString(),
          confirmedAt: 0,
        },
      });
    },
  });

  await updateActiveTrade({
    reshield: {
      status: 'confirmed',
      userOpHash,
      depositIndex: 0,
      deposited: amount.toString(),
      confirmedAt: Date.now(),
    },
  });
  return { txHash: userOpHash, amountUnits: amount };
}

async function settlePendingUnshield(trade: ActiveTrade, netUnits: bigint): Promise<RailgunUnshieldResult> {
  const outcome = await settleRailgunFunding();
  if (outcome === 'landed' && trade.withdrawal?.txHash) {
    return {
      txHash: trade.withdrawal.txHash as Hash,
      amountUnits: BigInt(trade.withdrawal.amount),
      expectedNetUnits: netUnits,
    };
  }
  if (outcome === 'reverted') {
    throw new Error('The Railgun unshield reverted. Retry funding to build a new proof.');
  }
  throw new Error('The Railgun unshield is already broadcast. Waiting for it to confirm.');
}

async function settlePendingShield(trade: ActiveTrade): Promise<{ txHash: Hash; amountUnits: bigint }> {
  const hash = trade.reshield!.userOpHash as Hash;
  if (!trade.reshield?.raw) {
    const outcome = await readUserOperationReceipt(hash);
    if (outcome === 'pending') {
      throw new Error('The Railgun shield is already submitted. Waiting for it to confirm.');
    }
    if (outcome === 'reverted') {
      await discardReshield();
      throw new Error('The Railgun shield reverted. It was not sent again.');
    }
    await updateActiveTrade({
      reshield: { ...trade.reshield!, status: 'confirmed', confirmedAt: Date.now() },
    });
    return { txHash: hash, amountUnits: BigInt(trade.reshield!.deposited) };
  }
  const receipt = await publicClient.getTransactionReceipt({ hash }).catch(() => null);
  if (receipt?.status === 'success') {
    await updateActiveTrade({
      reshield: { ...trade.reshield!, status: 'confirmed', confirmedAt: Date.now() },
    });
    return { txHash: hash, amountUnits: BigInt(trade.reshield!.deposited) };
  }
  if (receipt?.status === 'reverted') {
    await updateActiveTrade({ reshield: undefined });
    throw new Error('The Railgun shield reverted. It was not sent again.');
  }
  if (trade.reshield?.raw) await broadcast(trade.reshield.raw as Hex);
  throw new Error('The Railgun shield is already broadcast. Waiting for it to confirm.');
}

/**
 * One user operation: permit Circle to take gas in USDC, approve the Railgun
 * proxy, and shield. The paymaster collects during validation, so `amount`
 * must already be balance minus the permit ceiling.
 */
async function sendShieldOperation(input: {
  privateKey: Hex;
  shieldTo: Address;
  shieldData: Hex;
  amount: bigint;
  onSubmitted: (userOpHash: Hash) => Promise<void>;
}): Promise<Hash> {
  const owner = privateKeyToAccount(input.privateKey);
  const account = await toSimple7702SmartAccount({
    client: publicClient,
    owner,
  });
  const bundlerClient = createBundlerClient({
    account,
    client: publicClient,
    transport: http(BUNDLER_URL),
    userOperation: {
      async estimateFeesPerGas({ bundlerClient: client }) {
        const { standard } = await client.request<{
          Method: 'pimlico_getUserOperationGasPrice';
          Parameters: [];
          ReturnType: {
            standard: { maxFeePerGas: Hex; maxPriorityFeePerGas: Hex };
          };
        }>({ method: 'pimlico_getUserOperationGasPrice', params: [] });
        return {
          maxFeePerGas: BigInt(standard.maxFeePerGas),
          maxPriorityFeePerGas: BigInt(standard.maxPriorityFeePerGas),
        };
      },
    },
  });
  const permitSignature = await signPaymasterPermit({
    privateKey: input.privateKey,
    permitAmount: DEFAULT_PERMIT_AMOUNT,
  });
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
          args: [RAILGUN_PROXY_ARBITRUM as Address, input.amount],
        }),
      },
      { to: input.shieldTo, data: input.shieldData },
    ],
    paymaster: CIRCLE_PAYMASTER,
    paymasterData: encodePaymasterData({
      permitAmount: DEFAULT_PERMIT_AMOUNT,
      permitSignature,
    }),
    paymasterVerificationGasLimit: PAYMASTER_VERIFICATION_GAS_LIMIT,
    paymasterPostOpGasLimit: PAYMASTER_POST_OP_GAS_LIMIT,
  });
  await input.onSubmitted(userOpHash);
  const receipt = await bundlerClient.waitForUserOperationReceipt({ hash: userOpHash });
  if (!receipt.success) {
    await discardReshield();
    throw new Error('The Railgun shield reverted. It was not sent again.');
  }
  return userOpHash;
}

async function usdcBalance(owner: Address): Promise<bigint> {
  return publicClient.readContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [owner],
  });
}

/** Enough for a ~1.2M-gas unshield at twice the current 0.02 gwei base fee. */
const UNSHIELD_GAS_WEI = 50_000_000_000_000n;
const ETH_TRANSFER_GAS = 21_000n;

/**
 * The unshield is a normal transaction, so the fresh owner has to hold ETH.
 * An earlier owner from this same vault can pay that, which does link the two
 * addresses. A vault with no ETH anywhere is refused before a proof is built.
 */
async function ensureUnshieldGas(ownerIndex: number, owner: Address): Promise<void> {
  const balance = await publicClient.getBalance({ address: owner });
  if (balance >= UNSHIELD_GAS_WEI) return;

  for (let index = 0; index < ownerIndex; index += 1) {
    const earlier = await ownerAt(index);
    const earlierBalance = await publicClient.getBalance({ address: earlier.address });
    const price = (await publicClient.getGasPrice()) * 2n;
    const transferCost = ETH_TRANSFER_GAS * price;
    if (earlierBalance < UNSHIELD_GAS_WEI + transferCost) continue;

    const account = privateKeyToAccount(earlier.privateKey);
    const nonce = await publicClient.getTransactionCount({ address: earlier.address });
    const raw = await account.signTransaction({
      chainId: ARBITRUM_CHAIN_ID,
      nonce,
      to: owner,
      value: UNSHIELD_GAS_WEI,
      gas: ETH_TRANSFER_GAS,
      maxFeePerGas: price,
      maxPriorityFeePerGas: 0n,
      type: 'eip1559',
    });
    const hash = keccak256(raw);
    await publicClient.sendRawTransaction({ serializedTransaction: raw }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!/already known|nonce too low|replacement transaction underpriced/i.test(message)) throw error;
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') {
      throw new Error('The gas top-up reverted. The unshield was not built.');
    }
    return;
  }

  throw new Error(
    `This owner has no ETH for the Railgun unshield. Send 0.0001 ETH on Arbitrum to ${owner}. Nothing left the pool.`,
  );
}

async function signPopulated(
  privateKey: Hex,
  tx: PopulatedRailgunTx,
): Promise<{ hash: Hash; raw: Hex }> {
  const account = privateKeyToAccount(privateKey);
  const nonce = await publicClient.getTransactionCount({ address: account.address });
  const gas = BigInt(tx.gasLimit);
  if (gas === 0n) throw new Error('Railgun returned a transaction with no gas limit.');
  const raw = await account.signTransaction({
    chainId: ARBITRUM_CHAIN_ID,
    nonce,
    to: tx.to as Address,
    data: tx.data as Hex,
    value: BigInt(tx.value),
    gas,
    maxFeePerGas: BigInt(tx.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas),
    type: 'eip1559',
  });
  return { hash: keccak256(raw), raw };
}

async function broadcast(raw: Hex): Promise<void> {
  await publicClient.sendRawTransaction({ serializedTransaction: raw }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (/already known|nonce too low|replacement transaction underpriced/i.test(message)) return;
    throw error;
  });
}

async function ask<T>(message: Record<string, unknown>): Promise<T> {
  let last = 'Offscreen document did not answer.';
  for (let attempt = 0; attempt < 2; attempt++) {
    await ensureOffscreenDocument();
    const ready = await waitForOffscreen(8_000);
    if (!ready) {
      await chrome.offscreen.closeDocument().catch(() => undefined);
      continue;
    }
    try {
      const response = (await chrome.runtime.sendMessage({
        target: 'truly:offscreen',
        ...message,
      })) as { ok?: boolean; value?: T; error?: string } | undefined;
      if (!response?.ok || response.value === undefined) {
        throw new Error(response?.error ?? 'The Railgun engine returned nothing.');
      }
      return response.value;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
      if (!/Receiving end does not exist|Could not establish connection/i.test(last)) {
        throw error instanceof Error ? error : new Error(last);
      }
      await chrome.offscreen.closeDocument().catch(() => undefined);
    }
  }
  throw new Error(`The Railgun engine could not be reached: ${last}`);
}

/** The document exists before its script has registered a listener. */
async function waitForOffscreen(ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const response = (await chrome.runtime.sendMessage({
        target: 'truly:offscreen',
        kind: 'ping',
      })) as { ok?: boolean } | undefined;
      if (response?.ok) return true;
    } catch {
      // Still parsing. A send during that window has no receiver.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}
