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
  formatEther,
  http,
  keccak256,
  parseTransaction,
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
import { arbitrumGasLimit, maxCostWei } from './tx-gas';
import { publicClient } from './chain';
import { DEFAULT_PERMIT_AMOUNT, encodePaymasterData, signPaymasterPermit } from './permit';
import { RAILGUN_PROXY_ARBITRUM, railgunGrossForNet, railgunShieldAfterGasReserve } from './railgun';
import { readUserOperationReceipt } from './reshield';
import { discardReshield, getActiveTrade, updateActiveTrade, type ActiveTrade } from './trade';
import { ownerAt, requireUnlockedMnemonic } from './vault';
import type { PopulatedRailgunTx, RailgunBalanceSnapshot } from './railgun-run';
import type { RailgunSyncStatus } from './railgun-sync-status';

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
export async function unshieldRailgunForTrade(netUnits: bigint, exactGrossUnits?: bigint): Promise<RailgunUnshieldResult> {
  const trade = await getActiveTrade();
  if (!trade) throw new Error('No trade is active.');
  if (!trade.intentAddress) {
    throw new Error(
      trade.venue === 'intents'
        ? 'NEAR Intents has not issued a deposit address yet.'
        : trade.venue === 'uniswap'
        ? 'The Uniswap address is not ready to receive funds yet.'
        : trade.venue === 'compound'
          ? 'The Compound address is not ready to receive funds yet.'
          : 'Lighter has not issued a deposit address yet.',
    );
  }
  // A 'confirmed' record from before the receipt-status check may be a
  // revert. Verified first; a reverted one is cleared and a new unshield built.
  if (trade.withdrawal?.status === 'confirmed' && trade.withdrawal.txHash && (await verifyRailgunFunding()) !== 'reverted') {
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
  // A 1Click deposit must arrive as exactly the quoted amount, so the exit
  // passes the gross it quoted the net of. Rounding net -> gross up can land
  // one unit high, and 1Click refunds the excess with a fee.
  const gross = exactGrossUnits ?? railgunGrossForNet(netUnits, balances.feeBps);
  if (exactGrossUnits !== undefined && gross - (gross * balances.feeBps) / 10_000n !== netUnits) {
    throw new Error('The Railgun fee changed since the quote, so the deposit would not match it. Nothing left the pool. Retry for a new quote.');
  }
  // Only the bundled 1x2/2x2/3x2 circuits exist, and spending every note
  // leaves no change output (an N x 1 proof). Keep at least one unit back.
  if (exactGrossUnits !== undefined && balances.spendableUnits <= gross) {
    throw new Error('The spendable Railgun balance does not cover this amount plus the change note it must leave. Nothing left the pool.');
  }
  const populated = await ask<PopulatedRailgunTx>({
    kind: 'railgunUnshield',
    mnemonic,
    recipient: trade.intentAddress,
    amountUnits: gross.toString(),
    fromAddress: owner.address,
  });
  const signed = await signPopulated(owner.privateKey, populated);
  // The exact cost is known only now. Cover it BEFORE recording 'pending': a
  // node refuses an unaffordable broadcast, and a pending record of refused
  // bytes is retried every tick and never lands.
  await ensureUnshieldGas(trade.ownerIndex, owner.address, maxCostWei(signed.raw));
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
  // waitForTransactionReceipt resolves for a REVERTED transaction too.
  // Measured: two reverted unshields ("Invalid Snark Proof") were recorded as
  // confirmed and the panel went on to wait for a deposit that never left.
  const receipt = await publicClient.waitForTransactionReceipt({ hash: signed.hash });
  if (receipt.status !== 'success') {
    await updateActiveTrade({ withdrawal: undefined });
    throw new Error(`The Railgun unshield reverted on chain (tx ${signed.hash}). Nothing left the pool. Retry builds a new proof.`);
  }
  await updateActiveTrade({
    withdrawal: {
      receiptOk: true,
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
/**
 * Re-read the receipt of a Railgun funding marked confirmed WITHOUT a checked
 * status (written by the code that did not look at it). 'reverted' clears
 * the record: nothing left the pool, and the funding can be retried.
 */
export async function verifyRailgunFunding(): Promise<'ok' | 'reverted' | 'unknown' | 'none'> {
  const trade = await getActiveTrade();
  const withdrawal = trade?.withdrawal;
  if (withdrawal?.status !== 'confirmed' || withdrawal.label !== 'railgun' || withdrawal.receiptOk) return 'none';
  if (!withdrawal.txHash) return 'unknown';
  const receipt = await publicClient.getTransactionReceipt({ hash: withdrawal.txHash as Hash }).catch(() => null);
  if (!receipt) return 'unknown';
  if (receipt.status === 'success') {
    await updateActiveTrade({ withdrawal: { ...withdrawal, receiptOk: true } });
    return 'ok';
  }
  await updateActiveTrade({ withdrawal: undefined });
  return 'reverted';
}

export async function settleRailgunFunding(): Promise<'landed' | 'pending' | 'reverted' | 'none'> {
  const trade = await getActiveTrade();
  if (trade?.withdrawal?.status !== 'pending' || trade.withdrawal.label !== 'railgun') return 'none';
  const hash = trade.withdrawal.txHash as Hash | undefined;
  if (!hash) return 'pending';
  const receipt = await publicClient.getTransactionReceipt({ hash }).catch(() => null);
  if (receipt?.status === 'success') {
    await updateActiveTrade({
      withdrawal: { ...trade.withdrawal, status: 'confirmed', confirmedAt: Date.now(), receiptOk: true },
    });
    return 'landed';
  }
  if (receipt?.status === 'reverted') {
    await updateActiveTrade({ withdrawal: undefined });
    return 'reverted';
  }
  if (trade.withdrawal.raw) {
    // A record written before the exact-cost check can hold bytes the owner
    // cannot afford (measured: 0.00005 ETH held, 0.0000570 wanted), and a
    // resend then fails every tick. Cover the shortfall first; with no ETH
    // anywhere in the vault this throws, naming the amount to send.
    // A limit Arbitrum already rejected is signed again. Resending those
    // bytes fails the same way on every retry.
    const owner = await ownerAt(trade.ownerIndex);
    const raw = await raiseGasIfNeeded(owner.privateKey, trade.withdrawal.raw as Hex);
    if (raw !== trade.withdrawal.raw) {
      await updateActiveTrade({
        withdrawal: { ...trade.withdrawal, raw, txHash: keccak256(raw) },
      });
    }
    await ensureUnshieldGas(trade.ownerIndex, trade.ownerAddress as Address, maxCostWei(raw));
    await broadcast(raw);
  }
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
  const mnemonic = await requireUnlockedMnemonic();
  const signature = await privateKeyToAccount(owner.privateKey).signMessage({ message: SHIELD_MESSAGE });
  const shieldPrivateKey = keccak256(signature);

  // ETH first: shield the WHOLE balance and pay the few cents of gas in ETH.
  // The owner usually still holds ETH, because the Railgun unshield needed it.
  // The paymaster route below keeps a 1 USDC permit ceiling behind (measured:
  // ~0.95 USDC left at the owner for a few cents of gas), so it is only the
  // fallback for an owner with no ETH.
  const viaEth = await shieldPayingEth(owner.privateKey, owner.address, balance, mnemonic, shieldPrivateKey);
  if (viaEth) return viaEth;

  const amount = railgunShieldAfterGasReserve(balance, DEFAULT_PERMIT_AMOUNT);
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

/** Rough upper bound for a Railgun shield, used only to decide ETH vs paymaster. */
const SHIELD_GAS_GUESS = 700_000n;

/**
 * Shield the full USDC balance with gas paid in ETH from the owner. Returns
 * null, having sent nothing, when the owner cannot cover the gas; the caller
 * then uses the paymaster. Records the raw transaction before broadcasting,
 * so settlePendingShield resends the same bytes instead of building a second.
 */
async function shieldPayingEth(
  privateKey: Hex,
  owner: Address,
  balance: bigint,
  mnemonic: string,
  shieldPrivateKey: Hex,
  token: Address = USDC_ADDRESS,
): Promise<{ txHash: Hash; amountUnits: bigint } | null> {
  const account = privateKeyToAccount(privateKey);
  const block = await publicClient.getBlock();
  const maxFeePerGas = (block.baseFeePerGas ?? 20_000_000n) * 2n;
  const eth = await publicClient.getBalance({ address: owner });

  const allowance = await publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [owner, RAILGUN_PROXY_ARBITRUM as Address],
  });
  const approveData = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [RAILGUN_PROXY_ARBITRUM as Address, balance] });
  const approveGas = allowance >= balance ? 0n : ((await publicClient.estimateGas({ account: owner, to: token, data: approveData })) * 12n) / 10n;
  if (eth < (approveGas + SHIELD_GAS_GUESS) * maxFeePerGas) return null;

  if (approveGas > 0n) {
    const raw = await account.signTransaction({
      chainId: ARBITRUM_CHAIN_ID,
      nonce: await publicClient.getTransactionCount({ address: owner }),
      to: token,
      data: approveData,
      value: 0n,
      gas: approveGas,
      maxFeePerGas,
      maxPriorityFeePerGas: 0n,
      type: 'eip1559',
    });
    await broadcast(raw);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: keccak256(raw) });
    if (receipt.status !== 'success') throw new Error('The token approval for the shield reverted. Nothing was shielded.');
  }

  const populated = await ask<PopulatedRailgunTx>({
    kind: 'railgunShield',
    mnemonic,
    shieldPrivateKey,
    amountUnits: balance.toString(),
    fromAddress: owner,
    tokenAddress: token,
  });
  if (populated.to.toLowerCase() !== RAILGUN_PROXY_ARBITRUM.toLowerCase()) {
    throw new Error('Railgun returned a shield aimed at the wrong contract.');
  }
  const signed = await signPopulated(privateKey, populated);
  if ((await publicClient.getBalance({ address: owner })) < maxCostWei(signed.raw)) return null;

  await updateActiveTrade({
    reshield: { status: 'pending', userOpHash: signed.hash, raw: signed.raw, depositIndex: 0, deposited: balance.toString(), confirmedAt: 0 },
  });
  await broadcast(signed.raw);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: signed.hash });
  if (receipt.status !== 'success') {
    await updateActiveTrade({ reshield: undefined });
    throw new Error(`The Railgun shield reverted (tx ${signed.hash}). The tokens are still at the owner; they were not sent again.`);
  }
  await updateActiveTrade({
    reshield: { status: 'confirmed', userOpHash: signed.hash, raw: signed.raw, depositIndex: 0, deposited: balance.toString(), confirmedAt: Date.now() },
  });
  return { txHash: signed.hash, amountUnits: balance };
}

/**
 * Shield an exact token amount, gas paid in ETH. Used after a private Uniswap
 * swap, where the output is WETH and Circle's USDC paymaster does not apply.
 * A shield already recorded on this trade is not sent again.
 */
export async function shieldOwnerToken(token: Address, amount: bigint): Promise<{ txHash: Hash; amountUnits: bigint }> {
  const trade = await getActiveTrade();
  if (!trade) throw new Error('No active trade to shield.');
  if (amount <= 0n) throw new Error('There is nothing to shield.');
  if (trade.reshield?.status === 'pending' && trade.reshield.userOpHash) {
    return settlePendingShield(trade);
  }
  if (trade.reshield?.status === 'confirmed' && trade.reshield.userOpHash) {
    return { txHash: trade.reshield.userOpHash as Hash, amountUnits: BigInt(trade.reshield.deposited) };
  }
  const owner = await ownerAt(trade.ownerIndex);
  const mnemonic = await requireUnlockedMnemonic();
  const signature = await privateKeyToAccount(owner.privateKey).signMessage({ message: SHIELD_MESSAGE });
  const shielded = await shieldPayingEth(owner.privateKey, owner.address, amount, mnemonic, keccak256(signature), token);
  if (!shielded) {
    throw new Error(`Not enough ETH at ${owner.address} to shield these tokens back into Railgun. The tokens are still at that address.`);
  }
  return shielded;
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

/**
 * What the owner must hold before the proof is built: enough for the gas
 * estimate. NOT the real cost, which is known only after signing and is
 * checked then (maxCostWei). Raising this to a guess of the real cost made a
 * funded owner (0.0000918 ETH, real cost 0.000057) ask for a top-up the vault
 * could not pay, and the retry was refused.
 */
const UNSHIELD_GAS_WEI = 50_000_000_000_000n;
/**
 * What an owner with NO ETH is given in one go. Measured: one unshield
 * needed 0.0000570 ETH, so a single top-up of this usually covers both the
 * estimate and the signed transaction, rather than two transfers.
 */
const FRESH_OWNER_TOPUP_WEI = 100_000_000_000_000n;

/**
 * The unshield is a normal transaction, so the fresh owner has to hold ETH.
 * An earlier owner from this same vault can pay that, which does link the two
 * addresses. A vault with no ETH anywhere is refused, naming the shortfall.
 *
 * `needWei` is the target balance. It tops up the shortfall plus 20%, so a
 * fee that moves a little between the check and the broadcast still clears.
 */
export async function ensureUnshieldGas(ownerIndex: number, owner: Address, needWei = UNSHIELD_GAS_WEI): Promise<void> {
  const balance = await publicClient.getBalance({ address: owner });
  if (balance >= needWei) return;
  const shortfall = needWei - balance + needWei / 5n;
  const topUp = balance === 0n && shortfall < FRESH_OWNER_TOPUP_WEI ? FRESH_OWNER_TOPUP_WEI : shortfall;

  for (let index = 0; index < ownerIndex; index += 1) {
    const earlier = await ownerAt(index);
    const earlierBalance = await publicClient.getBalance({ address: earlier.address });
    const price = (await publicClient.getGasPrice()) * 2n;
    // 21,000 is Ethereum's transfer minimum. Arbitrum adds the cost of posting
    // the transaction to Ethereum and rejects that limit.
    const gas = arbitrumGasLimit(undefined);
    const transferCost = gas * price;
    if (earlierBalance < topUp + transferCost) continue;

    const account = privateKeyToAccount(earlier.privateKey);
    const nonce = await publicClient.getTransactionCount({ address: earlier.address });
    const raw = await account.signTransaction({
      chainId: ARBITRUM_CHAIN_ID,
      nonce,
      to: owner,
      value: topUp,
      gas,
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
    `This owner needs ${formatEther(topUp)} more ETH on Arbitrum One for the Railgun unshield gas. Send it to ${owner}, then retry funding (an unshield already signed is resent on its own). Nothing left the pool.`,
  );
}

async function signPopulated(
  privateKey: Hex,
  tx: PopulatedRailgunTx,
): Promise<{ hash: Hash; raw: Hex }> {
  const account = privateKeyToAccount(privateKey);
  const nonce = await publicClient.getTransactionCount({ address: account.address });
  const quoted = BigInt(tx.gasLimit);
  if (quoted === 0n) throw new Error('Railgun returned a transaction with no gas limit.');
  // The quote often misses the cost of posting the proof to Ethereum, and
  // Arbitrum then rejects the broadcast with "intrinsic gas too low".
  const gas = arbitrumGasLimit(tx.data as Hex, quoted);
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

/**
 * Re-sign a stored transaction whose gas limit cannot pay for posting its
 * calldata. The nonce stays: Arbitrum rejected the old bytes, so they are
 * not in the mempool. A limit that is already high enough is returned as-is.
 */
async function raiseGasIfNeeded(privateKey: Hex, raw: Hex): Promise<Hex> {
  const parsed = parseTransaction(raw);
  const next = arbitrumGasLimit(parsed.data, parsed.gas ?? 0n);
  if (parsed.gas !== undefined && next <= parsed.gas) return raw;
  if (!parsed.to) throw new Error('The stored unshield has no recipient.');
  const account = privateKeyToAccount(privateKey);
  return account.signTransaction({
    chainId: parsed.chainId ?? ARBITRUM_CHAIN_ID,
    nonce: parsed.nonce ?? 0,
    to: parsed.to,
    data: parsed.data,
    value: parsed.value ?? 0n,
    gas: next,
    maxFeePerGas: parsed.maxFeePerGas ?? parsed.gasPrice ?? 0n,
    maxPriorityFeePerGas: parsed.maxPriorityFeePerGas ?? 0n,
    type: 'eip1559',
  });
}

async function broadcast(raw: Hex): Promise<void> {
  await publicClient.sendRawTransaction({ serializedTransaction: raw }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (/already known|nonce too low|replacement transaction underpriced/i.test(message)) return;
    throw error;
  });
}

/**
 * Where the Railgun sync has got to. Cheap: the offscreen document answers
 * from a variable, without the SDK and without waiting on the sync.
 */
export async function railgunSyncStatus(): Promise<RailgunSyncStatus> {
  return ask<RailgunSyncStatus>({ kind: 'railgunSyncStatus' });
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
