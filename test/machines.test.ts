import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAgentHandler, projectStatus, type AgentInfo, type StatusParts } from '../src/agent/server.ts';
import { agentStatus, AgentsCollector, checkStatus, type AgentRead } from '../src/core/agents.ts';
import { buildMachines, CLOUD_ACTIVE_MIN, cloudEstimate, dataAge, defaultMaxSessions, localStatus, portCounts } from '../src/core/machines.ts';
import { checkAgentTarget, machinesConfig, recommendConfig, resolveSite, SITE_DEFAULTS } from '../src/core/site.ts';
import { branchOfHead, briefOf, worktreeOwnerOf, type WorktreeInfo, type WorktreesDoc } from '../src/core/worktrees.ts';
import { answerWhere, parseFindQuery, parseRunRequest, repoFromTask, shapeMachines, machinesFeature } from '../src/features/machines.ts';
import type { Core } from '../src/mcp/kit.ts';
import { STRICT } from '../src/remote/redact.ts';
import { entry, snap, usage } from './fixtures/remote-redact.ts';

// machine_status (docs/multi-host.md): this machine's status, each agent's /agent/v1/status as the board reads it,
// and the list buildMachines makes of them; plus the feature's argument checks.

const NOW = Date.parse('2026-10-22T05:00:00Z');
const LOAD = { cores: 8, load1: 1, memTotalMb: 16000, memAvailMb: 8000, diskFreePct: 50, uptimeSec: 10 };

const wtInfo = (over: Partial<WorktreeInfo>): WorktreeInfo => ({
  path: '/home/dev/projects/shop-web/.claude/worktrees/feat-map',
  short: '~/projects/shop-web/.claude/worktrees/feat-map',
  head: 'a'.repeat(40),
  branch: 'feat-map',
  detached: false,
  main: false,
  locked: false,
  prunable: false,
  changes: 2,
  lastCommit: '2026-10-21T09:12:00Z',
  sizeKb: 100,
  mergedByAncestry: false,
  pr: null,
  inUse: [4242],
  claude: true,
  keep: [],
  removable: false,
  ...over,
});

const DOC: Pick<WorktreesDoc, 'repos' | 'checkouts'> = {
  repos: [
    {
      name: 'shop-web',
      path: '/home/dev/projects/shop-web',
      short: '~/projects/shop-web',
      remote: 'git@github.com:c10dev/shop-web.git',
      defaultBranch: 'main',
      prsKnown: true,
      error: null,
      worktrees: [
        wtInfo({ path: '/home/dev/projects/shop-web', short: '~/projects/shop-web', branch: 'main', main: true, changes: 0, inUse: [], claude: false }),
        wtInfo({}),
        wtInfo({ path: '/home/dev/projects/shop-web/wt-gone', short: '~/projects/shop-web/wt-gone', branch: 'gone', prunable: true }),
      ],
    },
  ],
  checkouts: [{ name: 'notes', path: '/home/dev/projects/notes', short: '~/projects/notes', branch: 'main' }],
};

test('briefOf: worktrees and main checkouts as repo@branch with the reserved port; prunable ones out; repos without worktrees too', () => {
  const b = briefOf(DOC, [{ port: 4105, owner: 'shop-web@feat-map' }, { port: 4200, owner: '~/projects/notes' }]);
  assert.deepEqual(b.map((x) => [x.owner, x.remote, x.main, x.dirty, x.inUse, x.claude, x.reservedPort]), [
    ['shop-web@main', 'c10dev/shop-web', true, 0, false, false, null],
    ['shop-web@feat-map', 'c10dev/shop-web', false, 2, true, true, 4105],
    ['notes@main', null, true, null, false, false, 4200],
  ]);
  const of = worktreeOwnerOf(DOC);
  assert.equal(of('/home/dev/projects/shop-web/.claude/worktrees/feat-map/src'), 'shop-web@feat-map');
  assert.equal(of('/home/dev/projects/shop-web/src'), 'shop-web@main');
  assert.equal(of('/home/dev/projects/shop-webby'), null);
  assert.equal(of('/home/dev/projects/notes'), 'notes@main');
  assert.equal(branchOfHead('ref: refs/heads/feat/a-b\n'), 'feat/a-b');
  assert.equal(branchOfHead('3f2a…'), null);
});

test('portCounts: listening ports, and dev servers among them (no unit or pb-dev-*, not containers or services)', () => {
  const s = {
    ports: [
      entry({ port: 5173, processes: [{ pid: 1, cmdline: 'node vite', cwd: null, project: null, unit: null, unitDescription: null }] }),
      entry({ port: 3001, processes: [{ pid: 2, cmdline: 'npm run dev', cwd: null, project: null, unit: 'pb-dev-shop-1234.service', unitDescription: null }] }),
      entry({ port: 8790, processes: [{ pid: 3, cmdline: 'node server', cwd: null, project: null, unit: 'portboard.service', unitDescription: null }] }),
      entry({ port: 5432, container: 'db' }),
      entry({ port: 9, listening: false }),
    ],
  };
  assert.deepEqual(portCounts(s), { listening: 4, devServers: 2 });
});

test('localStatus: briefs, sessions matched by cwd, a failing source leaves null instead of failing', async () => {
  let seen: ((cwd: string) => string | null) | null = null;
  const parts = await localStatus({
    host: 'vocado-dev',
    snapshot: async () => snap,
    worktrees: async () => DOC as WorktreesDoc,
    reservations: async () => [],
    load: async () => LOAD,
    capabilities: async () => ['linux', 'systemd'],
    claude: async (of) => {
      seen = of;
      return { cliVersion: null, sessions: [], active: 0, idle: 0, source: 'proc' };
    },
    now: () => NOW,
  });
  assert.equal(parts.at, NOW);
  assert.equal(parts.worktrees?.length, 3);
  assert.equal(seen!('/home/dev/projects/notes/x'), 'notes@main');
  assert.ok(parts.ports && parts.ports.listening > 0);
  const broken = await localStatus({ host: 'x', snapshot: async () => { throw new Error('ss'); }, worktrees: async () => null, reservations: async () => { throw new Error('r'); }, load: async () => LOAD, capabilities: async () => [], claude: async () => null });
  assert.equal(broken.ports, null);
  assert.equal(broken.worktrees, null);
});

const PARTS: StatusParts = {
  at: NOW,
  host: 'mac',
  load: LOAD,
  claude: { cliVersion: '2.1.299', active: 1, idle: 0, source: 'ps', sessions: [{ id: '0f0e0d0c-0b0a', project: 'shop-web', worktree: 'shop-web@feat-map', idleMin: 0, cpuPct: null, mb: null, startedAt: null, idle: false }] },
  worktrees: briefOf(DOC, []),
  ports: { listening: 3, devServers: 1 },
  capabilities: ['macos'],
};

test('projectStatus: ids cut to 8, paths only with showPaths; checkStatus reads it back and refuses other schemas', () => {
  const out = projectStatus(PARTS, STRICT);
  assert.equal(out.schema, 1);
  assert.equal(out.claude?.sessions[0].id, '0f0e0d0c');
  assert.ok(out.worktrees!.every((w) => w.path === null));
  assert.ok(!JSON.stringify(out).includes('/home/dev'));
  assert.equal(projectStatus(PARTS, { ...STRICT, showPaths: true }).worktrees![1].path, '~/projects/shop-web/.claude/worktrees/feat-map');
  const back = checkStatus(JSON.parse(JSON.stringify(out)));
  assert.deepEqual(back, out);
  assert.equal(checkStatus({ ...out, schema: 2 }), null);
  assert.equal(checkStatus({ ...out, load: null }), null);
  // bad rows are dropped, bad fields nulled
  const odd = checkStatus({ ...out, worktrees: [{ owner: 1 }, { ...out.worktrees![0], reservedPort: 99999 }], capabilities: ['ok', 'bad cap!'] });
  assert.equal(odd?.worktrees?.length, 1);
  assert.equal(odd?.worktrees?.[0].reservedPort, null);
  assert.deepEqual(odd?.capabilities, ['ok']);
});

const info: AgentInfo = { schema: 1, version: '9.9.9', host: 'mac', dnsName: null, at: 1, load: LOAD };

test('agent HTTP: /agent/v1/status behind the same auth; an agent without the source answers 404', async (t) => {
  const make = (status?: () => Promise<StatusParts>) => {
    const s = createServer(
      createAgentHandler({
        sources: { snapshot: async () => snap, usage: async () => usage, info: async () => info, ...(status ? { status } : {}) },
        auth: { allow: [], token: 'tok', whois: async (addr) => ({ device: { addr } }), trustLoopback: false },
        policy: STRICT,
        hosts: null,
        log: () => {},
      }),
    );
    return new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port))).then((port) => {
      t.after(() => s.close());
      return port;
    });
  };
  const withStatus = await make(async () => PARTS);
  const get = (port: number, auth = true) => fetch(`http://127.0.0.1:${port}/agent/v1/status`, { headers: auth ? { authorization: 'Bearer tok' } : {} });
  assert.equal((await get(withStatus, false)).status, 403);
  const r = await get(withStatus);
  assert.equal(r.status, 200);
  assert.equal(((await r.json()) as any).claude.sessions[0].id, '0f0e0d0c');
  assert.equal((await get(await make())).status, 404);
});

const agentRead = (over: Partial<AgentRead>): AgentRead => ({ name: 'mac', url: 'http://100.64.0.5:8797', ok: true, pending: false, error: null, checkedAt: NOW - 3_000, lastOk: NOW - 3_000, failures: 0, nextAt: null, info, ports: null, status: projectStatus(PARTS, STRICT), ...over });

test('AgentsCollector: /status is read with info and ports; 404 → null without failing the agent', async () => {
  const bodies: Record<string, unknown> = {
    info,
    ports: { schema: 1, at: 1, host: 'mac', listening: [], services: [] },
    status: projectStatus(PARTS, STRICT),
  };
  let has404 = false;
  const f = (async (url: string) => {
    const what = url.split('/').pop()!;
    if (what === 'status' && has404) return new Response('{"error":"not found"}', { status: 404 });
    return new Response(JSON.stringify(bodies[what]), { status: 200 });
  }) as unknown as typeof fetch;
  const c = new AgentsCollector({ targets: () => [{ name: 'mac', url: 'http://100.64.0.5:8797' }], fetch: f, ttlMs: 0 });
  const [a] = await c.get();
  assert.equal(a.ok, true);
  assert.equal(a.status?.claude?.active, 1);
  // what the UI and the remote connector get of an agent never carries the status
  assert.equal('status' in agentStatus(a), false);
  has404 = true;
  c.refresh();
  const [b] = await c.get();
  assert.equal(b.ok, true);
  assert.equal(b.status, null);
});

const site = { host: 'vocado-dev', machines: { self: { kind: null, tags: ['always-on'], maxSessions: null }, cloud: { enabled: true, tags: ['sandbox', 'parallel'] } } };

test('buildMachines: self first, agents by name with their tags, an old agent with load only, the cloud when on', () => {
  const list = buildMachines({
    site,
    self: { ...PARTS, host: 'vocado-dev', capabilities: ['linux', 'systemd', 'dev-servers'] },
    selfId: 'vocado-dev',
    agents: [agentRead({}), agentRead({ name: 'desktop', status: null, ok: false, error: 'timeout', lastOk: NOW - 600_000, info: { ...info, host: 'desktop' } }), agentRead({ name: 'vocado-dev' })],
    targets: [{ name: 'mac', url: 'http://100.64.0.5:8797', tags: ['xcode'] }, { name: 'desktop', url: 'http://100.64.0.6:8797', kind: 'wsl', maxSessions: 2 }],
    devices: [
      { id: 'vocado-dev', name: 'vocado-dev', online: true, os: 'linux', self: true, agent: agentStatus(agentRead({ name: 'vocado-dev' })) },
      { id: 'dev-mac', name: 'dev-mac', online: true, os: 'macOS', self: false, agent: agentStatus(agentRead({})) },
      { id: 'desktop', name: 'desktop', online: false, os: 'windows', self: false, agent: null },
    ],
    now: NOW,
  });
  assert.deepEqual(list.map((m) => [m.id, m.name, m.kind, m.reach, m.online, m.stale, m.maxSessions]), [
    ['vocado-dev', 'vocado-dev', 'linux', 'local', true, false, 4],
    ['dev-mac', 'mac', 'mac', 'agent', true, false, 2],
    ['desktop', 'desktop', 'wsl', 'agent', false, true, 2],
    ['cloud', 'cloud', 'cloud', 'none', true, false, null],
  ]);
  assert.deepEqual(list[0].capabilities, ['linux', 'systemd', 'dev-servers', 'always-on']);
  assert.deepEqual(list[1].capabilities, ['macos', 'xcode']);
  assert.equal(list[2].oldAgent, true);
  assert.equal(list[2].error, 'timeout');
  assert.deepEqual(list[2].load, LOAD);
  assert.deepEqual(list[0].launch.map((l) => l.via), ['local', 'desktop-ssh', 'remote-control']);
  assert.deepEqual(list[1].launch.map((l) => l.via), ['remote-control']);
  assert.deepEqual(list[3].launch.map((l) => l.via), ['cloud', 'teleport']);
  assert.deepEqual(dataAge(list, NOW), { 'vocado-dev': 0, mac: 3, desktop: 600, cloud: null });
  assert.equal(defaultMaxSessions('cloud'), null);
  assert.equal(list[3].claude, null, 'no estimate passed');
});

test('cloudEstimate: claude/* branches as approximate sessions, open or no PR only, one per repo@branch; null without refs', () => {
  const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
  const repo = (name: string, remote: string | null, claudeBranches?: any[]) => ({ name, remote, claudeBranches }) as any;
  const est = cloudEstimate({
    repos: [
      repo('shop-web', 'git@github.com:c10dev/shop-web.git', [
        { branch: 'claude/fix-cart', at: ago(5), pr: { number: 9, state: 'OPEN' } },
        { branch: 'claude/old-idea', at: ago(CLOUD_ACTIVE_MIN + 30), pr: null },
        { branch: 'claude/shipped', at: ago(20), pr: { number: 8, state: 'MERGED' } },
        { branch: 'claude/dropped', at: ago(20), pr: { number: 7, state: 'CLOSED' } },
      ]),
      // a second clone of the same GitHub repo: its branches are the same ones
      repo('shop-web-2', 'https://github.com/c10dev/shop-web', [{ branch: 'claude/fix-cart', at: ago(5), pr: null }]),
      repo('notes', null),
    ],
  }, NOW)!;
  assert.equal(est.source, 'github');
  assert.deepEqual([est.active, est.idle], [1, 1]);
  assert.deepEqual(est.sessions.map((x) => [x.id, x.project, x.worktree, x.idleMin, x.idle]), [
    [null, 'shop-web', 'shop-web@claude/fix-cart', 5, false],
    [null, 'shop-web', 'shop-web@claude/old-idea', CLOUD_ACTIVE_MIN + 30, true],
  ]);
  assert.equal(cloudEstimate({ repos: [repo('notes', null)] }, NOW), null, 'no refs read');
  assert.equal(cloudEstimate(null, NOW), null);
  assert.deepEqual(cloudEstimate({ repos: [repo('notes', null, [])] }, NOW)?.sessions, []);
  const list = buildMachines({ site, self: { ...PARTS, host: 'vocado-dev' }, agents: [], targets: [], devices: [], cloudWork: est, now: NOW });
  assert.equal(list.at(-1)!.claude, est);
  assert.equal(list.at(-1)!.checkedAt, null, 'nothing was read from the cloud itself');
});

test('portboard.json: agents kind/tags/maxSessions, machines and recommend, bad values dropped', () => {
  assert.deepEqual(checkAgentTarget({ name: 'mac', url: 'http://mac:8797/', kind: 'mac', tags: ['Xcode', 'bad tag', 3], maxSessions: 3 }), { name: 'mac', url: 'http://mac:8797', kind: 'mac', tags: ['xcode'], maxSessions: 3 });
  assert.equal(typeof checkAgentTarget({ name: 'mac', url: 'http://mac:8797', kind: 'amiga' }), 'string');
  assert.deepEqual(checkAgentTarget({ name: 'x', url: 'http://x', maxSessions: 0 }), { name: 'x', url: 'http://x' });
  assert.deepEqual(machinesConfig(undefined), SITE_DEFAULTS.machines);
  assert.deepEqual(machinesConfig({ self: { kind: 'linux', tags: ['docker', 'always-on'], maxSessions: 6 }, cloud: { enabled: true } }), {
    self: { kind: 'linux', tags: ['docker', 'always-on'], maxSessions: 6 },
    cloud: { enabled: true, tags: SITE_DEFAULTS.machines.cloud.tags },
  });
  assert.deepEqual(recommendConfig({ weights: { mac: -0.3, prefer: 5, 'a b': 0.1 } }), { weights: { mac: -0.3 } });
  const s = resolveSite({ file: { machines: { cloud: { enabled: true, tags: ['sandbox'] } }, recommend: { weights: { locality: 0.5 } } } });
  assert.equal(s.machines.cloud.enabled, true);
  assert.deepEqual(s.recommend.weights, { locality: 0.5 });
});

test('feature: argument checks, repo named in the task, include, and the tools over a fake core', async () => {
  assert.equal(parseRunRequest({ needs: ['gpu', 'teleport'] }).ok, false);
  assert.deepEqual(parseRunRequest({ needs: 'dev-server,docker', exclude: 'mac', repo: ' shop-web ' }), { ok: true, value: { task: undefined, repo: 'shop-web', branch: undefined, needs: ['dev-server', 'docker'], prefer: undefined, exclude: ['mac'] } });
  assert.equal(parseFindQuery({}).ok, false);
  const list = buildMachines({ site: { ...site, machines: { ...site.machines, cloud: { enabled: false, tags: [] } } }, self: { ...PARTS, host: 'vocado-dev', capabilities: ['linux', 'dev-servers'] }, agents: [], targets: [], devices: [], now: NOW });
  assert.equal(repoFromTask('fix the map bug in shop-web, then check it', list), 'shop-web');
  assert.equal(repoFromTask('nothing named', list), undefined);
  const a = answerWhere({ task: 'shop-web 지도 버그', branch: 'feat-map', needs: [] }, list, NOW);
  assert.equal(a.repo, 'shop-web');
  assert.equal(a.recommendation?.machine, 'vocado-dev');
  assert.match(a.note, /does not start anything/);
  assert.deepEqual(Object.keys(shapeMachines(list, { include: ['load'] })[0]).filter((k) => ['load', 'claude', 'worktrees', 'ports'].includes(k) && (shapeMachines(list, { include: ['load'] })[0] as any)[k] !== undefined), ['load']);

  // the tools answer at the real time: a list read just now
  const live = buildMachines({ site: { ...site, machines: { ...site.machines, cloud: { enabled: false, tags: [] } } }, self: { ...PARTS, at: Date.now(), host: 'vocado-dev', capabilities: ['linux', 'dev-servers'] }, agents: [], targets: [], devices: [] });
  const core = { machines: async () => live } as unknown as Core;
  const tool = (name: string) => machinesFeature.tools!.find((x) => x.def.name === name)!;
  for (const t of machinesFeature.tools!) assert.equal(t.def.annotations.readOnlyHint, true, t.def.name);
  assert.ok(machinesFeature.tools!.every((t) => !t.remote), 'local only');
  const st = JSON.parse((await tool('machine_status').call({ machine: 'VOCADO-DEV', include: ['claude'] }, core)).content[0].text);
  assert.equal(st.machines.length, 1);
  assert.equal(st.machines[0].load, undefined);
  assert.equal((await tool('machine_status').call({ machine: 'nope' }, core)).isError, true);
  assert.equal((await tool('machine_status').call({ include: ['secrets'] }, core)).isError, true);
  const fw = JSON.parse((await tool('find_worktree').call({ query: 'feat' }, core)).content[0].text);
  assert.deepEqual(fw.matches.map((m: any) => m.owner), ['shop-web@feat-map']);
  const wr = JSON.parse((await tool('where_to_run').call({ repo: 'shop-web', branch: 'feat-map' }, core)).content[0].text);
  assert.equal(wr.recommendation.machine, 'vocado-dev');
  assert.equal((await tool('where_to_run').call({ needs: 'everything' }, core)).isError, true);
});
