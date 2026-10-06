/** A non-2xx HTTP response. */
export class HttpError extends Error {
  override readonly name = "HttpError";

  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
  ) {
    super(`HTTP ${status} from ${url}: ${body.slice(0, 300)}`);
  }

  /** Rate limits and server errors may succeed later; other 4xx (bad key, bad request) will not. */
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

export interface HttpClientOptions {
  /** Minimum time between the start of consecutive requests, to stay under rate limits. */
  minIntervalMs: number;
  /** Retries after the first attempt. Default 3. */
  retries?: number;
  /** Wait before the first retry; doubles on each later one. Default 2000. */
  backoffMs?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (message: string) => void;
}

export interface HttpClient {
  /** GETs `url` and parses JSON, throttling and retrying as configured. */
  getJson(url: string, headers: Record<string, string>): Promise<unknown>;
}

/**
 * Creates a JSON GET client that waits `minIntervalMs` between requests and retries network
 * errors, 429s and 5xx responses with exponential backoff (honouring Retry-After). Other
 * 4xx responses fail immediately, since retrying a bad key or request cannot help.
 */
export function createHttpClient(options: HttpClientOptions): HttpClient {
  const {
    minIntervalMs,
    retries = 3,
    backoffMs = 2000,
    fetch: doFetch = fetch,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    now = Date.now,
    log = () => {},
  } = options;
  let lastRequestAt = -Infinity;

  async function throttle(): Promise<void> {
    const wait = lastRequestAt + minIntervalMs - now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = now();
  }

  async function attempt(url: string, headers: Record<string, string>) {
    await throttle();
    const response = await doFetch(url, { headers });
    const text = await response.text();
    if (!response.ok) {
      return {
        error: new HttpError(response.status, url, text),
        retryAfter: response.headers.get("retry-after"),
      };
    }
    try {
      return { data: JSON.parse(text) as unknown };
    } catch {
      return {
        error: new Error(`invalid JSON from ${url}: ${text.slice(0, 200)}`),
        retryAfter: null,
      };
    }
  }

  return {
    async getJson(url, headers) {
      let lastError: unknown;
      for (let i = 0; i <= retries; i++) {
        let retryAfter: string | null = null;
        try {
          const result = await attempt(url, headers);
          if ("data" in result) return result.data;
          lastError = result.error;
          retryAfter = result.retryAfter;
          if (result.error instanceof HttpError && !result.error.retryable) throw result.error;
        } catch (err) {
          if (err instanceof HttpError && !err.retryable) throw err;
          lastError = err; // network failure
        }
        if (i === retries) break;
        const wait = Math.max(backoffMs * 2 ** i, retryAfterMs(retryAfter));
        log(`  retrying in ${Math.round(wait / 1000)}s (${describe(lastError)})`);
        await sleep(wait);
      }
      throw new Error(`gave up after ${retries + 1} attempts: ${describe(lastError)}`, {
        cause: lastError,
      });
    },
  };
}

/** Retry-After in seconds (the form rate limiters use), as milliseconds; 0 if absent. */
function retryAfterMs(header: string | null): number {
  const seconds = Number(header);
  return header !== null && Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
