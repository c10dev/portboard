// 채택 지표 (c10dev/portboard#40) from the command line: scans the Claude Code transcripts now (no cache) and prints
// how sessions handled ports over the last N days and the N days before.
//
//   node scripts/adoption.ts [--days N] [--json] [--root DIR]
//
// Prints counts, project dir names, ports and short command prefixes only, never what a transcript said.

import { adoptionLine, scanTranscripts, viewOf, type Summary, type Totals } from '../src/core/adoption.ts';

function parseArgs(argv: string[]): { days: number; json: boolean; root?: string } {
  const out: { days: number; json: boolean; root?: string } = { days: 7, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--days') out.days = Number(argv[++i]);
    else if (a.startsWith('--days=')) out.days = Number(a.slice(7));
    else if (a === '--root') out.root = argv[++i];
    else if (a === '-h' || a === '--help') {
      console.log('usage: node scripts/adoption.ts [--days N] [--json] [--root DIR]');
      process.exit(0);
    } else {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    }
  }
  if (!Number.isInteger(out.days) || out.days < 1 || out.days > 90) {
    console.error('--days must be 1–90');
    process.exit(2);
  }
  return out;
}

const pad = (v: unknown, n: number) => String(v).padStart(n);
const COLS: [keyof Totals, string][] = [['sessions', 'sess'], ['mcp', 'mcp'], ['inspect', 'insp'], ['kill', 'kill'], ['hardcoded', 'fixed'], ['nudges', 'nudge'], ['followed', 'foll'], ['shell', 'shell']];
const head = (first: string, w: number) => `${first.padEnd(w)}${COLS.map(([, h]) => pad(h, 7)).join('')}`;
const line = (first: string, w: number, t: Totals) => `${first.padEnd(w)}${COLS.map(([k]) => pad(t[k], 7)).join('')}`;

function print(label: string, s: Summary) {
  console.log(`\n== ${label}: ${s.from} – ${s.to} (KST)`);
  console.log(head('day', 12));
  for (const d of s.byDay) console.log(line(d.day, 12, d));
  console.log(line('total', 12, s.totals));
  console.log(`\n${head('project', 28)}`);
  for (const p of s.byProject) console.log(line(p.project.slice(0, 27), 28, p));
  console.log(`\nports (start/inspect/kill): ${s.topPorts.map((p) => `${p.port} ${p.start}/${p.inspect}/${p.kill}`).join(', ') || '-'}`);
  console.log(`prefixes: ${s.topPrefixes.map((p) => `${p.prefix} ×${p.count}`).join(', ') || '-'}`);
  console.log(`portboard MCP tools: ${Object.entries(s.mcpTools).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ×${n}`).join(', ') || '-'}`);
}

const args = parseArgs(process.argv.slice(2));
const scan = await scanTranscripts({ root: args.root, days: args.days * 2 });
const view = viewOf(scan, args.days);
if (args.json) {
  console.log(JSON.stringify(view, null, 2));
} else {
  const f = scan.files;
  console.log(`scanned ${f.read} files (${f.subagents} subagent) · ${(f.bytes / 1e6).toFixed(0)} MB · skipped ${f.skipped} older · ${scan.tookMs} ms`);
  if (view.current) print(`last ${args.days} d`, view.current);
  if (view.previous) print(`the ${args.days} d before`, view.previous);
  if (view.current) console.log(`\ndigest: ${adoptionLine(view.current.totals, view.previous?.totals ?? null)}`);
}
