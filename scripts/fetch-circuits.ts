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
  /**
   * SHA-256, taken from the SDK's own frozen ARTIFACT_HASHES table. The SDK
   * refuses to load an artifact whose hash is not in that table, so matching
   * it is proof we fetched exactly what the SDK trusts — a stronger anchor
   * than any hash we could choose ourselves.
   */
  readonly sha256: string;
}

const ARTIFACTS: Artifact[] = [
  {
    source: 'packages/circuits/trusted-setup/final-keys/withdraw.zkey',
    name: 'withdraw.zkey',
    sha256: '2a893b42174c813566e5c40c715a8b90cd49fc4ecf384e3a6024158c3d6de677',
  },
  {
    source: 'packages/circuits/trusted-setup/final-keys/withdraw.vkey',
    name: 'withdraw.vkey',
    sha256: '666bd0983b20c1611543b04f7712e067fbe8cad69f07ada8a310837ff398d21e',
  },
  {
    source: 'packages/circuits/build/withdraw/withdraw_js/withdraw.wasm',
    name: 'withdraw.wasm',
    sha256: '36cda22791def3d520a55c0fc808369cd5849532a75fab65686e666ed3d55c10',
  },
  {
    source: 'packages/circuits/trusted-setup/final-keys/commitment.zkey',
    name: 'commitment.zkey',
    sha256: '494ae92d64098fda2a5649690ddc5821fcd7449ca5fe8ef99ee7447544d7e1f3',
  },
  {
    source: 'packages/circuits/trusted-setup/final-keys/commitment.vkey',
    name: 'commitment.vkey',
    sha256: '7d48b4eb3dedc12fb774348287b587f0c18c3c7254cd60e9cf0f8b3636a570d8',
  },
  {
    source: 'packages/circuits/build/commitment/commitment_js/commitment.wasm',
    name: 'commitment.wasm',
    sha256: '254d2130607182fd6fd1aee67971526b13cfe178c88e360da96dce92663828d8',
  },
];

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * The SDK resolves each artifact as `<baseUrl>/artifacts/<name>` — its own
 * error says "make sure assets are hosted from /artifacts". Putting them at
 * the base instead gives a 404 inside the SDK that surfaces only as
 * "Failed to generate proof", so the subdirectory is load-bearing.
 */
const destination = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'public',
  'privacy-pools',
  'artifacts',
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
  const actual = sha256(bytes);

  if (actual !== artifact.sha256) {
    throw new Error(
      `${artifact.name}: SHA-256 mismatch — expected ${artifact.sha256}, got ${actual}. ` +
        'Refusing to write a proving key the SDK would not trust.',
    );
  }

  writeFileSync(join(destination, artifact.name), bytes);
  console.log(`ok (${(bytes.length / 1_048_576).toFixed(2)} MiB, sha ${actual.slice(0, 8)})`);
}

console.log(`\n[circuits] ${ARTIFACTS.length} artifacts verified -> public/privacy-pools/`);
