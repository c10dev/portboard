// Best-effort HTTP probe: does the port speak HTTP, and what is its <title>?

export interface Probe {
  http: boolean;
  status: number | null;
  title: string | null;
}

// Ports where a plain HTTP GET is pointless or rude (ssh, dns, databases).
const SKIP = new Set([22, 53, 3306, 5432, 6379, 27017, 54322]);
/** A listener that answered HTTP is re-checked this often (status and <title> can change) */
export const HTTP_TTL = 60_000;
/** One that didn't is re-checked rarely: the same pid on the same port seldom starts speaking HTTP */
export const NON_HTTP_TTL = 10 * 60_000;
const TIMEOUT_MS = 1000;

interface Entry {
  at: number;
  value: Probe;
  refreshing: Promise<Probe> | null;
}
const cache = new Map<string, Entry>();

export type Fetcher = (url: string) => Promise<Probe>;

async function httpProbe(url: string): Promise<Probe> {
  try {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body = (await res.text()).slice(0, 64 * 1024);
    return { http: true, status: res.status, title: extractTitle(body) };
  } catch {
    return { http: false, status: null, title: null }; // not HTTP, or slow
  }
}

/**
 * Stale-while-revalidate: a listener seen before answers from cache at once, and an expired entry is refreshed in the
 * background; only a new listener (host, port, pid) waits for its first probe. A non-responding port used to cost every
 * fresh snapshot its full timeout once the cache expired (c10dev/portboard#24).
 */
export async function probe(host: string, port: number, pid: number | null, now = Date.now(), fetcher: Fetcher = httpProbe): Promise<Probe | null> {
  if (SKIP.has(port)) return null;
  const key = `${host}:${port}:${pid ?? ''}`;
  const hit = cache.get(key);
  const url = `http://${host.includes(':') ? `[${host}]` : host}:${port}/`;
  if (hit) {
    const ttl = hit.value.http ? HTTP_TTL : NON_HTTP_TTL;
    if (now - hit.at >= ttl && !hit.refreshing) {
      hit.refreshing = fetcher(url)
        .then((value) => {
          cache.set(key, { at: Date.now(), value, refreshing: null });
          return value;
        })
        .catch(() => {
          hit.refreshing = null;
          return hit.value;
        });
    }
    return hit.value;
  }
  const value = await fetcher(url);
  cache.set(key, { at: now, value, refreshing: null });
  return value;
}

/** Drop entries for listeners that are gone (called with the keys still present); keeps the cache from growing forever. */
export function pruneProbes(alive: Set<string>): number {
  let n = 0;
  for (const k of cache.keys()) if (!alive.has(k)) (cache.delete(k), n++);
  return n;
}

export function probeKey(host: string, port: number, pid: number | null): string {
  return `${host}:${port}:${pid ?? ''}`;
}

/** For tests */
export function resetProbes(): void {
  cache.clear();
}

export function extractTitle(html: string): string | null {
  const m = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
  const t = m?.[1].replace(/\s+/g, ' ').trim();
  return t ? decodeEntities(t) : null;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
