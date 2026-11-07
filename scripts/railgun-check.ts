/**
 * Railgun spend rules. No network, no proof, no USDC.
 *
 * A balance the engine left pending is not planned. A fresh shield is
 * spendable once it is in the tree: self-broadcast does not wait for PPOI.
 */

import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RAILGUN_CIRCUITS, RAILGUN_CIRCUIT_FILES, unbundledSpendCircuit } from '../src/lib/railgun-circuit.ts';
import {
  RAILGUN_PROXY_ARBITRUM,
  RailgunFundingError,
  SELF_BROADCAST_SPEND_BUCKETS,
  planRailgunUnshield,
  railgunGrossForNet,
  railgunShieldAfterGasReserve,
} from '../src/lib/railgun.ts';

let failed = false;
const fail = (message: string) => {
  console.error('FAIL', message);
  failed = true;
};
const pass = (message: string) => console.log('pass', message);

const USDC = (n: number) => BigInt(n) * 1_000_000n;

if (RAILGUN_PROXY_ARBITRUM.toLowerCase() !== '0xfa7093cdd9ee6932b4eb2c9e1cde7ce00b1fa4b9') {
  fail('Arbitrum proxy is not the published Railgun address');
} else pass('Arbitrum proxy matches the published Railgun address');

try {
  planRailgunUnshield({
    spendableUnits: USDC(30),
    pendingUnits: USDC(100),
    desiredNetUnits: USDC(20),
    feeUnits: USDC(1),
  });
  pass('a fresh 30 USDC shield funds a 20 USDC trade with no age check');
} catch (error) {
  fail(`fresh shield was refused: ${(error as Error).message}`);
}

try {
  planRailgunUnshield({
    spendableUnits: 0n,
    pendingUnits: USDC(100),
    desiredNetUnits: USDC(20),
    feeUnits: USDC(1),
  });
  fail('an unscanned shield was planned onto a new address');
} catch (error) {
  if (error instanceof RailgunFundingError && error.code === 'pending-ppoi') {
    pass('a balance the engine has not marked spendable cannot fund a Lighter address');
  } else fail(`pending shield threw ${(error as Error).message}`);
}

try {
  planRailgunUnshield({
    spendableUnits: USDC(4),
    pendingUnits: 0n,
    desiredNetUnits: USDC(10),
    feeUnits: 0n,
  });
  fail('an insufficient ready balance was accepted');
} catch (error) {
  if (error instanceof RailgunFundingError && error.code === 'insufficient') {
    pass('a ready balance under the trade size is refused');
  } else fail(`small balance threw ${(error as Error).message}`);
}

const buckets = new Set<string>(SELF_BROADCAST_SPEND_BUCKETS);
if (!buckets.has('ShieldPending') || !buckets.has('MissingExternalPOI')) {
  fail('a tree-synced shield without a PPOI proof is not spendable');
} else if (buckets.has('ShieldBlocked') || buckets.has('Spent')) {
  fail('a blocked or spent note is in the self-broadcast set');
} else pass('self-broadcast spends a fresh shield and skips PPOI');

try {
  const shielded = railgunShieldAfterGasReserve(USDC(10), USDC(1));
  if (shielded !== USDC(9)) fail(`reserved shield amount was ${shielded}`);
  else pass('the return shield keeps 1 USDC back for the paymaster');
} catch (error) {
  fail(`gas reserve threw ${(error as Error).message}`);
}

try {
  railgunShieldAfterGasReserve(USDC(1), USDC(1));
  fail('a balance that only covers the gas reserve was shielded');
} catch (error) {
  if (error instanceof RailgunFundingError && error.code === 'insufficient') {
    pass('a balance that cannot pay the paymaster is not shielded');
  } else fail(`tight return threw ${(error as Error).message}`);
}

const gross = railgunGrossForNet(USDC(20), 25n);
const netAfterFee = gross - (gross * 25n) / 10_000n;
if (netAfterFee < USDC(20)) fail(`gross ${gross} does not cover a 25 bps fee on 20 USDC`);
else pass('the unshield amount is grossed up by the Railgun fee');

const require = createRequire(import.meta.url);
const wallet = require('@railgun-community/wallet') as Record<string, unknown>;
const engineFns = ['startRailgunEngine', 'generateUnshieldProof', 'populateProvedUnshield', 'populateShield', 'gasEstimateForUnprovenUnshield'];
const missing = engineFns.filter((name) => typeof wallet[name] !== 'function');
if (missing.length > 0) fail(`Railgun SDK is missing ${missing.join(', ')}`);
else pass('the Railgun wallet SDK exports the real proof and shield calls');

// A circuit that is not bundled is refused. Letting the SDK download it pulls
// an old key, and that proof reverts on chain: "Invalid Snark Proof"
// (measured with 2x2, and again with 3x2 on tx 0xe72b2832…).
const circuitRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'railgun');
for (const circuit of RAILGUN_CIRCUITS) {
  const vkeyPath = join(circuitRoot, circuit.id, 'vkey.json');
  try {
    const vkey = JSON.parse(readFileSync(vkeyPath, 'utf8')) as { IC?: string[][] };
    if (vkey.IC?.[0]?.[0] !== circuit.ic0) {
      fail(`the bundled Railgun ${circuit.id} vkey does not match the Arbitrum proxy`);
    } else pass(`the bundled Railgun ${circuit.id} vkey matches the Arbitrum proxy`);
  } catch {
    fail(`the Railgun ${circuit.id} proving key is missing. Run: tsx scripts/fetch-railgun-circuit.ts`);
  }
  for (const name of ['vkey.json', 'zkey', 'wasm'] as const) {
    if (!existsSync(join(circuitRoot, circuit.id, name))) {
      fail(`the Railgun ${circuit.id} ${name} is missing. Run: tsx scripts/fetch-railgun-circuit.ts`);
    }
    if (RAILGUN_CIRCUIT_FILES[`artifacts-v2.1/${circuit.id}/${name}`] !== `railgun/${circuit.id}/${name}`) {
      fail(`the SDK path for ${circuit.id}/${name} is not served from the bundle`);
    }
  }
}
if (!['1x2', '2x2', '3x2'].every((id) => RAILGUN_CIRCUITS.some((circuit) => circuit.id === id))) {
  fail('one-note, two-note, or three-note spends would fall back to the old key');
} else pass('one-note, two-note, and three-note spends are served from the current keys');
if (unbundledSpendCircuit('artifacts-v2.1/3x2/zkey') !== null) fail('the three-note key is treated as missing');
else pass('the three-note key is served from the bundle');
if (unbundledSpendCircuit('artifacts-v2.1/4x2/zkey') !== '4x2') fail('a four-note spend would download the old key');
else pass('a four-note spend is refused instead of downloading the old key');

console.log(failed ? '\nFAILED' : '\nrailgun spend rules OK');
process.exit(failed ? 1 : 0);
