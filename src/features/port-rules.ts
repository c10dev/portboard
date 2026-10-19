// Port rules (src/core/portrules.ts): labels, pins, hiding and new-port notices (onNew) for many ports at once, by
// range, host:port or command-line regex, with otherPorts as the default. Exact per-port entries (a rename in the UI)
// always win. Local only: nothing here is offered on the remote server.
//
//   GET  /api/port-rules   {rules, exact, problems, onNew}   rules in precedence order (docs/config.md#port-rules)
//   POST /api/port-rules   {key, rule: {label?, pinned?, hidden?, onNew?} | null}   (X-Portboard; null removes it,
//                          a field set to null clears it; a single-port key writes the port's own entry)
//   MCP  list_port_rules, set_port_rule
//   ui   features/port-rules.js: the 설정 tab's 포트 규칙 section

import { checkRule, loadPrefs, OTHER_PORTS, parseRuleKey, removePortRule, ruleProblems, setPortPrefs, setPortRule, ON_NEW, type OnNew, type PortRule } from '../core/prefs.ts';
import { exactRows, ruleRows, type RuleRow } from '../core/portrules.ts';
import { text } from '../mcp/kit.ts';
import { ok, reply } from './router.ts';
import type { FeatureModule } from './types.ts';

export interface PortRulesView {
  /** portRules then otherPorts, in the order they are consulted */
  rules: RuleRow[];
  /** Ports with their own label or onNew (they win over every rule) */
  exact: { port: number; label: string | null; onNew: OnNew | null }[];
  /** Keys or rules in prefs.json that were ignored, and why */
  problems: string[];
  onNew: readonly OnNew[];
}

export interface SetRuleResult {
  ok: boolean;
  key: string;
  where?: 'ports' | 'portRules' | 'otherPorts';
  rule?: PortRule | null;
  removed?: boolean;
  error?: string;
}

declare module '../mcp/kit.ts' {
  interface Core {
    /** Port rules in precedence order, the exact per-port entries, and problems in prefs.json */
    portRules?(): Promise<PortRulesView>;
    /** Set or (rule null) remove a rule; a single-port key writes that port's own entry */
    setPortRule?(key: string, rule: Record<string, unknown> | null): Promise<SetRuleResult>;
  }
}

export async function portRulesView(): Promise<PortRulesView> {
  const [prefs, problems] = await Promise.all([loadPrefs(), ruleProblems()]);
  return { rules: ruleRows(prefs), exact: exactRows(prefs), problems, onNew: ON_NEW };
}

/** Checks the key and rule, then writes; errors come back as {ok: false, error} */
export async function applyRule(key: unknown, rule: unknown): Promise<SetRuleResult> {
  if (typeof key !== 'string' || !key.trim()) return { ok: false, key: String(key ?? ''), error: 'key must be a non-empty string' };
  const k = key.trim();
  const parsed = k === OTHER_PORTS ? null : parseRuleKey(k);
  if (typeof parsed === 'string') return { ok: false, key: k, error: parsed };
  if (rule === null) {
    if (parsed?.kind === 'port') {
      await setPortPrefs(parsed.port, { label: null, onNew: null });
      return { ok: true, key: String(parsed.port), where: 'ports', removed: true };
    }
    return { ok: true, key: k, removed: await removePortRule(k), where: k === OTHER_PORTS ? 'otherPorts' : 'portRules' };
  }
  const bad = checkRule(rule);
  if (bad) return { ok: false, key: k, error: bad };
  try {
    return { ok: true, ...(await setPortRule(k, rule as Record<string, unknown>)) };
  } catch (err) {
    return { ok: false, key: k, error: (err as Error).message };
  }
}

const RULE_FIELDS = {
  label: { type: ['string', 'null'], maxLength: 80, description: 'Display name for every matching port (null clears it)' },
  pinned: { type: ['boolean', 'null'], description: 'Pin matching ports to the top (null clears it)' },
  hidden: { type: ['boolean', 'null'], description: 'Hide matching ports from the default view (null clears it)' },
  onNew: {
    type: ['string', 'null'],
    enum: [...ON_NEW, null],
    description:
      'When a matching port starts listening: notify (dashboard toast + push through the alert channel), ' +
      'openBrowserOnce (dashboard toast with an Open button only), silent, ignore (no notice, and hidden). null clears it',
  },
};

export const portRulesFeature: FeatureModule = {
  name: 'port-rules',
  order: 2300,
  routes: [
    { method: 'GET', path: '/api/port-rules', handler: async () => ok(await portRulesView()) },
    {
      method: 'POST',
      path: '/api/port-rules',
      write: true,
      body: { limit: 4096 },
      async handler({ body }, ctx) {
        if (!body || typeof body !== 'object' || Array.isArray(body)) return reply(400, { error: 'body must be an object' });
        if (!('rule' in body)) return reply(400, { error: 'rule is required (an object, or null to remove)' });
        const r = await applyRule(body.key, body.rule);
        if (!r.ok) return reply(400, r);
        ctx.invalidate('snapshot');
        return ok({ ...r, view: await portRulesView() });
      },
    },
  ],
  tools: [
    {
      def: {
        name: 'list_port_rules',
        title: 'List port rules',
        description:
          'Port rules: labels, pins, hiding and new-port notices (onNew) set for many ports at once. Keys are a port ' +
          'range ("3000-3010"), host:port ("localhost:5173", matched against the bind address) or a regex on the ' +
          "owning process's command line (\"vite|next dev\"); otherPorts applies to ports no rule matches. Rules are " +
          "listed in the order they are consulted; each field comes from the first that sets it, and a port's own " +
          'entry (exact, e.g. a rename in the dashboard) always wins. list_ports shows the result per port.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async call(_args, core) {
        if (!core.portRules) return text('list_port_rules is not available here', true);
        return text(await core.portRules());
      },
    },
    {
      def: {
        name: 'set_port_rule',
        title: 'Set a port rule',
        description:
          'Add, change or remove a port rule (see list_port_rules). key: "3000-3010", "localhost:5173", a command-line ' +
          'regex such as "vite|next dev", or "otherPorts" for the default. A single port ("5173") sets that port\'s own ' +
          'entry, like a rename in the dashboard. Fields left out keep their value, null clears one, remove=true deletes ' +
          'the whole rule. Example: label every scratchpad preview with {"key": "18891-18899", "label": "Scratchpad preview"}.',
        inputSchema: {
          type: 'object',
          properties: { key: { type: 'string', maxLength: 200, description: 'Rule key' }, ...RULE_FIELDS, remove: { type: 'boolean', description: 'Delete the rule' } },
          required: ['key'],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async call(args, core) {
        const a = (args ?? {}) as Record<string, unknown>;
        if (!core.setPortRule) return text('set_port_rule is not available here', true);
        const unknown = Object.keys(a).find((k) => !['key', 'remove', 'label', 'pinned', 'hidden', 'onNew'].includes(k));
        if (unknown) return text(`unknown argument: ${unknown}`, true);
        if (a.remove !== undefined && typeof a.remove !== 'boolean') return text('remove must be a boolean', true);
        const rule: Record<string, unknown> = {};
        for (const f of ['label', 'pinned', 'hidden', 'onNew']) if (f in a) rule[f] = a[f];
        if (!a.remove && !Object.keys(rule).length) return text('nothing to set: give label, pinned, hidden or onNew, or remove=true', true);
        const r = await core.setPortRule(String(a.key ?? ''), a.remove ? null : rule);
        return text(r, !r.ok);
      },
    },
  ],
  mcpCore: () => ({ portRules: portRulesView, setPortRule: applyRule }),
  ui: [{ pages: ['#settings'], script: 'features/port-rules.js' }],
};
