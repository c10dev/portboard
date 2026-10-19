import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { githubRepo, keepReasons, parsePorcelain, pidsInside, type WorktreeInfo } from '../src/core/worktrees.ts';
import { L } from './fixtures/locale.ts';
import { loadSavedWorktrees } from '../src/features/worktrees.ts';

test('saved scan (#8): what the remote list_worktrees reads; missing or malformed is null, never a scan', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pb-wt-saved-'));
  const path = join(dir, 'worktrees-state.json');
  assert.equal(await loadSavedWorktrees(path), null);
  await writeFile(path, '{"at": null, "repos": []}');
  assert.equal(await loadSavedWorktrees(path), null, 'no at: not a finished scan');
  await writeFile(path, 'not json');
  assert.equal(await loadSavedWorktrees(path), null);
  const doc = { at: '2026-10-17T12:30:00.000Z', scanning: true, tookMs: 5, repos: [], totals: { repos: 0, worktrees: 0, removable: 0, prunable: 0, removableKb: 0 } };
  await writeFile(path, JSON.stringify(doc));
  assert.deepEqual(await loadSavedWorktrees(path), { ...doc, scanning: false }, 'a saved scan is never "scanning"');
});

test('parsePorcelain reads main, branch, detached, locked and prunable worktrees', () => {
  const text = [
    'worktree /r', 'HEAD aaa', 'detached', '',
    'worktree /w/feat', 'HEAD bbb', 'branch refs/heads/claude/feat', '',
    'worktree /w/old', 'HEAD ccc', 'branch refs/heads/old', 'locked reason here', '',
    'worktree /w/gone', 'HEAD ddd', 'branch refs/heads/gone', 'prunable gitdir file points to non-existent location', '',
  ].join('\n');
  const e = parsePorcelain(text);
  assert.deepEqual(e.map((x) => [x.path, x.branch, x.detached, x.locked, x.prunable]), [
    ['/r', null, true, false, false],
    ['/w/feat', 'claude/feat', false, false, false],
    ['/w/old', 'old', false, true, false],
    ['/w/gone', 'gone', false, false, true],
  ]);
});

test('githubRepo', () => {
  assert.equal(githubRepo('git@github.com:c10dev/webapp.git'), 'c10dev/webapp');
  assert.equal(githubRepo('https://github.com/c10dev/portboard'), 'c10dev/portboard');
  assert.equal(githubRepo('/srv/git/x.git'), null);
});

test('pidsInside matches the directory and below, not siblings with the same prefix', () => {
  const cwds = new Map([[1, '/w/feat'], [2, '/w/feat/src'], [3, '/w/feature-2'], [4, '/w']]);
  assert.deepEqual(pidsInside('/w/feat', cwds), [1, 2]);
});

const wt = (over: Partial<WorktreeInfo>): Omit<WorktreeInfo, 'keep' | 'removable'> => ({
  path: '/w/x', short: '~/w/x', head: 'h', branch: 'b', detached: false, main: false, locked: false, prunable: false,
  changes: 0, lastCommit: null, sizeKb: null, mergedByAncestry: false, pr: null, inUse: [], ...over,
});

test('keepReasons: removable only when merged, clean, unused, unlocked, linked', () => {
  assert.deepEqual(keepReasons(wt({ mergedByAncestry: true })), []);
  assert.deepEqual(keepReasons(wt({ pr: { number: 7, state: 'MERGED', headMatches: true } })), []);
  assert.deepEqual(keepReasons(wt({ pr: { number: 7, state: 'MERGED', headMatches: false } })), [L('PR에 없는 커밋 있음', 'commits not in the PR')]);
  assert.deepEqual(keepReasons(wt({ pr: { number: 8, state: 'OPEN', headMatches: true } })), [L('PR #8 열림', 'PR #8 open')]);
  assert.deepEqual(keepReasons(wt({ pr: { number: 9, state: 'CLOSED', headMatches: true } })), [L('PR #9 닫힘(머지 안 됨)', 'PR #9 closed (not merged)')]);
  assert.deepEqual(keepReasons(wt({})), [L('머지 안 됨', 'not merged')]);
  assert.deepEqual(keepReasons(wt({ mergedByAncestry: true, changes: 3 })), [L('변경 3개', '3 changes')]);
  assert.deepEqual(keepReasons(wt({ mergedByAncestry: true, changes: null })), [L('변경 여부 확인 실패', "couldn't check for changes")]);
  assert.deepEqual(keepReasons(wt({ mergedByAncestry: true, inUse: [12] })), [L('사용 중인 프로세스 1개', '1 process using it')]);
  assert.deepEqual(keepReasons(wt({ mergedByAncestry: true, locked: true })), [L('잠김(locked)', 'locked')]);
  assert.ok(keepReasons(wt({ mergedByAncestry: true, main: true })).includes(L('메인 체크아웃', 'main checkout')));
  assert.deepEqual(keepReasons(wt({ prunable: true })), [], 'gone directories are for prune, not remove');
});
