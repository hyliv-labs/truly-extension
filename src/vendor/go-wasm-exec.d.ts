/** Go's js/wasm runtime (wasm_exec.js), vendored unmodified apart from the export. */
export declare const GoRuntime: new () => {
  importObject: WebAssembly.Imports;
  run(instance: WebAssembly.Instance): Promise<void>;
};
