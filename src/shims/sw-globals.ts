/**
 * Service-worker globals that libraries assume exist. Imported FIRST by the
 * background entrypoint, before anything that needs them.
 *
 * THE PROBLEM. ffjavascript (snarkjs's math layer, pulled in transitively by
 * the Privacy Pools SDK) precomputes a worker URL at MODULE level:
 *
 *     if (globalThis?.Blob) { url = URL.createObjectURL(blob) }
 *     else                  { url = "data:application/javascript;base64," + btoa(src) }
 *
 * That guard is wrong for a service worker. `Blob` exists there, but
 * `URL.createObjectURL` does NOT — it was removed from
 * ServiceWorkerGlobalScope. So the first branch is taken and throws during
 * import:
 *
 *     Uncaught TypeError: URL.createObjectURL is not a function
 *     Service worker registration failed. Status code: 15
 *
 * The whole worker then fails to register, which looks nothing like a crypto
 * problem: the extension loads, the popup renders, and every message sits
 * unanswered forever.
 *
 * THE FIX, and its limits. We only need module initialisation to survive —
 * the service worker never proves anything, because snarkjs runs in the
 * offscreen document where these APIs do exist. So the shim returns a URL
 * that is valid to compute but THROWS IF ACTUALLY USED, rather than a
 * plausible-looking one that would spawn a silently broken worker.
 *
 * If this ever fires, the fix is not to soften it: it means proving code has
 * reached the service worker, and that belongs in the offscreen document.
 */

const UNAVAILABLE = `data:application/javascript,${encodeURIComponent(
  'throw new Error("truly: a Worker was spawned from the service worker, where URL.createObjectURL does not exist. Proving must run in the offscreen document.");',
)}`;

function installCreateObjectURL(): boolean {
  const url = globalThis.URL as unknown as {
    createObjectURL?: (blob: unknown) => string;
    revokeObjectURL?: (url: string) => void;
  };

  // Defined only where it is MISSING, which is exactly the service worker.
  // The offscreen document and the popup have the real implementation and
  // must keep it — proving genuinely needs working object URLs there.
  if (typeof url.createObjectURL !== 'function') {
    url.createObjectURL = () => UNAVAILABLE;
  }
  if (typeof url.revokeObjectURL !== 'function') {
    url.revokeObjectURL = () => undefined;
  }
  return true;
}

/**
 * Exported and USED by the importer on purpose.
 *
 * A bare `import './sw-globals'` is tree-shaken away: nothing is exported,
 * nothing is referenced, and the bundler drops the module entirely — which is
 * exactly what happened the first time, leaving the worker still throwing
 * while the shim looked installed. A value the entrypoint reads cannot be
 * elided.
 */
export const swGlobalsInstalled: boolean = installCreateObjectURL();
