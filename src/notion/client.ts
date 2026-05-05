import { Client, APIResponseError, RequestTimeoutError } from '@notionhq/client';

export interface NotionClientOptions {
  token: string;
  notionVersion?: string;
}

// Wrap the SDK so every request gets a longer timeout and automatic
// retry on transient failures (timeouts, 5xx, 429). The default
// timeout is 60s; bumped to 120s because the deep canonical-DB scan
// can chain enough requests on a slow Notion that any one of them
// blows past 60s. Retry uses exponential backoff capped at 30s.
export function createNotionClient(opts: NotionClientOptions): Client {
  const client = new Client({
    auth: opts.token,
    notionVersion: opts.notionVersion ?? '2025-09-03',
    timeoutMs: 120_000,
  });

  // Patch every HTTP-issuing method to retry transient failures. We
  // wrap both the raw `request` (used by database.ts) and the typed
  // accessors that walker / resolver call (pages.retrieve,
  // blocks.children.list, search). Wrapping `request` alone isn't
  // enough — the typed methods may be bound to the SDK's internal
  // implementation rather than going through `this.request`.
  const origRequest = client.request.bind(client) as (args: unknown) => Promise<unknown>;
  (client as unknown as { request: typeof origRequest }).request = (args: unknown) =>
    withRetry(() => origRequest(args));

  const origPagesRetrieve = client.pages.retrieve.bind(client.pages);
  client.pages.retrieve = ((args: Parameters<typeof origPagesRetrieve>[0]) =>
    withRetry(() => origPagesRetrieve(args))) as typeof client.pages.retrieve;

  const origBlocksList = client.blocks.children.list.bind(client.blocks.children);
  client.blocks.children.list = ((args: Parameters<typeof origBlocksList>[0]) =>
    withRetry(() => origBlocksList(args))) as typeof client.blocks.children.list;

  const origSearch = client.search.bind(client);
  client.search = ((args: Parameters<typeof origSearch>[0]) =>
    withRetry(() => origSearch(args))) as typeof client.search;

  return client;
}

const TRANSIENT_HTTP_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 4;
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (!isTransient(err) || attempt === MAX_ATTEMPTS) throw err;
      lastErr = err;
      const delay = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (attempt - 1));
      const jitter = Math.floor(Math.random() * 250);
      await sleep(delay + jitter);
    }
  }
  throw lastErr;
}

function isTransient(err: unknown): boolean {
  if (err instanceof RequestTimeoutError) return true;
  if (err instanceof APIResponseError) {
    if (TRANSIENT_HTTP_STATUSES.has(err.status)) return true;
    if (err.code === 'rate_limited') return true;
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function normalizeId(id: string): string {
  return id.replace(/-/g, '').toLowerCase();
}

export function pageIdEquals(a: string, b: string): boolean {
  return normalizeId(a) === normalizeId(b);
}
