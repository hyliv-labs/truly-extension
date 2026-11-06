/**
 * Browser stand-in for Node's assert.
 *
 * Callers do `const assert = require("assert"); assert(value, message)`.
 * An ESM default export is wrapped as a module object, and that call then
 * throws "r is not a function" while the curve is built, before Railgun
 * starts. module.exports being the function is what the bundler unwraps.
 */
function assert(value, message) {
  if (!value) {
    const error = new Error(message || 'Assertion failed');
    error.name = 'AssertionError';
    throw error;
  }
}

function equal(actual, expected, message) {
  if (actual != expected) {
    throw Object.assign(new Error(message || `${String(actual)} != ${String(expected)}`), {
      name: 'AssertionError',
    });
  }
}

function strictEqual(actual, expected, message) {
  if (actual !== expected) {
    throw Object.assign(new Error(message || `${String(actual)} !== ${String(expected)}`), {
      name: 'AssertionError',
    });
  }
}

function notEqual(actual, expected, message) {
  if (actual == expected) {
    throw Object.assign(new Error(message || `${String(actual)} == ${String(expected)}`), {
      name: 'AssertionError',
    });
  }
}

function deepEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw Object.assign(new Error(message || 'deepEqual failed'), { name: 'AssertionError' });
  }
}

function fail(message) {
  throw Object.assign(new Error(message || 'Failed'), { name: 'AssertionError' });
}

function throws(fn, message) {
  try {
    fn();
  } catch {
    return;
  }
  throw Object.assign(new Error(message || 'Missing expected exception'), { name: 'AssertionError' });
}

assert.AssertionError = Error;
assert.ok = assert;
assert.equal = equal;
assert.strictEqual = strictEqual;
assert.notEqual = notEqual;
assert.deepEqual = deepEqual;
assert.deepStrictEqual = deepEqual;
assert.fail = fail;
assert.throws = throws;

module.exports = assert;
