// The HTTP time limit of a hook. PORTBOARD_HOOK_TIMEOUT_MS (an integer from 1 to 10000) replaces the hook's own
// default. It is for tests and slow machines. Any other value is ignored.

export function hookTimeoutMs(fallback: number, env: Record<string, string | undefined> = process.env): number {
  const raw = env.PORTBOARD_HOOK_TIMEOUT_MS;
  if (raw === undefined || !/^[0-9]{1,5}$/.test(raw)) return fallback;
  const n = Number(raw);
  return n >= 1 && n <= 10000 ? n : fallback;
}
