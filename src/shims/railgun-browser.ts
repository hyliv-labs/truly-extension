/**
 * Loaded before the Railgun SDK in the offscreen document.
 *
 * Import order is the point: this module's body runs before railgun-run.ts
 * is evaluated, so Buffer exists and the engine does not take its Node crypto
 * branch.
 */
import { Buffer } from 'buffer';

interface ProcessStub {
  browser?: boolean;
  env?: Record<string, string | undefined>;
  version?: string;
  versions?: { node?: string };
}

// Typed as a minimal stub, not Node's Process: we only ever WRITE these few
// fields, and claiming the full Process type made TypeScript demand stdout,
// argv and sixty-odd more that a page does not have.
const root = globalThis as unknown as {
  global?: unknown;
  process?: ProcessStub;
  Buffer?: unknown;
};

// Node libraries in the Railgun bundle read the bare identifier `global`
// (global.TextDecoder, global.crypto, global.process). A page does not have
// that binding, so module init throws "global is not defined" before the
// engine can start.
if (typeof root.global === 'undefined') root.global = root;

if (typeof root.process === 'undefined') {
  root.process = { browser: true, env: {} };
}
if (root.process.versions) root.process.versions.node = undefined;
root.process.browser = true;

root.Buffer = Buffer;
