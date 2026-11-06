/** The engine package ships without types. Only the hooks Truly uses are declared. */
declare module '@railgun-community/engine' {
  export class POI {
    static getSpendableBalanceBuckets: (chain: unknown) => Promise<readonly string[]>;
  }

  export class RailgunEngine {
    scanTXIDHistoryV2: (chain: unknown) => Promise<void>;
    prover: {
      setSnarkJSGroth16: (groth16: unknown) => void;
    };
    /** isScanning is true from the start of a tree scan until its decrypt ends. */
    getUTXOMerkletree(txidVersion: string, chain: unknown): { isScanning: boolean };
  }
}

declare module 'snarkjs' {
  export const groth16: unknown;
}
