/**
 * The proving step, split across the service worker / offscreen boundary.
 *
 * WHY A SPLIT AT ALL. snarkjs needs real DOM, workers and WebAssembly, so it
 * can only run in the offscreen document. But the vault, the note store and
 * chrome.storage live in the service worker, and anon-rpc's worker is
 * constructed there too. Neither context can run the whole withdrawal, so the
 * orchestration stays in the worker and ONLY the proof is sent across.
 *
 * SECRETS CROSS THIS BOUNDARY. The payload carries the note's nullifier and
 * secret — spend authority for that note. Same rule as the recovery signature:
 * never log it, never persist it, never send it to analytics or an error
 * reporter. Errors returned from the offscreen side carry a message only, and
 * the input is never included in one.
 *
 * Everything is a decimal string on the wire: chrome.runtime messaging is JSON
 * serialisation, which silently drops bigints.
 *
 * THIS FILE MUST NOT IMPORT snarkjs, directly or transitively. It is pulled
 * into the service worker, which is built as a single IIFE; snarkjs forces
 * code-splitting and the build fails. The proof itself lives in
 * prove-withdrawal-run.ts, which only the offscreen document imports.
 */


/** A merkle proof flattened to strings for the wire. */
export interface WireMerkleProof {
  readonly root: string;
  readonly leaf: string;
  readonly index: number;
  readonly siblings: readonly string[];
}

export interface ProveWithdrawalInput {
  readonly value: string;
  readonly label: string;
  readonly nullifier: string;
  readonly secret: string;
  readonly withdrawalAmount: string;
  readonly context: string;
  readonly stateMerkleProof: WireMerkleProof;
  readonly aspMerkleProof: WireMerkleProof;
  readonly newNullifier: string;
  readonly newSecret: string;
}

export interface ProveWithdrawalOutput {
  readonly publicSignals: readonly string[];
  readonly proof: {
    readonly pi_a: readonly string[];
    readonly pi_b: readonly (readonly string[])[];
    readonly pi_c: readonly string[];
    readonly protocol?: string;
    readonly curve?: string;
  };
}

export function toWireMerkleProof(proof: {
  root: unknown;
  leaf: unknown;
  index: number;
  siblings: unknown[];
}): WireMerkleProof {
  return {
    root: String(proof.root),
    leaf: String(proof.leaf),
    index: proof.index,
    siblings: proof.siblings.map(String),
  };
}

export class ProvingUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProvingUnavailable';
  }
}

/**
 * Called FROM THE SERVICE WORKER. Hands the proof off to the offscreen
 * document and waits for the result.
 *
 * The caller is responsible for having ensured the offscreen document exists.
 */
export async function proveWithdrawalOffscreen(
  input: ProveWithdrawalInput,
): Promise<ProveWithdrawalOutput> {
  let response: { ok?: boolean; value?: ProveWithdrawalOutput; error?: string } | undefined;
  try {
    response = await chrome.runtime.sendMessage({
      target: 'truly:offscreen',
      kind: 'proveWithdrawal',
      input,
    });
  } catch (error) {
    // Deliberately does not include `input`, which holds spend authority.
    throw new ProvingUnavailable(
      `The proof builder could not be reached: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (!response?.ok || !response.value) {
    throw new ProvingUnavailable(response?.error ?? 'The proof builder returned no result.');
  }
  return response.value;
}
