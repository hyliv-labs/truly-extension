/**
 * The proof itself. OFFSCREEN DOCUMENT ONLY.
 *
 * Split out from prove-withdrawal.ts deliberately. That module is imported by
 * the service worker, and this one pulls in snarkjs and the circuit artifacts
 * via proving.ts. Importing it from the worker does not merely bloat the
 * bundle — the worker is built as a single IIFE (no background.type =
 * 'module', see wxt.config.ts), and snarkjs forces code-splitting, which IIFE
 * cannot express. The build fails outright.
 *
 * So the boundary is enforced by the bundler, not only by convention: nothing
 * in the service worker may import this file.
 */

import type { Hash, Secret } from '@0xbow/privacy-pools-core-sdk';
import { getCommitment } from '@0xbow/privacy-pools-core-sdk';
import { getSdk } from './proving';
import type { ProveWithdrawalInput, ProveWithdrawalOutput, WireMerkleProof } from './prove-withdrawal';

function fromWireMerkleProof(wire: WireMerkleProof) {
  return {
    root: BigInt(wire.root),
    leaf: BigInt(wire.leaf),
    index: wire.index,
    siblings: wire.siblings.map((s) => BigInt(s)),
  };
}

/**
 * Runs IN THE OFFSCREEN DOCUMENT. Builds the proof and nothing else.
 *
 * Deliberately pure with respect to storage: it reads no vault and writes no
 * state, so the secrets it receives live only for the duration of the call.
 */
export async function runWithdrawalProof(
  input: ProveWithdrawalInput,
): Promise<ProveWithdrawalOutput> {
  const sdk = await getSdk();

  // Built by the SDK, never hand-rolled: its commitment shape is
  // { hash, nullifierHash, preimage: { value, label, precommitment } }, and a
  // flat object feeds undefined into the circuit.
  const commitment = getCommitment(
    BigInt(input.value),
    BigInt(input.label) as unknown as Hash,
    BigInt(input.nullifier) as unknown as Secret,
    BigInt(input.secret) as unknown as Secret,
  );

  const stateMerkleProof = fromWireMerkleProof(input.stateMerkleProof);
  const aspMerkleProof = fromWireMerkleProof(input.aspMerkleProof);

  const proof = await sdk.proveWithdrawal(commitment as never, {
    context: BigInt(input.context),
    withdrawalAmount: BigInt(input.withdrawalAmount),
    stateMerkleProof,
    aspMerkleProof,
    stateRoot: stateMerkleProof.root as unknown as Hash,
    stateTreeDepth: BigInt(stateMerkleProof.siblings.length),
    aspRoot: aspMerkleProof.root as unknown as Hash,
    aspTreeDepth: BigInt(aspMerkleProof.siblings.length),
    newSecret: BigInt(input.newSecret) as unknown as Secret,
    newNullifier: BigInt(input.newNullifier) as unknown as Secret,
  } as never);

  const { publicSignals, proof: rawProof } = proof as unknown as {
    publicSignals: string[];
    proof: { pi_a: string[]; pi_b: string[][]; pi_c: string[] };
  };

  // Checked here, before the result crosses back: the relayer's schema is
  // strict and rejects a malformed bundle after the proving cost is paid.
  if (!Array.isArray(publicSignals) || publicSignals.length !== 8) {
    throw new Error(
      `The circuit produced ${publicSignals?.length} public signals; the relayer requires exactly 8.`,
    );
  }

  return { publicSignals, proof: rawProof };
}

