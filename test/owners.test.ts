import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLAUDE_WORKTREE_DIR, cleanupReasons, isTransientPath, mainRepoFromGitFile, parseEnviron, scratchpadSession, type Owner } from '../src/core/owners.ts';
import { eligible } from '../src/features/owners.ts';
import type { PortEntry } from '../src/core/index.ts';

const NOW = Date.parse('2026-10-18T12:00:00Z');
const owner = (over: Partial<Owner>): Owner => ({ pid: 1, session: null, worktree: null, scratchpad: false, cwdGone: false, orphan: false, ...over });
const session = (alive: boolean, lastActive: string | null = null) => ({ id: 'a', title: 't', alive, lastActive, source: 'env' as const });
const wt = (merged: boolean | null, dirty: boolean | null, linked = true) => ({ repo: '~/r', repoName: 'r', path: '~/w', branch: 'b', merged, dirty, linked });

test('parseEnviron keeps only the Claude session keys', () => {
  assert.deepEqual(parseEnviron('PATH=/bin\0CLAUDE_CODE_SESSION_ID=abc\0CLAUDE_PID=42\0SECRET=x\0'), { CLAUDE_CODE_SESSION_ID: 'abc', CLAUDE_PID: '42' });
});

test('scratchpad session id and main repo from a worktree .git file', () => {
  assert.equal(scratchpadSession('/tmp/claude-1000/-home-dev-projects/d4a2a28d-528e-4924-9f8e-0fc6c380a7f8/scratchpad/preview/www-a'), 'd4a2a28d-528e-4924-9f8e-0fc6c380a7f8');
  assert.equal(scratchpadSession('/home/dev/projects/x'), null);
  assert.equal(mainRepoFromGitFile('gitdir: /home/dev/projects/shop-web/.git/worktrees/3d-redesign\n'), '/home/dev/projects/shop-web');
  assert.equal(mainRepoFromGitFile('nonsense'), null);
});

test('cleanup reasons', () => {
  assert.deepEqual(cleanupReasons(owner({ cwdGone: true }), NOW), ['cwd-gone']);
  // Claude Code removed its worktree (session ended or archived) and the server it started kept running
  assert.deepEqual(cleanupReasons(owner({ cwdGone: true, claudeWorktreeGone: true }), NOW), ['claude-worktree-gone']);
  // scratchpad server of an ended session: candidate at once
  assert.deepEqual(cleanupReasons(owner({ scratchpad: true, session: session(false, '2026-10-18T11:59:00Z') }), NOW), ['session-ended']);
  // a worktree server of a session that ended a minute ago: not yet; after 2 h idle: yes
  assert.deepEqual(cleanupReasons(owner({ session: session(false, '2026-10-18T11:59:00Z') }), NOW), []);
  assert.deepEqual(cleanupReasons(owner({ session: session(false, '2026-10-18T09:00:00Z') }), NOW), ['session-ended']);
  // merged + clean + linked worktree, no live session: candidate; live session or dirty or main checkout: keep
  assert.deepEqual(cleanupReasons(owner({ worktree: wt(true, false) }), NOW), ['branch-merged']);
  assert.deepEqual(cleanupReasons(owner({ worktree: wt(true, false), session: session(true) }), NOW), []);
  assert.deepEqual(cleanupReasons(owner({ worktree: wt(true, true) }), NOW), []);
  assert.deepEqual(cleanupReasons(owner({ worktree: wt(true, false, false) }), NOW), []);
  assert.deepEqual(cleanupReasons(owner({ worktree: wt(null, false) }), NOW), []);
});

test('only stoppable plain processes we own are eligible', () => {
  const base = { listening: true, owned: true, container: null, control: { type: 'process', pids: [1] }, canStop: true } as unknown as PortEntry;
  assert.equal(eligible(base), true);
  assert.equal(eligible({ ...base, control: { type: 'systemd', unit: 'x.service' } } as PortEntry), false);
  assert.equal(eligible({ ...base, container: 'c' } as PortEntry), false);
  assert.equal(eligible({ ...base, canStop: false } as PortEntry), false);
  assert.equal(eligible({ ...base, owned: false } as PortEntry), false);
});

test('transient units (systemd-run) are eligible; installed units are not', () => {
  assert.equal(isTransientPath('/run/user/1000/systemd/transient/pb-sd-dummy-a.service'), true);
  assert.equal(isTransientPath('/home/dev/.config/systemd/user/portboard.service'), false);
  const unit = (u: string) => ({ listening: true, owned: true, container: null, canStop: true, control: { type: 'systemd', unit: u } }) as unknown as PortEntry;
  assert.equal(eligible(unit('pb-sd-dummy-a.service'), new Set(['pb-sd-dummy-a.service'])), true);
  assert.equal(eligible(unit('syncthing.service'), new Set(['pb-sd-dummy-a.service'])), false);
});

test('CLAUDE_WORKTREE_DIR: the worktree folder or anything inside it', () => {
  assert.ok(CLAUDE_WORKTREE_DIR.test('/home/dev/projects/shop/.claude/worktrees/feat-auth'));
  assert.ok(CLAUDE_WORKTREE_DIR.test('/home/dev/projects/shop/.claude/worktrees/feat-auth/web'));
  assert.ok(!CLAUDE_WORKTREE_DIR.test('/home/dev/projects/shop/.claude/worktrees'));
  assert.ok(!CLAUDE_WORKTREE_DIR.test('/home/dev/projects/shop-feat-auth'));
});

