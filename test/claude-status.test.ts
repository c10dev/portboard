import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIdle, parsePsTree, projectDirOf, psSessions, summarize, topClis, type CliRow } from '../src/core/claude-status.ts';
import type { RunResult } from '../src/core/exec.ts';

// machine_status's Claude Code sessions (docs/multi-host.md): Linux from the memory sampler, macOS from ps + lsof and
// the transcripts, summed up with ids cut to 8 characters and helpers left out.

const row = (over: Partial<CliRow>): CliRow => ({ id: '0f0e0d0c-0b0a-4908-8706-050403020100', cwd: '/home/dev/projects/shop-web', version: '2.1.299', idleMin: 1, cpuPct: 20, mb: 800, startedAt: '2026-10-22T04:00:00.000Z', helper: false, idle: false, ...over });

test('summarize: helpers out, ids cut, worktree from the cwd, newest CLI version, active vs idle', () => {
  const s = summarize(
    [
      row({}),
      row({ id: 'aaaaaaaa-0000-4000-8000-000000000000', cwd: '/home/dev/projects/shop-web/.claude/worktrees/feat-map', version: '2.1.301', idle: true, idleMin: 90 }),
      row({ id: null, helper: true, version: '2.1.400' }),
    ],
    'proc',
    (cwd) => (cwd.endsWith('feat-map') ? 'shop-web@feat-map' : 'shop-web@main'),
  );
  assert.equal(s.source, 'proc');
  assert.equal(s.cliVersion, '2.1.400');
  assert.deepEqual(s.sessions.map((x) => [x.id, x.project, x.worktree, x.idle]), [
    ['0f0e0d0c', 'shop-web', 'shop-web@main', false],
    ['aaaaaaaa', 'shop-web/feat-map', 'shop-web@feat-map', true],
  ]);
  assert.equal(s.active, 1);
  assert.equal(s.idle, 1);
  assert.ok(!JSON.stringify(s).includes('/home/dev'), 'no cwd in the summary');
});

test('isIdle: the sampler decides; without a CPU reading, a transcript quiet for idleMin', () => {
  assert.equal(isIdle({ idle: true, idleMin: 0, cpuPct: 50 }), true);
  assert.equal(isIdle({ idle: null, idleMin: 61, cpuPct: null }), true);
  assert.equal(isIdle({ idle: null, idleMin: 10, cpuPct: null }), false);
  assert.equal(isIdle({ idle: null, idleMin: null, cpuPct: null }), false);
  assert.equal(isIdle({ idle: null, idleMin: 90, cpuPct: 40 }), false);
});

test('projectDirOf: ~/.claude/projects names a cwd with every non-alphanumeric as - (the fixture dirs)', () => {
  assert.equal(projectDirOf('/home/dev/projects/shop-web'), '-home-dev-projects-shop-web');
  assert.equal(projectDirOf('/home/dev/projects/acme/.claude/worktrees/acme-9-x'), '-home-dev-projects-acme--claude-worktrees-acme-9-x');
});

const PS = [
  '    1     0 Wed Oct 22 01:00:00 2026 /sbin/launchd',
  '  500     1 Wed Oct 22 04:00:00 2026 /Users/dev/.claude/remote/ccd-cli/2.1.299 --output-format stream-json',
  '  501   500 Wed Oct 22 04:00:05 2026 node /Users/dev/.npm/_npx/x/node_modules/@playwright/mcp/cli.js',
  '  502   500 Wed Oct 22 04:01:00 2026 /Users/dev/.local/bin/claude -p nested',
  '  600     1 Wed Oct 22  4:30:00 2026 /Users/dev/.local/share/claude/versions/2.1.301/claude --no-session-persistence',
  'garbage line',
].join('\n');

test('parsePsTree + topClis: lstart parsed, nested CLIs stay in their outer session', () => {
  const rows = parsePsTree(PS);
  assert.equal(rows.length, 5);
  assert.equal(rows[1].pid, 500);
  assert.equal(new Date(rows[1].startedAt!).getUTCFullYear(), 2026);
  assert.deepEqual(topClis(rows).map((r) => [r.pid, r.version]), [[500, '2.1.299'], [600, '2.1.301']]);
});

test('psSessions: cwd from lsof, the newest transcript of that project dir is the session, one transcript per session', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pb-cs-'));
  const fixtures = fileURLToPath(new URL('./fixtures/adoption/', import.meta.url));
  cpSync(join(fixtures, '-home-dev-projects-shop-web'), join(home, '.claude', 'projects', '-Users-dev-projects-shop-web'), { recursive: true });
  const t0 = Date.parse('2026-10-22T05:00:00Z');
  utimesSync(join(home, '.claude/projects/-Users-dev-projects-shop-web/11111111-1111-1111-1111-111111111111.jsonl'), new Date(t0 - 5 * 60_000), new Date(t0 - 5 * 60_000));
  const ok = (stdout: string): RunResult => ({ ok: true, stdout, stderr: '' }) as RunResult;
  const calls: string[][] = [];
  const exec = async (cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    if (cmd === 'ps') return ok(PS);
    return ok('p500\nfcwd\nn/Users/dev/projects/shop-web\np600\nfcwd\nn/Users/dev/projects/shop-web\n');
  };
  const rows = await psSessions({ exec, home, now: t0 });
  assert.deepEqual(calls.map((c) => c[0]), ['ps', 'lsof']);
  assert.ok(calls[1].includes('500,600'));
  assert.deepEqual(rows.map((r) => [r.id, r.cwd, r.idleMin, r.helper]), [
    ['11111111-1111-1111-1111-111111111111', '/Users/dev/projects/shop-web', 5, false],
    // the same cwd, no transcript left for it
    [null, '/Users/dev/projects/shop-web', null, true],
  ]);
  // ps failing: nothing, no throw
  assert.deepEqual(await psSessions({ exec: async () => ({ ok: false, stdout: '', stderr: 'x' }) as RunResult, home }), []);
});
