/**
 * The unshield circuits the Arbitrum Railgun proxy verifies, shipped in the
 * extension.
 *
 * Wallet 10.4.0 asks for each circuit by its old name (`1x2`, `2x2`, `3x2`)
 * and, for any it cannot find, downloads an older key whose first IC point
 * does not match the chain. A proof from an old key is included and then
 * reverts: "RailgunSmartWallet: Invalid Snark Proof." The bytes shipped here
 * are the current circuits (IPFS QmUsmnK4…), served under the paths the SDK
 * requests.
 *
 * Which circuit a spend uses depends on how many notes it consumes. One note
 * covering the amount is `1x2`; two notes is `2x2`; three notes is `3x2`.
 * Measured: a 5 USDC unshield spent three notes, proved with the old `3x2`
 * key, and reverted (tx 0xe72b2832…, Arbitrum). A 10 USDC unshield from two
 * notes did the same with the old `2x2` key (tx 0x027e945e…).
 *
 * `ic0` is the verifier's IC[0].x read from the proxy (getVerificationKey).
 */

export interface RailgunCircuit {
  /** The SDK's name, and the directory under public/railgun/. */
  readonly id: '1x2' | '2x2' | '3x2';
  /** The current circuit's name on IPFS. */
  readonly ipfsName: '01x02' | '02x02' | '03x02';
  readonly ic0: string;
  /** SHA-256 of the decompressed files, pinned from keys that match the proxy. */
  readonly sha256: { readonly 'vkey.json': string; readonly zkey: string; readonly wasm: string };
}

export const RAILGUN_CIRCUITS: readonly RailgunCircuit[] = [
  {
    id: '1x2',
    ipfsName: '01x02',
    ic0: '12365314052568589532567527380474031360400521465618247615606044676178510699977',
    sha256: {
      'vkey.json': '9369fa6ad3d7a1becf4b10cf4bd6a7eb83725cfb5cf75a08b191c5bc2cd479f4',
      zkey: '8ef8e7abcfb5e60fb593d4d961657465f498435a0835adef05acc09534d7557b',
      wasm: '6ce87ddb4e33cff9564338a8b1f58047b22809e5d198f243c777d1aa4eaaa1e3',
    },
  },
  {
    id: '2x2',
    ipfsName: '02x02',
    ic0: '18344624712563468910486038225272031594506960733017418080627092907776866918001',
    sha256: {
      'vkey.json': '27ac4fc50fde0ca2dc62046f5f38715b6094676bcdbe4e2987875aba65cac620',
      zkey: '47c279ec3fcc8bdcc7a2fb80078e38ba8ca3a7bbaa608967c3c3af82f1d454e5',
      wasm: '8595023762a3067b70960be81e1a983c1630c9900d4caef3d608b9d849568829',
    },
  },
  {
    id: '3x2',
    ipfsName: '03x02',
    ic0: '15483731448806397148042980611251070385217877973365956952925943126266526421474',
    sha256: {
      'vkey.json': '7bad88c95fd760225e454750f51e82cbea46a6deae7f88fadd4cf9c13e7c1720',
      zkey: '9072c04e553fb2ec060362c533a590d1037e387017c8bb004da8e18c97676014',
      wasm: '0a2f0c62013e02a9ef3a7dc08d0f470bd45a812fea598f3f9ced7b0612b85445',
    },
  },
];

export const RAILGUN_CIRCUIT_FILE_NAMES = ['vkey.json', 'zkey', 'wasm'] as const;

/** SDK storage path → path of the bundled file inside the extension. */
export const RAILGUN_CIRCUIT_FILES: Readonly<Record<string, string>> = Object.fromEntries(
  RAILGUN_CIRCUITS.flatMap((circuit) =>
    RAILGUN_CIRCUIT_FILE_NAMES.map((name) => [`artifacts-v2.1/${circuit.id}/${name}`, `railgun/${circuit.id}/${name}`]),
  ),
);

const SPEND_ARTIFACT = /^artifacts-v2\.1\/(\d+x\d+)\/(?:vkey\.json|zkey|wasm|dat)$/;

/**
 * A spend circuit the SDK would download from its old IPFS hash. Null when the
 * path is bundled, or when it is not a spend circuit (POI still uses IndexedDB).
 */
export function unbundledSpendCircuit(path: string): string | null {
  const match = SPEND_ARTIFACT.exec(path);
  if (!match || path in RAILGUN_CIRCUIT_FILES) return null;
  return match[1] ?? null;
}
