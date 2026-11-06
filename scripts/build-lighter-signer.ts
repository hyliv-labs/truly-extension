/**
 * Build Lighter's official transaction signer into public/lighter/.
 *
 * Lighter orders are Schnorr-signed over Goldilocks field elements, not ECDSA,
 * so viem cannot produce them. The only official browser path is lighter-go's
 * own WASM build (`wasm/`), the same signer every Lighter SDK wraps. Writing a
 * second implementation of that hash would be the riskiest code in the repo,
 * so this builds theirs from a pinned commit instead.
 *
 * The output is checked against a pinned SHA-256. `-trimpath` plus a pinned
 * toolchain makes the build reproducible, so a hash mismatch means either the
 * source or the compiler changed — both are reasons to stop, not to ship.
 *
 * Needs Go on PATH. lighter-go asks for go1.26, and GOTOOLCHAIN downloads it
 * when the local Go is older (Go >= 1.21).
 *
 * MV3 forbids remote code, so the signer ships inside the extension and is
 * never fetched at runtime.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'https://github.com/elliottech/lighter-go.git';
/** Pinned, so an upstream change cannot silently swap the signer. */
const COMMIT = 'aefa96848a105d82a6bbb55d3d05663293a71713';
const TOOLCHAIN = 'go1.26.0';

const SIGNER_SHA256 = 'b6e0440ff5df5eb981324dac6f4e03660ea0cfd4b6b5f9353fe7bdfc0131483b';
/** wasm_exec.js must come from the SAME Go release that built the binary. */
const WASM_EXEC_SHA256 = '0c949f4996f9a89698e4b5c586de32249c3b69b7baadb64d220073cc04acba14';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public', 'lighter');
const signerOut = join(outDir, 'lighter-signer.wasm');
const vendored = join(root, 'src', 'vendor', 'go-wasm-exec.js');

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** The vendored runtime is upstream's file plus one export line. */
function checkVendoredRuntime(upstream: Uint8Array | null): void {
  const text = readFileSync(vendored, 'utf8');
  const marker = '\n// --- truly: export the class so the bundler cannot drop this module ---\n';
  const at = text.indexOf(marker);
  if (at < 0) throw new Error(`${vendored}: missing the truly export marker.`);
  const original = Buffer.from(text.slice(0, at), 'utf8');
  if (sha256(original) !== WASM_EXEC_SHA256) {
    throw new Error(
      `${vendored} differs from ${TOOLCHAIN}'s wasm_exec.js. It must match the toolchain that built the signer.`,
    );
  }
  if (upstream && sha256(upstream) !== WASM_EXEC_SHA256) {
    throw new Error(`the toolchain's wasm_exec.js does not match the pinned ${TOOLCHAIN} hash.`);
  }
}

if (existsSync(signerOut) && sha256(readFileSync(signerOut)) === SIGNER_SHA256) {
  checkVendoredRuntime(null);
  console.log('[lighter] signer already built and verified');
  process.exit(0);
}

const work = join(tmpdir(), `truly-lighter-go-${COMMIT.slice(0, 12)}`);
const env = { ...process.env, GOTOOLCHAIN: TOOLCHAIN, GOFLAGS: '-mod=readonly' };

if (!existsSync(join(work, 'go.mod'))) {
  console.log(`[lighter] cloning lighter-go@${COMMIT.slice(0, 12)} …`);
  execFileSync('git', ['clone', '--quiet', REPO, work], { stdio: 'inherit' });
}
execFileSync('git', ['-C', work, 'checkout', '--quiet', COMMIT], { stdio: 'inherit' });

try {
  execFileSync('go', ['version'], { env, stdio: 'ignore' });
} catch {
  throw new Error(
    `Go is required to build Lighter's signer (${TOOLCHAIN}; an older Go >= 1.21 downloads it automatically). Install it from https://go.dev/dl/.`,
  );
}

console.log(`[lighter] building signer with ${TOOLCHAIN} …`);
const built = join(work, 'build', 'lighter-signer.wasm');
mkdirSync(dirname(built), { recursive: true });
execFileSync('go', ['build', '-trimpath', '-o', built, './wasm/'], {
  cwd: work,
  env: { ...env, GOOS: 'js', GOARCH: 'wasm' },
  stdio: 'inherit',
});

const bytes = readFileSync(built);
const actual = sha256(bytes);
if (actual !== SIGNER_SHA256) {
  throw new Error(
    `lighter-signer.wasm: SHA-256 mismatch — expected ${SIGNER_SHA256}, got ${actual}. Refusing to ship a signer that differs from the pinned build.`,
  );
}

const goroot = execFileSync('go', ['env', 'GOROOT'], { env, encoding: 'utf8' }).trim();
checkVendoredRuntime(readFileSync(join(goroot, 'lib', 'wasm', 'wasm_exec.js')));

mkdirSync(outDir, { recursive: true });
writeFileSync(signerOut, bytes);
console.log(`[lighter] signer verified (${(bytes.length / 1_048_576).toFixed(2)} MiB, sha ${actual.slice(0, 8)}) -> public/lighter/`);
