// 메모리 (src/core/memory.ts): what a process is from its argv (a Claude Code CLI, an MCP server, anything else).

import { t } from '../i18n.ts';

export type Kind = { kind: 'cli'; version: string | null } | { kind: 'mcp'; name: string } | { kind: 'proc' };

/** Display names for the MCP servers Portboard knows; others show their package name */
export const MCP_LABELS: Record<string, string> = {
  rea: 'rea',
  playwright: '@playwright/mcp',
  get portboard() {
    return t('memoryMsg.mcp.portboard');
  },
};

const base = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/**
 * What a process is, from its argv: a Claude Code CLI (the desktop app's ~/.claude/remote/ccd-cli/<version>, or a
 * `claude` binary), an MCP server (by command), or anything else. `generic` also accepts other *mcp* packages; only
 * used inside a CLI's tree, where a stdio server lives.
 */
export function classify(argv: string[], generic = false): Kind {
  const a0 = argv[0] ?? '';
  const ccd = /\/\.claude\/remote\/ccd-cli\/(\d+\.\d+\.\d+)[^/]*$/.exec(a0);
  if (ccd) return { kind: 'cli', version: ccd[1] };
  if (base(a0) === 'claude') return { kind: 'cli', version: /\/versions\/(\d+\.\d+\.\d+)/.exec(a0)?.[1] ?? null };
  const node = /(^|\/)(node|bun)$/.test(a0);
  const a1 = argv[1] ?? '';
  if (node && /@anthropic-ai\/claude-code\/cli\.m?js$/.test(a1)) return { kind: 'cli', version: null };
  const head = argv.slice(0, 4);
  // rea: node …/.bin/rea mcp, its sh -c 'rea' mcp, and npm exec rea-agents@x mcp
  if (head.some((x) => /(^|\/)rea$/.test(x) || /^'?rea'?$/.test(x) || /(^|\/)rea-agents(@[\w.-]+)?$/.test(x)) && argv.includes('mcp')) return { kind: 'mcp', name: 'rea' };
  if (head.some((x) => x.includes('@playwright/mcp'))) return { kind: 'mcp', name: 'playwright' };
  if (head.some((x) => /portboard[^ ]*\/(src|bin)\/mcp\.ts$/.test(x) || /claude-plugin\/bin\/mcp\.ts$/.test(x))) return { kind: 'mcp', name: 'portboard' };
  // the `portboard mcp` command (bin/portboard, #9): node …/bin/portboard mcp, npx portboard mcp
  if (head.some((x, i) => /(^|\/)portboard$/.test(x) && argv[i + 1] === 'mcp')) return { kind: 'mcp', name: 'portboard' };
  if (!generic) return { kind: 'proc' };
  for (const x of head) {
    if (x === 'mcp' || x.startsWith('-')) continue;
    const pkg = /node_modules\/((?:@[\w.-]+\/)?[\w.-]+)\//.exec(x)?.[1] ?? (/^(?:@[\w.-]+\/)?[\w.-]+(?:@[\w.-]+)?$/.test(x) ? x.replace(/(?!^)@[\w.-]+$/, '') : null);
    if (pkg && /mcp|@modelcontextprotocol\//i.test(pkg)) return { kind: 'mcp', name: pkg };
    if (/(^|\/)mcp-server[\w.-]*$/.test(x) || /(^|\/)[\w.-]+-mcp$/.test(x)) return { kind: 'mcp', name: base(x) };
  }
  return { kind: 'proc' };
}

/** -1, 0, 1 for dotted versions ("2.1.295" < "2.1.299") */
export function versionCmp(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}
