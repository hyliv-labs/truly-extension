/**
 * Proves the fetched circuit artifacts actually work: generates a real Groth16
 * commitment proof and verifies it.
 *
 * The SDK fetches artifacts over HTTP in browser mode, so this serves
 * public/privacy-pools/artifacts/ from a local server and points baseUrl at
 * it — the same code path the offscreen document takes. The fs path would
 * prove nothing about the extension.
 *
 * Every request is logged, because a 404 here surfaces inside the SDK only as
 * "Failed to generate proof" with no path named.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Circuits, PrivacyPoolSDK } from '@0xbow/privacy-pools-core-sdk';

const startedAt = Date.now();
const at = () => `[${((Date.now() - startedAt) / 1000).toFixed(1)}s]`;
const log = (...args: unknown[]) => console.log(at(), ...args);

const artifactDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'public',
  'privacy-pools',
  'artifacts',
);

const server = createServer(async (req, res) => {
  const url = req.url ?? '/';
  const name = url.replace(/^\/artifacts\//, '').replace(/^\//, '').split('?')[0] ?? '';
  try {
    const bytes = await readFile(join(artifactDir, name));
    log(`served ${url} (${(bytes.length / 1_048_576).toFixed(2)} MiB)`);
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(bytes.length),
    });
    res.end(bytes);
  } catch {
    log(`404 ${url} <-- the SDK asked for something we do not have`);
    res.writeHead(404).end();
  }
});

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (typeof address === 'string' || address === null) throw new Error('no port');
const baseUrl = `http://127.0.0.1:${address.port}/`;

let failed = false;
const fail = (msg: string) => {
  console.error('FAIL', msg);
  failed = true;
};
const pass = (msg: string) => console.log('pass', msg);

/** Nothing here should take minutes; a hang is a bug, not slowness. */
function withTimeout<T>(promise: Promise<T>, seconds: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`${label} did not finish within ${seconds}s`)),
        seconds * 1000,
      ),
    ),
  ]);
}

try {
  log(`serving ${artifactDir}`);
  log(`baseUrl ${baseUrl}`);

  // browser: true is the extension's code path — fetch, not fs.
  const sdk = new PrivacyPoolSDK(new Circuits({ browser: true, baseUrl }));

  log('proving commitment…');
  const t0 = Date.now();
  const proof = await withTimeout(
    sdk.proveCommitment(1_000_000n, 123n, 456n, 789n),
    240,
    'proveCommitment',
  );
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  if (!proof?.proof) fail('proveCommitment returned no proof');
  else pass(`generated a real Groth16 proof in ${elapsed}s`);

  const valid = await withTimeout(sdk.verifyCommitment(proof), 60, 'verifyCommitment');
  if (!valid) fail('the generated proof did NOT verify');
  else pass('proof verifies against the bundled vkey');
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
  for (const key of Object.getOwnPropertyNames(error as object)) {
    if (key === 'stack' || key === 'message') continue;
    const value = (error as Record<string, unknown>)[key];
    console.error(
      `  ${key}:`,
      typeof value === 'object'
        ? JSON.stringify(value, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x))
        : String(value),
    );
  }
} finally {
  // close() alone leaves keep-alive sockets open, so Node never exits and the
  // run looks like a hang long after the proof has finished.
  server.closeAllConnections();
  server.close();

}

/**
 * snarkjs starts a bn128 worker pool and never shuts it down, and the handle
 * is not reachable from here (it lives in the SDK's bundled module scope), so
 * the process would otherwise hang forever with the work already done. From
 * the outside that is indistinguishable from proving never returning — which
 * is exactly how this looked for two runs before the cause was found.
 *
 * Everything this script checks has completed by now, so exit explicitly.
 */
process.exit(failed ? 1 : 0);
