/**
 * Generates a REAL withdrawal proof and checks it against the relayer's
 * contract: exactly 8 public signals, in the order the relayer's zod schema
 * and the on-chain verifier expect.
 *
 * The commitment proof checked earlier exercises a different, much smaller
 * circuit. This is the one the money path actually depends on, and the one
 * whose output shape the relayer rejects if it is wrong.
 *
 * Everything here is local: a synthetic state tree and ASP tree, so no funded
 * deposit is needed to prove the circuit works.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Circuits,
  PrivacyPoolSDK,
  generateMasterKeys,
  generateDepositSecrets,
  generateWithdrawalSecrets,
  getCommitment,
  generateMerkleProof,
  type Hash,
  type Secret,
} from '@0xbow/privacy-pools-core-sdk';

const artifactDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'public',
  'privacy-pools',
  'artifacts',
);

const server = createServer(async (req, res) => {
  const name = (req.url ?? '').replace(/^\/artifacts\//, '').replace(/^\//, '').split('?')[0] ?? '';
  try {
    const bytes = await readFile(join(artifactDir, name));
    res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(bytes);
  } catch {
    res.writeHead(404).end();
  }
});

await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const addr = server.address();
if (typeof addr === 'string' || addr === null) throw new Error('no port');
const baseUrl = `http://127.0.0.1:${addr.port}/`;

let failed = false;
const fail = (msg: string) => {
  console.error('FAIL', msg);
  failed = true;
};
const pass = (msg: string) => console.log('pass', msg);

const PHRASE = 'test test test test test test test test test test test junk';
// The real Arbitrum USDC pool scope, read from SCOPE() on chain.
const SCOPE = 19314316433070648921215665277427138450050666275686107272761703472573535400848n as unknown as Hash;

try {
  const sdk = new PrivacyPoolSDK(new Circuits({ browser: true, baseUrl }));
  const keys = generateMasterKeys(PHRASE);

  // A deposit of 10 USDC (6 decimals) at index 0.
  const value = 10_000_000n;
  const { nullifier, secret } = generateDepositSecrets(keys, SCOPE, 0n);
  // The label is assigned by the pool on deposit; synthetic here.
  const label = 42n;
  const commitment = getCommitment(value, label, nullifier, secret);
  pass(`built a commitment for 10 USDC: ${String(commitment.hash).slice(0, 18)}…`);

  // State tree holds commitment hashes; ASP tree holds approved labels.
  const stateLeaves = [commitment.hash as unknown as bigint, 111n, 222n, 333n];
  const aspLeaves = [label, 999n, 888n];

  const stateMerkleProof = generateMerkleProof(stateLeaves, commitment.hash as unknown as bigint);
  const aspMerkleProof = generateMerkleProof(aspLeaves, label);

  const withdrawalAmount = 4_000_000n; // withdraw 4 USDC, 6 remain
  const { nullifier: newNullifier, secret: newSecret } = generateWithdrawalSecrets(
    keys,
    label as unknown as Hash,
    0n,
  );

  const started = Date.now();
  const proof = await sdk.proveWithdrawal(commitment, {
    context: 12345n,
    withdrawalAmount,
    stateMerkleProof,
    aspMerkleProof,
    stateRoot: stateMerkleProof.root as unknown as Hash,
    stateTreeDepth: BigInt(stateMerkleProof.siblings.length),
    aspRoot: aspMerkleProof.root as unknown as Hash,
    aspTreeDepth: BigInt(aspMerkleProof.siblings.length),
    newSecret: newSecret as Secret,
    newNullifier: newNullifier as Secret,
  });
  pass(`generated a withdrawal proof in ${((Date.now() - started) / 1000).toFixed(1)}s`);

  const signals = (proof as { publicSignals: string[] }).publicSignals;

  // THE RELAYER CONSTRAINT: zRelayRequest requires exactly 8.
  if (!Array.isArray(signals)) {
    fail('publicSignals is not an array');
  } else if (signals.length !== 8) {
    fail(`publicSignals has ${signals.length} entries; the relayer requires exactly 8`);
  } else {
    pass('publicSignals has exactly 8 entries, as the relayer requires');
  }

  // The relayer coerces each signal with z.string(); a bigint would fail.
  if (signals?.some((s) => typeof s !== 'string')) {
    fail('a public signal is not a string — the relayer schema would reject it');
  } else {
    pass('every public signal is a string');
  }

  // Proof shape: pi_a[3], pi_b[3][2], pi_c[3].
  const p = (proof as unknown as {
    proof: { pi_a: string[]; pi_b: string[][]; pi_c: string[] };
  }).proof;
  const okA = Array.isArray(p.pi_a) && p.pi_a.length === 3;
  const okB =
    Array.isArray(p.pi_b) &&
    p.pi_b.length === 3 &&
    p.pi_b.every((r) => Array.isArray(r) && r.length === 2);
  const okC = Array.isArray(p.pi_c) && p.pi_c.length === 3;
  if (!okA || !okB || !okC) {
    fail(`proof shape wrong: pi_a=${okA} pi_b=${okB} pi_c=${okC}`);
  } else {
    pass('proof matches the relayer schema: pi_a[3], pi_b[3][2], pi_c[3]');
  }

  // Scope and root handling: the signals must carry the values we supplied,
  // or the pool would reject the withdrawal against its own root.
  const asBig = signals?.map((s) => BigInt(s)) ?? [];
  if (!asBig.includes(stateMerkleProof.root as unknown as bigint)) {
    fail('the state root is not among the public signals');
  } else {
    pass('the state root appears in the public signals');
  }
  if (!asBig.includes(aspMerkleProof.root as unknown as bigint)) {
    fail('the ASP root is not among the public signals');
  } else {
    pass('the ASP root appears in the public signals');
  }
  if (!asBig.includes(12345n)) {
    fail('the context is not among the public signals');
  } else {
    pass('the context appears in the public signals');
  }
  if (!asBig.includes(withdrawalAmount)) {
    fail('the withdrawn value is not among the public signals');
  } else {
    pass('the withdrawn value appears in the public signals');
  }

  console.log('  public signals (in order):');
  signals?.forEach((s, i) => console.log(`    [${i}] ${s}`));

  const valid = await sdk.verifyWithdrawal(proof);
  if (!valid) fail('the withdrawal proof did NOT verify against the bundled vkey');
  else pass('withdrawal proof verifies locally against the bundled vkey');

  // THE REAL TEST: the deployed verifier, not our bundled vkey. If the zkey
  // we ship does not match the verifying key burned into that contract, every
  // withdrawal would fail on chain with the proof looking perfectly valid
  // locally.
  const { createPublicClient, http: httpTransport, parseAbi } = await import('viem');
  const { arbitrum } = await import('viem/chains');

  const client = createPublicClient({
    chain: arbitrum,
    transport: httpTransport('https://arb1.arbitrum.io/rpc'),
  });

  const verifierAbi = parseAbi([
    'function verifyProof(uint256[2] _pA, uint256[2][2] _pB, uint256[2] _pC, uint256[8] _pubSignals) view returns (bool)',
  ]);

  // snarkjs emits homogeneous coordinates (a trailing 1) that the contract
  // does not take, and G2 points with the pair order reversed relative to
  // Solidity. Both are silent: get either wrong and verifyProof simply
  // returns false.
  const big = (v: string | undefined): bigint => BigInt(v ?? '0');
  const pa: readonly [bigint, bigint] = [big(p.pi_a[0]), big(p.pi_a[1])];
  const pb: readonly [readonly [bigint, bigint], readonly [bigint, bigint]] = [
    [big(p.pi_b[0]?.[1]), big(p.pi_b[0]?.[0])],
    [big(p.pi_b[1]?.[1]), big(p.pi_b[1]?.[0])],
  ];
  const pc: readonly [bigint, bigint] = [big(p.pi_c[0]), big(p.pi_c[1])];

  const onChain = await client.readContract({
    address: '0x022891F938Ae7fDC8Ab9Ead0FBf50aBA8C897D6d',
    abi: verifierAbi,
    functionName: 'verifyProof',
    args: [pa, pb, pc, signals!.map(BigInt) as unknown as readonly bigint[]],
  } as never);

  if (onChain !== true) {
    fail('the DEPLOYED Arbitrum verifier rejected the proof');
  } else {
    pass('the deployed Arbitrum verifier ACCEPTS the proof');
  }

  // ---------------------------------------------------------------------
  // THE ASP BATCHING QUESTION.
  //
  // The ASP publishes approvals in batches -- its root was 4.1 days old when
  // measured. If every re-shield had to wait for the next batch, the "one
  // trade at a time" design could not work inside an event.
  //
  // It does not have to, IF a partial withdrawal's change note inherits the
  // ORIGINAL label. The ASP tree holds labels, not commitments, so a change
  // note under an already-approved label is approved the moment it exists.
  // That is the claim; this proves it rather than reading it off the circuit.
  // ---------------------------------------------------------------------

  const remainder = value - withdrawalAmount;
  const changeNote = getCommitment(
    remainder,
    label,
    newNullifier as Secret,
    newSecret as Secret,
  );

  // publicSignals[0] is the new commitment the circuit committed to. If it
  // equals a commitment built with the ORIGINAL label, the label carried over.
  if (BigInt(signals?.[0] ?? '0') !== (changeNote.hash as unknown as bigint)) {
    fail('the change note does not carry the original label — re-screening WOULD be required');
  } else {
    pass('the change note carries the ORIGINAL label (matches publicSignals[0])');
  }

  // Now actually spend it, against the SAME UNCHANGED ASP tree. No new ASP
  // leaf is added: if this proves and verifies, no new screening was needed.
  const stateLeaves2 = [...stateLeaves, changeNote.hash as unknown as bigint];
  const stateProof2 = generateMerkleProof(stateLeaves2, changeNote.hash as unknown as bigint);
  const aspProof2 = generateMerkleProof(aspLeaves, label); // unchanged tree

  const secondAmount = 1_000_000n;
  const { nullifier: n3, secret: s3 } = generateWithdrawalSecrets(keys, label as unknown as Hash, 1n);

  const proof2 = await sdk.proveWithdrawal(changeNote, {
    context: 67890n,
    withdrawalAmount: secondAmount,
    stateMerkleProof: stateProof2,
    aspMerkleProof: aspProof2,
    stateRoot: stateProof2.root as unknown as Hash,
    stateTreeDepth: BigInt(stateProof2.siblings.length),
    aspRoot: aspProof2.root as unknown as Hash,
    aspTreeDepth: BigInt(aspProof2.siblings.length),
    newSecret: s3 as Secret,
    newNullifier: n3 as Secret,
  });
  pass('generated a SECOND withdrawal, spending the change note');

  const sig2 = (proof2 as { publicSignals: string[] }).publicSignals;
  const p2 = (proof2 as unknown as {
    proof: { pi_a: string[]; pi_b: string[][]; pi_c: string[] };
  }).proof;

  const onChain2 = await client.readContract({
    address: '0x022891F938Ae7fDC8Ab9Ead0FBf50aBA8C897D6d',
    abi: verifierAbi,
    functionName: 'verifyProof',
    args: [
      [big(p2.pi_a[0]), big(p2.pi_a[1])],
      [
        [big(p2.pi_b[0]?.[1]), big(p2.pi_b[0]?.[0])],
        [big(p2.pi_b[1]?.[1]), big(p2.pi_b[1]?.[0])],
      ],
      [big(p2.pi_c[0]), big(p2.pi_c[1])],
      sig2.map(BigInt) as unknown as readonly bigint[],
    ],
  } as never);

  if (onChain2 !== true) {
    fail('the deployed verifier rejected the change-note spend');
  } else {
    pass('the deployed verifier ACCEPTS spending the change note under the UNCHANGED ASP root');
    console.log(
      '  => a partial withdrawal leaves an immediately spendable note. ASP batching\n' +
        '     delays only NEW deposits, so trades need not wait days between them.',
    );
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
  const details = (error as { details?: unknown }).details;
  if (details) console.error('  details:', JSON.stringify(details, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v)));
} finally {
  server.closeAllConnections();
  server.close();
}

// snarkjs leaves a worker pool running; see docs/privacy-pools.md.
process.exit(failed ? 1 : 0);
