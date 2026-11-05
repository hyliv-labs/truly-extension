/**
 * Fetch the Privacy Pools circuit artifacts into public/privacy-pools/.
 *
 * They are not in the npm package and 0xbow publishes no release assets, but
 * they ARE committed to privacy-pools-core. The file list and the two source
 * directories come from the SDK's own scripts/copy_circuits.sh, which is the
 * authoritative answer to "which zkey matches the deployed verifier": the
 * trusted-setup/final-keys ones, NOT the groth16_pkey.zkey under build/.
 *
 * Every file is verified by its git blob SHA-1 before being written. These are
 * proving keys for real money — a corrupted or substituted zkey must fail
 * loudly here rather than produce proofs that do not verify.
 *
 * MV3 forbids remote code, so these ship inside the extension; they are never
 * fetched at runtime.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Pinned, so an upstream change cannot silently swap a proving key. */
const COMMIT = 'df4bf730214bf9d0c717a9258f7a74861758c269';
const REPO = '0xbow-io/privacy-pools-core';

interface Artifact {
  /** Path in the upstream repo. */
  readonly source: string;
  /** Filename the SDK expects under baseUrl. */
  readonly name: string;
  /** git blob SHA-1. */
  readonly sha: string;
}

const ARTIFACTS: Artifact[] = [
  {
    source: 'packages/circuits/trusted-setup/final-keys/withdraw.zkey',
    name: 'withdraw.zkey',
    sha: '5c64ced16184db030e836f41423a983235137f3f',
  },
  {
    source: 'packages/circuits/trusted-setup/final-keys/withdraw.vkey',
    name: 'withdraw.vkey',
    sha: 'f39a0e6f2696cffb587a718275efc980136168b0',
  },
  {
    source: 'packages/circuits/build/withdraw/withdraw_js/withdraw.wasm',
    name: 'withdraw.wasm',
    sha: '2b3457f0136681163ff6d875441fb3519ec5b5a6',
  },
  {
    source: 'packages/circuits/trusted-setup/final-keys/commitment.zkey',
    name: 'commitment.zkey',
    sha: '0f621456056f84bf6456361908d03a1bfc57f09f',
  },
  {
    source: 'packages/circuits/trusted-setup/final-keys/commitment.vkey',
    name: 'commitment.vkey',
    sha: '7747b4c6a14e672a71a4e26263e43c40a73fc838',
  },
  {
    source: 'packages/circuits/build/commitment/commitment_js/commitment.wasm',
    name: 'commitment.wasm',
    sha: 'f3b59f1216156396a41bfb2dce1f1552cf99a1ed',
  },
];

/** git hashes a blob as sha1("blob <len>\0" + contents). */
function gitBlobSha(bytes: Uint8Array): string {
  const header = Buffer.from(`blob ${bytes.length}\0`, 'utf8');
  return createHash('sha1').update(Buffer.concat([header, bytes])).digest('hex');
}

const destination = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'public',
  'privacy-pools',
);
mkdirSync(destination, { recursive: true });

for (const artifact of ARTIFACTS) {
  const url = `https://raw.githubusercontent.com/${REPO}/${COMMIT}/${artifact.source}`;
  process.stdout.write(`fetching ${artifact.name} … `);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${artifact.name}: HTTP ${response.status} from ${url}`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  const actual = gitBlobSha(bytes);

  if (actual !== artifact.sha) {
    throw new Error(
      `${artifact.name}: hash mismatch — expected ${artifact.sha}, got ${actual}. ` +
        'Refusing to write a proving key that is not the pinned one.',
    );
  }

  writeFileSync(join(destination, artifact.name), bytes);
  console.log(`ok (${(bytes.length / 1_048_576).toFixed(2)} MiB, sha ${actual.slice(0, 8)})`);
}

console.log(`\n[circuits] ${ARTIFACTS.length} artifacts verified -> public/privacy-pools/`);
