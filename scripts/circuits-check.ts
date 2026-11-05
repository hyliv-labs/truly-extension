/**
 * Proves the fetched circuit artifacts actually work: generates a real Groth16
 * commitment proof and verifies it.
 *
 * The SDK fetches artifacts over HTTP in browser mode, so this serves
 * public/privacy-pools/ from a local server and points baseUrl at it — the
 * same code path the offscreen document takes, rather than the fs path, which
 * would prove nothing about the extension.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Circuits, PrivacyPoolSDK } from '@0xbow/privacy-pools-core-sdk';

const artifactDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'public',
  'privacy-pools',
  'artifacts',
);

const server = createServer(async (req, res) => {
  try {
    // Mirrors the extension's layout: the SDK fetches <baseUrl>/artifacts/<name>.
    const name = (req.url ?? '/').replace(/^\/artifacts\//, '').split('?')[0] ?? '';
    if (!/^[a-z]+\.(wasm|zkey|vkey)$/.test(name)) {
      res.writeHead(404).end();
      return;
    }
    const bytes = await readFile(join(artifactDir, name));
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(bytes.length),
    });
    res.end(bytes);
  } catch {
    res.writeHead(404).end();
  }
});

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (typeof address === 'string' || address === null) throw new Error('no port');
const baseUrl = `http://127.0.0.1:${address.port}/`;

// Isolate the two possible causes before blaming the SDK: is the server
// serving the file at all, and does the SDK actually take the fetch path?
const probe = await fetch(`${baseUrl}artifacts/commitment.wasm`);
console.log(`probe ${baseUrl}artifacts/commitment.wasm -> HTTP ${probe.status}, ${(await probe.arrayBuffer()).byteLength} bytes`);

let failed = false;
const fail = (msg: string) => {
  console.error('FAIL', msg);
  failed = true;
};
const pass = (msg: string) => console.log('pass', msg);

try {
  // browser: true is the extension's code path — fetch, not fs.
  const sdk = new PrivacyPoolSDK(new Circuits({ browser: true, baseUrl }));
  pass(`serving artifacts from ${baseUrl}`);

  const started = Date.now();
  const proof = await sdk.proveCommitment(
    1_000_000n, // 1 USDC, 6 decimals
    123n, // label
    456n, // nullifier
    789n, // secret
  );
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  if (!proof?.proof) fail('proveCommitment returned no proof');
  else pass(`generated a real Groth16 proof in ${elapsed}s`);

  const valid = await sdk.verifyCommitment(proof);
  if (!valid) fail('the generated proof did NOT verify');
  else pass('proof verifies against the bundled vkey');
} catch (error) {
  fail(`proving threw: ${error instanceof Error ? error.message : String(error)}`);
  // ProofError carries the real reason in its own fields, not in `cause`.
  for (const key of Object.getOwnPropertyNames(error as object)) {
    if (key === 'stack') continue;
    const v = (error as Record<string, unknown>)[key];
    console.error(`  ${key}:`, typeof v === 'object' ? JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x)) : String(v));
  }
  // The SDK wraps failures, so the real reason is in the cause chain.
  let cause: unknown = (error as { cause?: unknown })?.cause;
  let depth = 0;
  while (cause && depth++ < 5) {
    console.error('  caused by:', cause instanceof Error ? cause.message : cause);
    cause = (cause as { cause?: unknown })?.cause;
  }
  if (error instanceof Error && error.stack) {
    console.error(error.stack.split('\n').slice(0, 6).join('\n'));
  }
} finally {
  server.close();
}

process.exitCode = failed ? 1 : 0;
