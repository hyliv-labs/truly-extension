/**
 * Fetch the Railgun unshield circuit that matches the Arbitrum proxy.
 *
 * Wallet 10.4.0's own IPFS hash is an older 1x2 key. The proxy verifies the
 * current 01x02 key (IPFS QmUsmnK4…). These files are decompressed and written
 * where the extension serves them under the old `1x2` path. Hashes are of the
 * decompressed bytes, pinned from the key that already verified on Arbitrum.
 *
 * MV3 forbids remote code, so proving never downloads this at runtime.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { brotliDecompressSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { RAILGUN_CIRCUIT_IC0 } from '../src/lib/railgun-circuit.ts';

const IPFS = 'https://ipfs-lb.com/ipfs/QmUsmnK4PFc7zDp2cmC4wBZxYLjNyRgWfs5GNcJJ2uLcpU';

const FILES = [
  {
    name: 'vkey.json',
    url: `${IPFS}/circuits/01x02/vkey.json`,
    compressed: false,
    sha256: '9369fa6ad3d7a1becf4b10cf4bd6a7eb83725cfb5cf75a08b191c5bc2cd479f4',
  },
  {
    name: 'zkey',
    url: `${IPFS}/circuits/01x02/zkey.br`,
    compressed: true,
    sha256: '8ef8e7abcfb5e60fb593d4d961657465f498435a0835adef05acc09534d7557b',
  },
  {
    name: 'wasm',
    url: `${IPFS}/prover/snarkjs/01x02.wasm.br`,
    compressed: true,
    sha256: '6ce87ddb4e33cff9564338a8b1f58047b22809e5d198f243c777d1aa4eaaa1e3',
  },
] as const;

const destination = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'railgun', '1x2');

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function alreadyPinned(): boolean {
  return FILES.every((file) => {
    const path = join(destination, file.name);
    if (!existsSync(path)) return false;
    return sha256(readFileSync(path)) === file.sha256;
  });
}

if (alreadyPinned()) {
  console.log('[railgun-circuit] pinned 1x2 key already present');
} else {
  mkdirSync(destination, { recursive: true });
  for (const file of FILES) {
    process.stdout.write(`fetching ${file.name} … `);
    const response = await fetch(file.url);
    if (!response.ok) {
      throw new Error(`${file.name}: HTTP ${response.status} from ${file.url}`);
    }
    const downloaded = new Uint8Array(await response.arrayBuffer());
    const bytes = file.compressed ? new Uint8Array(brotliDecompressSync(downloaded)) : downloaded;
    const actual = sha256(bytes);
    if (actual !== file.sha256) {
      throw new Error(`${file.name}: SHA-256 mismatch — expected ${file.sha256}, got ${actual}.`);
    }
    writeFileSync(join(destination, file.name), bytes);
    console.log(`ok (${(bytes.length / 1_048_576).toFixed(2)} MiB)`);
  }
}

const vkey = JSON.parse(readFileSync(join(destination, 'vkey.json'), 'utf8')) as { IC?: string[][] };
const ic0 = vkey.IC?.[0]?.[0];
if (ic0 !== RAILGUN_CIRCUIT_IC0) {
  throw new Error(`vkey IC[0] does not match the Arbitrum proxy. Got ${ic0 ?? 'nothing'}.`);
}
console.log('[railgun-circuit] vkey matches the Arbitrum proxy');
