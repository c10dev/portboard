// Port rules (c10dev/portboard REA proposal #1, after VS Code's `remote.portsAttributes`): a label, a pin, hiding and
// what to do when the port starts listening (onNew, src/core/newports.ts), set for many ports at once.
//
//   prefs.json  "portRules": { "18891-18899": {"label": "스크래치패드 미리보기"},
//                              "localhost:5173": {"pinned": true},
//                              "vite|next dev": {"label": "개발 서버", "onNew": "notify"} },
//               "otherPorts": { "onNew": "silent" }
//
// Each field is taken from the first source that sets it, in this order (docs/config.md#port-rules):
//   1. the port's own entry in prefs.json `ports` (a rename, pin or hide in the UI writes there), always first
//   2. a single-port key in portRules ("3000")
//   3. host:port keys ("localhost:5173", "127.0.0.1:5173", "*:3000"), matched against the port's bind addresses
//   4. ranges ("3000-3010"), the narrowest first, then the lowest start
//   5. command-line regexes (case-insensitive, on each owning process's command line and the container name), in
//      the order they are in the file
//   6. otherPorts, only when no key in portRules matched the port
//   7. the defaults: no label, not pinned, not hidden; onNew `notify` for a well-known dev server (vite, next dev,
//      astro, npm/pnpm/yarn/bun run dev) on an app port from 1024 up, `silent` for everything else
// onNew `ignore` also hides the port unless something sets `hidden` itself.
//
// Pure: the snapshot (src/core/index.ts) passes what it knows about the port.

import { ON_NEW, parseRuleKey, type OnNew, type ParsedKey, type PortPrefs, type PortRule, type Prefs } from './prefs.ts';

export type RuleField = 'label' | 'pinned' | 'hidden' | 'onNew';

/** Where a field's value came from: `port` (the exact entry), `rule:<key>`, `otherPorts` or `default` */
export type RuleSource = string;

/** What the matcher needs to know about a port */
export interface RuleTarget {
  port: number;
  addresses: string[];
  /** Command lines of the owning processes, and `docker: <name>` for a container */
  commands: string[];
  kind: 'app' | 'ephemeral' | 'system';
}

export interface ResolvedPrefs {
  label: string | null;
  pinned: boolean;
  hidden: boolean;
  alert: boolean;
  onNew: OnNew;
  /** The portRules keys that match this port, in precedence order (otherPorts last when it applied) */
  matched: string[];
  /** Where each field came from; fields left at the default are `default` */
  from: Record<RuleField, RuleSource>;
}

export interface CompiledRule {
  key: string;
  parsed: ParsedKey;
  rule: PortRule;
}

/** Rule keys in precedence order (exact port, host:port, range by width, regex in file order). Bad keys are skipped. */
export function compileRules(rules: Record<string, PortRule> | undefined): CompiledRule[] {
  const out: CompiledRule[] = [];
  for (const [key, rule] of Object.entries(rules ?? {})) {
    const parsed = parseRuleKey(key);
    if (typeof parsed !== 'string') out.push({ key, parsed, rule });
  }
  const rank = { port: 0, host: 1, range: 2, command: 3 } as const;
  // Array.prototype.sort is stable: regexes keep their file order
  return out.sort((a, b) => {
    const r = rank[a.parsed.kind] - rank[b.parsed.kind];
    if (r || a.parsed.kind !== 'range' || b.parsed.kind !== 'range') return r;
    return a.parsed.to - a.parsed.from - (b.parsed.to - b.parsed.from) || a.parsed.from - b.parsed.from;
  });
}

const LOOPBACK = (a: string) => a.startsWith('127.') || a === '::1';
const ANY = new Set(['*', '0.0.0.0', '::']);

/** host:port's host against the port's bind addresses: `localhost` is any loopback address, `*` / `0.0.0.0` / `::` all interfaces. */
export function hostMatches(host: string, addresses: string[]): boolean {
  if (host === 'localhost') return addresses.some(LOOPBACK);
  if (ANY.has(host)) return addresses.some((a) => ANY.has(a));
  return addresses.some((a) => a.toLowerCase() === host);
}

export function ruleMatches(r: CompiledRule, t: RuleTarget): boolean {
  const k = r.parsed;
  switch (k.kind) {
    case 'port':
      return k.port === t.port;
    case 'range':
      return t.port >= k.from && t.port <= k.to;
    case 'host':
      return k.port === t.port && hostMatches(k.host, t.addresses);
    case 'command':
      return t.commands.some((c) => k.re.test(c));
  }
}

/** One word of a process's command line that names a dev server binary (node_modules/.bin/vite, astro, …) */
const DEV_BIN = /^(?:.*\/)?(?:vite|astro|nuxt|nuxi)$/;
const RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);

/** vite, next dev (next-server), astro, nuxt, `npm|pnpm|yarn|bun [run] dev`: what a Claude session starts to preview */
export function isDevServerCommand(cmd: string): boolean {
  const words = cmd.trim().split(/\s+/);
  if (/^next-server\b/.test(cmd.trim())) return true;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (DEV_BIN.test(w)) return true;
    if (/^(?:.*\/)?next$/.test(w) && words[i + 1] === 'dev') return true;
    const runner = w.replace(/^.*\//, '');
    if (RUNNERS.has(runner)) {
      const rest = words.slice(i + 1).filter((x) => !x.startsWith('-'));
      if (rest[0] === 'dev' || (rest[0] === 'run' && rest[1] === 'dev')) return true;
    }
  }
  return false;
}

/** onNew when nothing sets it: notify for a known dev server on an app port (not system, not an ephemeral helper) */
export function defaultOnNew(t: RuleTarget): OnNew {
  return t.kind === 'app' && t.port >= 1024 && t.commands.some(isDevServerCommand) ? 'notify' : 'silent';
}

/** The port's label, pin, hide, alert and onNew with the rules applied, and where each came from. */
export function resolvePrefs(exact: PortPrefs | undefined, compiled: CompiledRule[], other: PortRule | undefined, t: RuleTarget): ResolvedPrefs {
  const from: Partial<Record<RuleField, RuleSource>> = {};
  const value: { label?: string; pinned?: boolean; hidden?: boolean; onNew?: OnNew } = {};
  const fill = (src: Partial<PortRule> | undefined, source: RuleSource) => {
    if (!src) return;
    if (value.label === undefined && typeof src.label === 'string' && src.label) {
      value.label = src.label;
      from.label = source;
    }
    for (const f of ['pinned', 'hidden'] as const) {
      if (value[f] === undefined && typeof src[f] === 'boolean') {
        value[f] = src[f];
        from[f] = source;
      }
    }
    if (value.onNew === undefined && ON_NEW.includes(src.onNew as OnNew)) {
      value.onNew = src.onNew;
      from.onNew = source;
    }
  };

  fill(exact, 'port');
  const matched = compiled.filter((r) => ruleMatches(r, t));
  for (const r of matched) fill(r.rule, `rule:${r.key}`);
  const keys = matched.map((r) => r.key);
  if (!matched.length && other) {
    fill(other, 'otherPorts');
    keys.push('otherPorts');
  }
  const onNew = value.onNew ?? defaultOnNew(t);
  if (value.hidden === undefined && onNew === 'ignore') {
    value.hidden = true;
    from.hidden = from.onNew ?? 'default';
  }
  return {
    label: value.label ?? null,
    pinned: value.pinned ?? false,
    hidden: value.hidden ?? false,
    alert: !!exact?.alert,
    onNew,
    matched: keys,
    from: { label: from.label ?? 'default', pinned: from.pinned ?? 'default', hidden: from.hidden ?? 'default', onNew: from.onNew ?? 'default' },
  };
}

/** A resolver over one prefs read: compile the rules once per snapshot, then resolve every port. */
export function ruleResolver(prefs: Pick<Prefs, 'ports' | 'portRules' | 'otherPorts'>) {
  const compiled = compileRules(prefs.portRules);
  return (t: RuleTarget): ResolvedPrefs => resolvePrefs(prefs.ports[t.port], compiled, prefs.otherPorts, t);
}

export interface RuleRow {
  key: string;
  kind: ParsedKey['kind'] | 'otherPorts';
  /** Order it is consulted in (0 first); exact `ports` entries come before all of them */
  rank: number;
  rule: PortRule;
}

/** portRules and otherPorts in precedence order, for list_port_rules, GET /api/port-rules and the 설정 editor */
export function ruleRows(prefs: Pick<Prefs, 'portRules' | 'otherPorts'>): RuleRow[] {
  const rows: RuleRow[] = compileRules(prefs.portRules).map((r, i) => ({ key: r.key, kind: r.parsed.kind, rank: i, rule: r.rule }));
  if (prefs.otherPorts) rows.push({ key: 'otherPorts', kind: 'otherPorts', rank: rows.length, rule: prefs.otherPorts });
  return rows;
}

/** Exact entries in `ports` that set a label or onNew (the per-port side of the rules) */
export function exactRows(prefs: Pick<Prefs, 'ports'>): { port: number; label: string | null; onNew: OnNew | null }[] {
  return Object.entries(prefs.ports)
    .map(([p, v]) => ({ port: Number(p), label: typeof v?.label === 'string' ? v.label : null, onNew: ON_NEW.includes(v?.onNew as OnNew) ? (v.onNew as OnNew) : null }))
    .filter((r) => r.label || r.onNew)
    .sort((a, b) => a.port - b.port);
}
