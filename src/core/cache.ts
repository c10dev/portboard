// The TTL caches every collector uses (c10dev/portboard#4): one place for "reuse a result for N ms".
//
//   ttlCache()    one value: a result is reused for ttlMs, callers while it is being computed share the promise, and a
//                 rejected one is dropped (the next call computes again) unless cacheErrors. clear() forgets it.
//   keyedCache()  the same per key, at most maxEntries keys (expired ones go first, then the oldest), and an optional
//                 shorter life for some results (a miss, a failure) counted from when they resolved.
//   TtlMap        the plain store under keyedCache, for caches that hold values rather than promises (a result written
//                 after the work is done, a background prober): bounded the same way, expiry per entry.
//
// cachedValue() (?fresh windows) and gate() stay in throttle.ts; runShared() (subprocess output by command line) stays
// in exec.ts.

export interface TtlMapOptions {
  /** How long an entry is fresh by default */
  ttlMs: number;
  /** At most this many keys (default: unbounded); setting a new key when full drops expired ones, then the oldest */
  maxEntries?: number;
  now?(): number;
}

/** A bounded map whose entries are fresh for a while; stale entries stay readable with peek() until replaced or evicted. */
export class TtlMap<K, V> {
  private readonly map = new Map<K, { at: number; ttl: number; value: V }>();
  private readonly ttlMs: number;
  private readonly max: number;
  private readonly now: () => number;

  constructor(o: TtlMapOptions) {
    this.ttlMs = o.ttlMs;
    this.max = o.maxEntries ?? Infinity;
    this.now = o.now ?? Date.now;
  }

  private fresh(e: { at: number; ttl: number }, t = this.now()): boolean {
    return t - e.at < e.ttl;
  }

  /** The value while it is fresh, else undefined. `t`: the time to judge by (a caller with its own clock) */
  get(key: K, t = this.now()): V | undefined {
    const e = this.map.get(key);
    return e && this.fresh(e, t) ? e.value : undefined;
  }

  /** Is there a fresh value (which may itself be null or undefined)? */
  has(key: K, t = this.now()): boolean {
    const e = this.map.get(key);
    return !!e && this.fresh(e, t);
  }

  /** The value however old it is */
  peek(key: K): V | undefined {
    return this.map.get(key)?.value;
  }

  /** Store a value, fresh for ttlMs (default: the map's) from `t` (default now); it becomes the newest key. */
  set(key: K, value: V, ttlMs = this.ttlMs, t = this.now()): void {
    this.map.delete(key);
    if (this.map.size >= this.max) {
      for (const [k, e] of this.map) if (!this.fresh(e, t)) this.map.delete(k);
      for (const k of this.map.keys()) {
        if (this.map.size < this.max) break;
        this.map.delete(k);
      }
    }
    this.map.set(key, { at: t, ttl: ttlMs, value });
  }

  /** Restart an entry's life from now with another ttl (keyedCache's shortMs); no-op when the key is gone. */
  retime(key: K, value: V, ttlMs: number): void {
    const e = this.map.get(key);
    if (e && e.value === value) Object.assign(e, { at: this.now(), ttl: ttlMs });
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

export interface TtlCacheOptions {
  ttlMs: number;
  /** Keep a rejected promise for ttlMs like any result (default: drop it, so the next call tries again) */
  cacheErrors?: boolean;
  now?(): number;
}

export type TtlCache<T, A extends unknown[]> = ((...args: A) => Promise<T>) & {
  /** Forget the cached result: the next call computes */
  clear(): void;
};

/** One cached result. Arguments go to load when it runs and are ignored on a hit. */
export function ttlCache<T, A extends unknown[] = []>(load: (...args: A) => Promise<T>, o: TtlCacheOptions): TtlCache<T, A> {
  const now = o.now ?? Date.now;
  let hit: { at: number; value: Promise<T> } | null = null;
  const get = (...args: A): Promise<T> => {
    if (hit && now() - hit.at < o.ttlMs) return hit.value;
    const entry = { at: now(), value: load(...args) };
    hit = entry;
    if (!o.cacheErrors) {
      entry.value.catch(() => {
        if (hit === entry) hit = null;
      });
    }
    return entry.value;
  };
  return Object.assign(get, { clear: () => void (hit = null) });
}

export interface KeyedCacheOptions<T> {
  ttlMs: number;
  /** At most this many keys (default: unbounded) */
  maxEntries?: number;
  /** A different life for some results, counted from when they resolved (a miss is retried sooner); null: ttlMs */
  shortMs?(value: T): number | null | undefined;
  /** Keep a rejected promise for ttlMs like any result (default: drop it) */
  cacheErrors?: boolean;
  now?(): number;
}

export type KeyedCache<K, T, A extends unknown[]> = ((key: K, ...args: A) => Promise<T>) & {
  delete(key: K): void;
  clear(): void;
  readonly size: number;
};

/**
 * A result per key: reused for ttlMs, callers for a key being computed share it, a rejected one is dropped, and at
 * most maxEntries keys are kept so varying the key can't grow memory. Extra arguments go to load on a miss.
 */
export function keyedCache<K, T, A extends unknown[] = []>(load: (key: K, ...args: A) => Promise<T>, o: KeyedCacheOptions<T>): KeyedCache<K, T, A> {
  const map = new TtlMap<K, Promise<T>>(o);
  const get = (key: K, ...args: A): Promise<T> => {
    const hit = map.get(key);
    if (hit) return hit;
    const value = load(key, ...args);
    map.set(key, value);
    value.then(
      (v) => {
        const ms = o.shortMs?.(v);
        if (ms != null) map.retime(key, value, ms);
      },
      () => {
        if (!o.cacheErrors && map.peek(key) === value) map.delete(key);
      },
    );
    return value;
  };
  return Object.defineProperties(Object.assign(get, { delete: (key: K) => void map.delete(key), clear: () => map.clear() }), {
    size: { get: () => map.size },
  }) as KeyedCache<K, T, A>;
}
