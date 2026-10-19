// Load bounds for reads any tailnet device can trigger (docs/security-review/v1.0.md L1).
//
//   cachedValue()  one value computed by one call at a time: callers during a computation share it, a result is reused
//                  for ttlMs, and "fresh" (?fresh) skips that cache at most once per freshMinMs (otherwise it is served
//                  like any other call). invalidate() (after a write) always makes the next call compute again.
//   gate()         at most one forced run per minMs: answers whether a forced refresh may start now, is already running
//                  or was asked for too soon after the last one (the caller then answers with what it has, plus a note).

export interface CachedValue<T> {
  get(fresh?: boolean): Promise<T>;
  /** Drop the cached result: the next call computes, whatever the fresh window says */
  invalidate(): void;
}

/** compute(forced): forced is true when a fresh call skipped the cache (it may skip lower caches too) */
export function cachedValue<T>(compute: (forced: boolean) => Promise<T>, o: { ttlMs: number; freshMinMs: number; now?(): number }): CachedValue<T> {
  const now = o.now ?? Date.now;
  let cur: { at: number; value: Promise<T>; done: boolean } | null = null;
  let lastForced = -Infinity;

  function start(t: number, forced: boolean): Promise<T> {
    const entry = { at: t, value: compute(forced), done: false };
    cur = entry;
    entry.value.then(
      () => (entry.done = true),
      () => {
        entry.done = true;
        if (cur === entry) cur = null;
      },
    );
    return entry.value;
  }

  return {
    get(fresh = false) {
      const t = now();
      // one computation at a time, fresh or not
      if (cur && !cur.done) return cur.value;
      if (fresh && t - lastForced >= o.freshMinMs) {
        lastForced = t;
        return start(t, true);
      }
      if (cur && t - cur.at < o.ttlMs) return cur.value;
      return start(t, false);
    },
    invalidate() {
      cur = null;
    },
  };
}

export type GateState = 'started' | 'running' | 'throttled';

export interface Gate {
  /**
   * May a forced run start now? 'running' when one is in flight (the caller shares it), 'throttled' when the last
   * accepted one was less than minMs ago, else 'started' (and the window starts now).
   */
  ask(running: boolean): GateState;
  /** What a 'running' or 'throttled' answer tells the caller, next to the latest result */
  note(state: GateState, what: string): string | null;
}

export function gate(o: { minMs: number; now?(): number }): Gate {
  const now = o.now ?? Date.now;
  let last = -Infinity;
  const secs = (ms: number) => Math.max(1, Math.ceil(ms / 1000));
  return {
    ask(running) {
      if (running) return 'running';
      const t = now();
      if (t - last < o.minMs) return 'throttled';
      last = t;
      return 'started';
    },
    note(state, what) {
      if (state === 'running') return `${what} is already running; this is the latest result until it finishes`;
      if (state === 'throttled') {
        return `${what} was forced less than ${secs(o.minMs)} s ago; showing the latest result (the next forced one is accepted in ${secs(last + o.minMs - now())} s)`;
      }
      return null;
    },
  };
}

/**
 * A small per-key cache: a result is reused for ttlMs, callers for a key being computed share it, and at most `max`
 * keys are kept (the oldest goes first), so varying the key can't grow memory.
 */
export function keyedCache<K, T>(compute: (key: K) => Promise<T>, o: { ttlMs: number; max: number; now?(): number }): (key: K) => Promise<T> {
  const now = o.now ?? Date.now;
  const map = new Map<K, { at: number; value: Promise<T> }>();
  return (key) => {
    const t = now();
    const hit = map.get(key);
    if (hit && t - hit.at < o.ttlMs) return hit.value;
    map.delete(key);
    while (map.size >= o.max) map.delete(map.keys().next().value as K);
    const entry = { at: t, value: compute(key) };
    map.set(key, entry);
    entry.value.catch(() => {
      if (map.get(key) === entry) map.delete(key);
    });
    return entry.value;
  };
}
