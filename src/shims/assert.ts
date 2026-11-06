/**
 * Browser-safe stand-in for Node's `assert`.
 *
 * WHY THIS EXISTS. maci-crypto (a transitive dependency of the Privacy Pools
 * SDK) does `require("assert")` at MODULE level and calls it immediately —
 * constants.ts checks NOTHING_UP_MY_SLEEVE the moment it is imported. There is
 * no `assert` package installed and no Node builtin in a service worker, so
 * the bundler emitted a stub whose `.default` is not callable. The result:
 *
 *     Uncaught TypeError: (0 , i.default) is not a function
 *     Service worker registration failed. Status code: 15
 *
 * The throw happens during import, so nothing in the worker ran at all — the
 * extension loaded, the popup rendered, and every message sat unanswered.
 *
 * It must be callable as a FUNCTION (`assert(cond, msg)`) and also carry the
 * named methods, because callers use both forms. `export default` is what the
 * CJS interop reads as `.default`.
 */

export class AssertionError extends Error {
  constructor(message?: string) {
    super(message ?? 'Assertion failed');
    this.name = 'AssertionError';
  }
}

function assert(value: unknown, message?: string): asserts value {
  if (!value) throw new AssertionError(message);
}

/* Node's API surface, as far as anything in this dependency tree uses it.
   Deliberately strict: a silently-passing assert in cryptographic code is
   worse than a missing one, so each of these really checks. */

function ok(value: unknown, message?: string): asserts value {
  assert(value, message);
}

function equal(actual: unknown, expected: unknown, message?: string): void {
  // eslint-disable-next-line eqeqeq
  if (actual != expected) {
    throw new AssertionError(message ?? `${String(actual)} != ${String(expected)}`);
  }
}

function strictEqual(actual: unknown, expected: unknown, message?: string): void {
  if (actual !== expected) {
    throw new AssertionError(message ?? `${String(actual)} !== ${String(expected)}`);
  }
}

function notEqual(actual: unknown, expected: unknown, message?: string): void {
  // eslint-disable-next-line eqeqeq
  if (actual == expected) {
    throw new AssertionError(message ?? `${String(actual)} == ${String(expected)}`);
  }
}

function deepEqual(actual: unknown, expected: unknown, message?: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new AssertionError(message ?? 'deepEqual failed');
  }
}

function fail(message?: string): never {
  throw new AssertionError(message ?? 'Failed');
}

function throws(fn: () => unknown, message?: string): void {
  try {
    fn();
  } catch {
    return;
  }
  throw new AssertionError(message ?? 'Missing expected exception');
}

assert.AssertionError = AssertionError;
assert.ok = ok;
assert.equal = equal;
assert.strictEqual = strictEqual;
assert.notEqual = notEqual;
assert.deepEqual = deepEqual;
assert.deepStrictEqual = deepEqual;
assert.fail = fail;
assert.throws = throws;

export { ok, equal, strictEqual, notEqual, deepEqual, deepEqual as deepStrictEqual, fail, throws };
export default assert;
