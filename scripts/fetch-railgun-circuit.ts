/**
 * Fetch the Railgun unshield circuits that match the Arbitrum proxy.
 *
 * Wallet 10.4.0's own IPFS hashes are older keys. The proxy verifies the
 * current ones (IPFS QmUsmnK4…). These files are decompressed and written
 * where the extension serves them under the old names the SDK requests
 * (`1x2`, `2x2`, `3x2`). Hashes are of the decompressed bytes, pinned from keys whose
 * IC[0] matches the proxy's getVerificationKey. See src/lib/railgun-circuit.ts.
 *
 * MV3 forbids remote code, so proving never downloads these at runtime.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { brotliDecompressSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { RAILGUN_CIRCUITS, type RailgunCircuit } from '../src/lib/railgun-circuit.ts';

const IPFS = 'https://ipfs-lb.com/ipfs/QmUsmnK4PFc7zDp2cmC4wBZxYLjNyRgWfs5GNcJJ2uLcpU';
const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'railgun');

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function sources(circuit: RailgunCircuit) {
  return [
    { name: 'vkey.json', url: `${IPFS}/circuits/${circuit.ipfsName}/vkey.json`, compressed: false },
    { name: 'zkey', url: `${IPFS}/circuits/${circuit.ipfsName}/zkey.br`, compressed: true },
    { name: 'wasm', url: `${IPFS}/prover/snarkjs/${circuit.ipfsName}.wasm.br`, compressed: true },
  ] as const;
}

for (const circuit of RAILGUN_CIRCUITS) {
  const destination = join(root, circuit.id);
  const files = sources(circuit);
  const pinned = files.every((file) => {
    const path = join(destination, file.name);
    return existsSync(path) && sha256(readFileSync(path)) === circuit.sha256[file.name];
  });

  if (pinned) {
    console.log(`[railgun-circuit] pinned ${circuit.id} key already present`);
  } else {
    mkdirSync(destination, { recursive: true });
    for (const file of files) {
      process.stdout.write(`fetching ${circuit.id} ${file.name} … `);
      const response = await fetch(file.url);
      if (!response.ok) {
        throw new Error(`${circuit.id} ${file.name}: HTTP ${response.status} from ${file.url}`);
      }
      const downloaded = new Uint8Array(await response.arrayBuffer());
      const bytes = file.compressed ? new Uint8Array(brotliDecompressSync(downloaded)) : downloaded;
      const actual = sha256(bytes);
      if (actual !== circuit.sha256[file.name]) {
        throw new Error(`${circuit.id} ${file.name}: SHA-256 mismatch — expected ${circuit.sha256[file.name]}, got ${actual}.`);
      }
      writeFileSync(join(destination, file.name), bytes);
      console.log(`ok (${(bytes.length / 1_048_576).toFixed(2)} MiB)`);
    }
  }

  const vkey = JSON.parse(readFileSync(join(destination, 'vkey.json'), 'utf8')) as { IC?: string[][] };
  const ic0 = vkey.IC?.[0]?.[0];
  if (ic0 !== circuit.ic0) {
    throw new Error(`${circuit.id} vkey IC[0] does not match the Arbitrum proxy. Got ${ic0 ?? 'nothing'}.`);
  }
  console.log(`[railgun-circuit] ${circuit.id} vkey matches the Arbitrum proxy`);
}
