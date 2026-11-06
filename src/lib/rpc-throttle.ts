/**
 * A fetch that keeps the Railgun engine under public RPC rate limits.
 *
 * WHY. Measured from an empty database: the first Railgun sync downloads
 * history from the indexer, then (at ~67%) runs slowSyncV2, an RPC log scan
 * that validates merkle roots against the contract. In that phase the engine
 * fires hundreds of calls at once. Both public endpoints we use rejected the
 * burst -- tenderly with 429 "rate limit exceeded", arb1 with 200 failures in
 * a few seconds -- ethers gave up after its own retries, and the sync sat at
 * 67% indefinitely. A failed root validation also stops the engine saving
 * progress, so it rescans from the last valid point: rate limiting becomes a
 * loop, not a delay.
 *
 * Changing provider does not fix a burst. Capping how many calls are in
 * flight at once does, and retrying a 429 with backoff covers the rest.
 *
 * WHERE. In the browser, ethers (which the Railgun engine uses) sends every
 * request through globalThis.fetch, so wrapping fetch in the offscreen
 * document covers the engine regardless of which copy of ethers it bundled.
 * Only requests to the configured RPC hosts are throttled; everything else
 * passes straight through.
 */

export interface ThrottleOptions {
  /** Hosts whose requests are throttled, e.g. "arb1.arbitrum.io". */
  readonly hosts: readonly string[];
  /** Requests in flight at once, across all throttled hosts. */
  readonly concurrency: number;
  /** Retries for a rate-limited response before giving up. */
  readonly maxRetries: number;
  /** First backoff; doubles each retry, capped at maxDelayMs. */
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** For tests: called on each rate-limited response that will be retried. */
  readonly onRateLimited?: (url: string, attempt: number) => void;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

/** 429, or a JSON-RPC rate-limit error inside a 200 (tenderly does this). */
async function isRateLimited(response: Response): Promise<boolean> {
  if (response.status === 429) return true;
  if (response.status !== 200) return false;
  try {
    const text = await response.clone().text();
    return /"code"\s*:\s*-32005|rate limit|too many requests/i.test(text.slice(0, 2_000));
  } catch {
    return false;
  }
}

export function createThrottledFetch(
  base: typeof fetch,
  options: ThrottleOptions,
): typeof fetch {
  const hosts = new Set(options.hosts.map((h) => h.toLowerCase()));
  let active = 0;
  const waiting: Array<() => void> = [];

  const acquire = async () => {
    if (active < options.concurrency) {
      active += 1;
      return;
    }
    await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
  };
  const release = () => {
    active -= 1;
    waiting.shift()?.();
  };

  const throttled = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let host = '';
    try {
      host = new URL(urlOf(input)).host.toLowerCase();
    } catch {
      return base(input, init);
    }
    if (!hosts.has(host)) return base(input, init);

    // A Request body can be read only once; keep the init/body so retries can
    // resend it. ethers passes (url, init) with a string or byte body.
    for (let attempt = 0; ; attempt += 1) {
      await acquire();
      let response: Response;
      try {
        response = await base(input, init);
      } finally {
        release();
      }
      if (attempt >= options.maxRetries || !(await isRateLimited(response))) return response;

      options.onRateLimited?.(urlOf(input), attempt + 1);
      const retryAfter = Number(response.headers.get('retry-after'));
      const backoff = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** attempt);
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1_000 : backoff;
      // Jitter, so a queue of retries does not stampede back in lockstep.
      await sleep(wait * (0.75 + Math.random() * 0.5));
    }
  };
  return throttled as typeof fetch;
}

let installed = false;

/** Wrap globalThis.fetch once. Idempotent. */
export function installRpcThrottle(options: ThrottleOptions): void {
  if (installed) return;
  installed = true;
  globalThis.fetch = createThrottledFetch(globalThis.fetch.bind(globalThis), options);
}
