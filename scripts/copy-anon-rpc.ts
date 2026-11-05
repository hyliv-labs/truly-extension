/**
 * Copy the anon-rpc harness assets into public/ so they ship with the build.
 *
 * This runs from the build, never by hand. The asset directory is version
 * stamped (anon-rpc/<version>-<hash>/), and those files are the far half of a
 * protocol whose near half the bundler rebuilds from node_modules on every
 * install. A stale hand copy makes the two halves disagree SILENTLY — nothing
 * on the boot path has a timeout, so worker.ready would simply never settle.
 * Resolving the path at build time turns that into a missing file instead.
 */

import { cpSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(
  repoRoot,
  'node_modules/@anon-rpc/browser-extension-harness/dist/static/anon-rpc',
);
const destination = join(repoRoot, 'public/anon-rpc');

if (!existsSync(source)) {
  throw new Error(
    `anon-rpc assets missing at ${source} — run pnpm install before building.`,
  );
}

rmSync(destination, { recursive: true, force: true });
cpSync(source, destination, { recursive: true });

const stamped = readdirSync(destination);
console.info(`[anon-rpc] copied ${stamped.join(', ')} -> public/anon-rpc/`);
