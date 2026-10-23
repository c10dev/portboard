// Scan cost (c10dev/portboard#44): a real repo with linked worktrees in a temp dir, scanned through a counting runner
// (real git and du, fake gh). Incremental scans must spawn far less and report exactly what a full scan reports.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/core/exec.ts';
import {
  indexPaths, newScanCache, packPaths, unpackPaths, removeWorktrees, scanWorktrees, SIZE_CHANGED_TTL_MS, SIZE_TTL_MS, STATUS_TTL_MS,
  type Runner, type ScanOptions, type WorktreesDoc,
} from '../src/core/worktrees.ts';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', '-C', cwd, ...args], { encoding: 'utf8' }).trim();

const root = realpathSync(mkdtempSync(join(tmpdir(), 'pb-wt-scan-')));
const repo = join(root, 'repo');
after(() => rmSync(root, { recursive: true, force: true }));
const wt = (name: string) => join(root, name);
mkdirSync(join(repo, 'src', 'a'), { recursive: true });
git(root, 'init', '-q', 'repo');
writeFileSync(join(repo, 'README.md'), 'hello\n');
writeFileSync(join(repo, 'src', 'a', 'deep.ts'), 'export const x = 1;\n');
writeFileSync(join(repo, 'src', 'b.ts'), 'export const b = 2;\n');
git(repo, 'add', '-A');
git(repo, 'commit', '-qm', 'init');
git(repo, 'remote', 'add', 'origin', 'https://github.com/x/fixture.git'); // never fetched: gh is faked
for (const b of ['m1', 'm2', 'm3']) git(repo, 'worktree', 'add', '-q', '-b', b, wt(b));
git(repo, 'worktree', 'add', '-q', '-b', 'feat', wt('feat'));
writeFileSync(join(wt('feat'), 'src', 'b.ts'), 'export const b = 3;\n');
git(wt('feat'), 'commit', '-qam', 'feat');
git(repo, 'worktree', 'add', '-q', '-b', 'sq', wt('sq'));
writeFileSync(join(wt('sq'), 'README.md'), 'squash me\n');
git(wt('sq'), 'commit', '-qam', 'sq');
// The PR head moved on after the worktree (pushed from elsewhere): sq2 = sq + one commit, no worktree
git(repo, 'branch', 'sq2', 'sq');
git(wt('sq'), 'commit', '-q', '--allow-empty', '-m', 'later');
const sqPrHead = git(wt('sq'), 'rev-parse', 'HEAD');
git(wt('sq'), 'reset', '-q', '--hard', 'HEAD~1');
const featHead = git(wt('feat'), 'rev-parse', 'HEAD');

const prs = [
  { number: 2, headRefName: 'sq', headRefOid: sqPrHead, state: 'MERGED' },
  { number: 1, headRefName: 'feat', headRefOid: featHead, state: 'OPEN' },
];

/** Real git and du, fake gh; counts every spawn and records `git status` cwds */
function counting() {
  const counts: Record<string, number> = {};
  const status: string[] = [];
  const runner: Runner = (cmd, args, timeoutMs) => {
    counts[cmd] = (counts[cmd] ?? 0) + 1;
    if (cmd === 'git' && args.includes('status')) status.push(args[1]);
    if (cmd === 'gh') return Promise.resolve({ ok: true, stdout: JSON.stringify(prs), stderr: '' });
    return run(cmd, args, timeoutMs);
  };
  return { counts, status, runner };
}

const norm = (d: WorktreesDoc) => JSON.stringify({ ...d, at: null, tookMs: null, scan: null });
const cache = newScanCache();
const scan = (c: ReturnType<typeof counting>, over: ScanOptions = {}) => scanWorktrees({ repos: [repo], cache, run: c.runner, racyMs: 0, ...over });
const byPath = (d: WorktreesDoc, p: string) => d.repos[0].worktrees.find((w) => w.path === p)!;

test('indexPaths reads the tracked paths of a real index, in index order', () => {
  const paths = indexPaths(readFileSync(join(repo, '.git', 'index')));
  assert.deepEqual(paths, git(repo, 'ls-files').split('\n'));
  assert.equal(indexPaths(Buffer.from('not an index')), null);
  assert.equal(indexPaths(readFileSync(join(repo, '.git', 'index')).subarray(0, 60)), null, 'truncated');
  const v4 = join(root, 'v4');
  git(root, 'init', '-q', 'v4');
  writeFileSync(join(v4, 'f'), 'x');
  git(v4, 'add', 'f');
  git(v4, 'update-index', '--index-version', '4');
  assert.equal(indexPaths(readFileSync(join(v4, '.git', 'index'))), null, 'v4 is left to git');
});

test('packPaths/unpackPaths: one buffer for the cached paths, iterable again, non-ASCII and empty lists intact', () => {
  const paths = ['a', 'dir/b c.txt', '한글/파일.md', 'x/y/z'];
  const packed = packPaths(paths);
  assert.ok(Buffer.isBuffer(packed));
  const it = unpackPaths(packed);
  assert.deepEqual([...it], paths);
  assert.deepEqual([...it], paths, 'a second pass (treeSignature walks the paths twice)');
  assert.deepEqual([...unpackPaths(packPaths([]))], []);
});

test('a repo without linked worktrees costs no subprocess', async () => {
  const c = counting();
  const doc = await scanWorktrees({ repos: [join(root, 'v4')], cache: newScanCache(), run: c.runner, mode: 'incremental' });
  assert.deepEqual(c.counts, {});
  assert.deepEqual(doc.repos, []);
});

let full: WorktreesDoc;

test('full scan: what the old scanner reported, with batched log and ancestry', async () => {
  const c = counting();
  full = await scan(c, { mode: 'full' });
  const ws = full.repos[0].worktrees;
  assert.equal(ws.length, 6);
  assert.deepEqual(ws.filter((w) => w.removable).map((w) => w.branch).sort(), ['m1', 'm2', 'm3', 'sq']);
  assert.deepEqual(byPath(full, wt('feat')).keep, ['PR #1 열림']);
  assert.deepEqual(byPath(full, wt('sq')).pr, { number: 2, state: 'MERGED', headMatches: true });
  assert.ok(ws.every((w) => w.lastCommit && w.sizeKb && w.changes === 0));
  assert.equal(c.status.length, 6, 'a live status per worktree');
  assert.equal(c.counts.du, 6);
  assert.equal(c.counts.gh, 1);
  assert.deepEqual(full.scan, { mode: 'full', spawns: c.counts });
});

test('incremental scan with nothing changed: worktree list, the refs, the default tip and gh only', async () => {
  const c = counting();
  const doc = await scan(c, { mode: 'incremental' });
  assert.equal(norm(doc), norm(full));
  assert.deepEqual(c.counts, { git: 3, gh: 1 });
});

test('an edit deep in a tracked file is seen (same size), and only that worktree gets a git status', async () => {
  writeFileSync(join(wt('m1'), 'src', 'a', 'deep.ts'), 'export const x = 2;\n');
  const c = counting();
  const doc = await scan(c, { mode: 'incremental' });
  assert.deepEqual(c.status, [wt('m1')]);
  assert.equal(byPath(doc, wt('m1')).changes, 1);
  assert.equal(byPath(doc, wt('m1')).removable, false);
  assert.equal(norm(doc), norm(await scan(counting(), { mode: 'full' })));
});

test('a new untracked file in a subdirectory is seen', async () => {
  writeFileSync(join(wt('m2'), 'src', 'a', 'new.ts'), '//\n');
  const c = counting();
  const doc = await scan(c, { mode: 'incremental' });
  assert.deepEqual(c.status, [wt('m2')]);
  assert.equal(byPath(doc, wt('m2')).changes, 1);
});

test('a just-changed worktree is not trusted until its timestamps are older than the racy window', async () => {
  writeFileSync(join(wt('m3'), 'README.md'), 'hullo\n');
  for (let i = 0; i < 2; i++) {
    const c = counting();
    await scan(c, { mode: 'incremental', racyMs: 60_000 });
    assert.ok(c.status.includes(wt('m3')), `scan ${i + 1} re-runs status`);
  }
  const c = counting();
  const doc = await scan(c, { mode: 'incremental' });
  assert.ok(c.status.includes(wt('m3')), 'racy result was not cached');
  assert.equal(byPath(doc, wt('m3')).changes, 1);
  const again = counting();
  await scan(again, { mode: 'incremental' });
  assert.deepEqual(again.status, []);
});

test('TTLs: status after STATUS_TTL_MS and du after SIZE_TTL_MS even when nothing changed', async () => {
  const c = counting();
  await scan(c, { mode: 'incremental', now: Date.now() + STATUS_TTL_MS + 1000 });
  assert.equal(c.status.length, 6);
  assert.equal(c.counts.du, undefined);
  const d = counting();
  await scan(d, { mode: 'incremental', now: Date.now() + SIZE_TTL_MS + 1000 });
  assert.equal(d.counts.du, 6);
});

test('the default branch moving on re-checks ancestry against the new tip', async () => {
  git(repo, 'merge', '-q', '--ff-only', 'feat');
  const c = counting();
  const doc = await scan(c, { mode: 'incremental' });
  assert.equal(byPath(doc, wt('feat')).mergedByAncestry, true);
  assert.equal(byPath(doc, wt('feat')).removable, true);
  assert.equal(norm(doc), norm(await scan(counting(), { mode: 'full' })));
});

test('removal re-checks live even with a warm cache, and never removes a dirty worktree', async () => {
  await scan(counting(), { mode: 'incremental' });
  writeFileSync(join(wt('m3'), 'src', 'b.ts'), 'export const b = 9;\n');
  const c = counting();
  const res = await removeWorktrees(repo, [wt('m3'), wt('sq')], { run: c.runner });
  assert.equal(c.status.length, 6, 'every worktree gets a live status');
  assert.deepEqual(res.map((r) => [r.path, r.ok]), [[wt('m3'), false], [wt('sq'), true]]);
  assert.match(res[0].message, /변경/);
  const after = await scan(counting(), { mode: 'incremental' });
  assert.equal(after.repos[0].worktrees.some((w) => w.path === wt('sq')), false);
});

test('many unknown heads: one rev-list of the default tip instead of a merge-base each, same answers', async () => {
  for (const n of ['d1', 'd2', 'd3', 'd4']) {
    git(repo, 'worktree', 'add', '-q', '--detach', wt(n));
    git(wt(n), 'commit', '-q', '--allow-empty', '-m', n);
  }
  const c = counting();
  const calls: string[] = [];
  const doc = await scan({ ...c, runner: (cmd, args, t) => (calls.push(args.slice(2).join(' ')), c.runner(cmd, args, t)) }, { mode: 'incremental' });
  assert.equal(calls.filter((a) => a.startsWith('rev-list')).length, 1);
  assert.equal(calls.filter((a) => a.startsWith('merge-base')).length, 0);
  for (const n of ['d1', 'd2', 'd3', 'd4']) assert.deepEqual([byPath(doc, wt(n)).mergedByAncestry, byPath(doc, wt(n)).keep], [false, ['분리된 HEAD']]);
  assert.equal(byPath(doc, wt('m1')).mergedByAncestry, true);
  // Sizes aside: the main checkout's .git grew with the new worktrees while its HEAD and files stayed, so its cached
  // size is older than what du says now (sizes may be up to SIZE_TTL_MS old)
  const live = await scanWorktrees({ repos: [repo], cache: newScanCache(), run: counting().runner, mode: 'live', withSize: false });
  const noSize = (d: WorktreesDoc) => norm({ ...d, repos: d.repos.map((r) => ({ ...r, worktrees: r.worktrees.map((w) => ({ ...w, sizeKb: null })) })), totals: { ...d.totals, removableKb: 0 } });
  assert.equal(noSize(doc), noSize(live));
});

test('du again when the files changed and the size is older than SIZE_CHANGED_TTL_MS, not on every edit', async () => {
  await scan(counting(), { mode: 'incremental' });
  writeFileSync(join(wt('d1'), 'big.bin'), Buffer.alloc(64 * 1024));
  const soon = counting();
  await scan(soon, { mode: 'incremental' });
  assert.deepEqual([soon.status, soon.counts.du], [[wt('d1')], undefined]);
  writeFileSync(join(wt('d1'), 'big2.bin'), Buffer.alloc(64 * 1024));
  const later = counting();
  const doc = await scan(later, { mode: 'incremental', now: Date.now() + SIZE_CHANGED_TTL_MS });
  assert.equal(later.counts.du, 1);
  assert.ok(byPath(doc, wt('d1')).sizeKb! >= 128);
});

test('ahead/behind from the upstream as of the last fetch, and origin claude/* branches pushed lately, in the same refs read', async () => {
  const commitOn = (parent: string, msg: string, date?: string) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-C', repo, 'commit-tree', `${parent}^{tree}`, '-p', parent, '-m', msg], {
      encoding: 'utf8',
      // a clean environment: no parent GIT_DIR, global or system config
      env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', ...(date ? { GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } : {}) },
    }).trim();
  const track = (branch: string) => {
    git(repo, 'config', `branch.${branch}.remote`, 'origin');
    git(repo, 'config', `branch.${branch}.merge`, `refs/heads/${branch}`);
  };
  // feat has one commit origin/feat lacks; origin/m1 has one m1 lacks; m2's upstream was deleted
  git(repo, 'update-ref', 'refs/remotes/origin/feat', 'feat~1');
  track('feat');
  git(repo, 'update-ref', 'refs/remotes/origin/m1', commitOn(git(repo, 'rev-parse', 'm1'), 'pushed from elsewhere'));
  track('m1');
  track('m2');
  const tip = git(repo, 'rev-parse', 'main');
  git(repo, 'update-ref', 'refs/remotes/origin/claude/fresh', commitOn(tip, 'cloud work'));
  git(repo, 'update-ref', 'refs/remotes/origin/claude/old', commitOn(tip, 'old work', new Date(Date.now() - 3 * 24 * 3600_000).toISOString()));
  prs.push({ number: 7, headRefName: 'claude/fresh', headRefOid: git(repo, 'rev-parse', 'origin/claude/fresh'), state: 'OPEN' });

  await scan(counting(), { mode: 'incremental' }); // the config changed: remote and metadata read again
  const c = counting();
  const doc = await scan(c, { mode: 'incremental' });
  assert.equal(c.counts.git, 3, 'still one for-each-ref, no rev-list per branch');
  const apart = (p: string) => [byPath(doc, p).ahead, byPath(doc, p).behind];
  assert.deepEqual(apart(wt('feat')), [1, 0]);
  assert.deepEqual(apart(wt('m1')), [0, 1]);
  assert.deepEqual(apart(wt('m2')), [null, null], 'upstream gone');
  assert.deepEqual(apart(wt('m3')), [null, null], 'no upstream');
  assert.deepEqual(doc.repos[0].claudeBranches!.map((b) => [b.branch, b.pr]), [['claude/fresh', { number: 7, state: 'OPEN' }]], 'claude/old is outside the window');
  const full = await scan(counting(), { mode: 'full' });
  assert.deepEqual(full.repos[0].worktrees.map((w) => [w.ahead, w.behind]), doc.repos[0].worktrees.map((w) => [w.ahead, w.behind]));
  assert.deepEqual(full.repos[0].claudeBranches, doc.repos[0].claudeBranches);
});

test('a repo without linked worktrees: no git at all, unless origin has claude/* refs, then its recent ones (no gh)', async () => {
  const plain = join(root, 'plain');
  git(root, 'init', '-q', 'plain');
  writeFileSync(join(plain, 'f'), 'x\n');
  git(plain, 'add', 'f');
  git(plain, 'commit', '-qm', 'init');
  git(plain, 'remote', 'add', 'origin', 'https://github.com/x/plain.git');
  const c = counting();
  let doc = await scanWorktrees({ repos: [plain], cache: newScanCache(), run: c.runner, mode: 'incremental' });
  assert.deepEqual(c.counts, {});
  assert.deepEqual(doc.checkouts, [{ name: 'plain', path: plain, short: plain, branch: 'main' }]);
  git(plain, 'update-ref', 'refs/remotes/origin/claude/loose', 'HEAD');
  git(plain, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  const d = counting();
  doc = await scanWorktrees({ repos: [plain], cache: newScanCache(), run: d.runner, mode: 'incremental' });
  assert.deepEqual(d.counts, { git: 2 }, 'for-each-ref and the remote; gh is not asked');
  assert.equal(doc.checkouts![0].remote, 'https://github.com/x/plain.git');
  assert.deepEqual(doc.checkouts![0].claudeBranches!.map((b) => [b.branch, b.pr]), [['claude/loose', null]]);
  // packed refs count too
  git(plain, 'pack-refs', '--all');
  assert.equal(git(plain, 'for-each-ref', 'refs/remotes/origin/claude/').length > 0, true);
  doc = await scanWorktrees({ repos: [plain], cache: newScanCache(), run: counting().runner, mode: 'incremental' });
  assert.deepEqual(doc.checkouts![0].claudeBranches!.map((b) => b.branch), ['claude/loose']);
});
