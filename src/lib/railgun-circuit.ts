/**
 * The 1-nullifier, 2-commitment unshield circuit that the Arbitrum Railgun
 * proxy verifies.
 *
 * Wallet 10.4.0 asks for this circuit as `1x2` and downloads an older key
 * whose first IC point does not match the chain. The bytes shipped here are
 * the current `01x02` circuit, served under the path that SDK still requests.
 * A proof from the old key is included and then reverts: "Invalid Snark Proof."
 */

export const RAILGUN_CIRCUIT_IC0 =
  '12365314052568589532567527380474031360400521465618247615606044676178510699977';

/** SDK storage path → file name under `public/railgun/1x2/`. */
export const RAILGUN_CIRCUIT_FILES = {
  'artifacts-v2.1/1x2/vkey.json': 'vkey.json',
  'artifacts-v2.1/1x2/zkey': 'zkey',
  'artifacts-v2.1/1x2/wasm': 'wasm',
} as const;

export const RAILGUN_CIRCUIT_PUBLIC_DIR = 'railgun/1x2';
