/**
 * Ship snarkjs's own browser build instead of letting the bundler rewrite it.
 *
 * Rolldown turns ffjavascript's field inverse into a call of a binding that is
 * not a function, and the Railgun chunk then dies at import with
 * "r is not a function" before the engine can start. snarkjs.min.js is the
 * IIFE the project publishes for browsers. The offscreen page loads it as a
 * classic script and the engine reads globalThis.snarkjs.groth16.
 */

import { createRequire } from 'node:module';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const snarkMain = require.resolve('snarkjs', {
  paths: [require.resolve('@railgun-community/wallet')],
});
const source = join(dirname(snarkMain), 'snarkjs.min.js');
const destinationDir = join(repoRoot, 'public/snarkjs');
const destination = join(destinationDir, 'snarkjs.min.js');

mkdirSync(destinationDir, { recursive: true });
copyFileSync(source, destination);
console.info(`[snarkjs] copied browser build -> public/snarkjs/snarkjs.min.js`);
