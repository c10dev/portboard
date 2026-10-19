// Pure decisions for scripts/deploy.ts (no I/O, unit-tested in test/deploy.test.ts):
// which units a diff restarts, whether the smoke results pass, whether to roll back, and the CLI flags.

export type Unit = 'portboard' | 'portboard-remote';
export const UNITS: readonly Unit[] = ['portboard', 'portboard-remote'];

export interface ChangePlan {
  units: Unit[];
  /** unit → the changed paths that make it restart (first few, for the summary line) */
  reasons: Record<Unit, string[]>;
  /** deploy/*.service changed: the installed copies need a manual cp + daemon-reload */
  unitFiles: string[];
}

// Which runtime a path belongs to. src/core, src/version.ts and package.json are shared, and so are the feature
// modules (src/features/, #21): the dashboard loads them too, and with them src/mcp/ and the two src/remote/ files
// they import. The rest of src/remote/ is the remote's; the stdio server src/mcp.ts is started per client, not by a unit.
// Anything under src/ that no rule names restarts both, so a new folder is never missed.
const REMOTE_SHARED = new Set(['src/remote/core.ts', 'src/remote/redact.ts']);
export function unitsForPath(path: string): Unit[] {
  if (path === 'src/server.ts' || path.startsWith('public/')) return ['portboard'];
  if (path === 'src/remote.ts' || (path.startsWith('src/remote/') && !REMOTE_SHARED.has(path))) return ['portboard-remote'];
  if (path === 'src/mcp.ts') return [];
  if (path.startsWith('src/') || path === 'package.json') return ['portboard', 'portboard-remote'];
  return []; // docs, test, scripts, menubar, bin, deploy, README/CHANGELOG/ROADMAP
}

export function planRestart(changed: readonly string[]): ChangePlan {
  const reasons: Record<Unit, string[]> = { portboard: [], 'portboard-remote': [] };
  for (const p of changed) for (const u of unitsForPath(p)) reasons[u].push(p);
  return {
    units: UNITS.filter((u) => reasons[u].length > 0),
    reasons,
    unitFiles: changed.filter((p) => p.startsWith('deploy/') && p.endsWith('.service')),
  };
}

/** --restart override: auto (from the diff), all, none, or one unit */
export function applyOverride(plan: ChangePlan, restart: Restart): Unit[] {
  if (restart === 'auto') return plan.units;
  if (restart === 'all') return [...UNITS];
  if (restart === 'none') return [];
  return [restart];
}

/**
 * The units to restart, with a note when the diff can't be trusted. Without deployed.json the previous deploy is a
 * guess (origin/main); if that guess is HEAD itself (pushed by hand before the first run) the running code is unknown,
 * so auto restarts both rather than nothing.
 */
export function chooseUnits(i: { plan: ChangePlan; restart: Restart; previous: string | null; head: string; guessed: boolean }): { units: Unit[]; note?: string } {
  if (i.restart !== 'auto') return { units: applyOverride(i.plan, i.restart) };
  if (!i.previous) return { units: [...UNITS], note: '이전 배포 커밋을 몰라 두 유닛 모두 재시작' };
  if (i.guessed && i.previous === i.head) return { units: [...UNITS], note: 'deployed.json 없음 · origin/main == HEAD라 무엇이 돌고 있는지 모름 → 두 유닛 모두 재시작' };
  return { units: i.plan.units };
}

export interface Check {
  name: string;
  ok: boolean;
  /** short, never a response body or a secret */
  detail?: string;
}

export interface SmokeSummary {
  ok: boolean;
  passed: number;
  failed: Check[];
}

export function evaluate(checks: readonly Check[]): SmokeSummary {
  const failed = checks.filter((c) => !c.ok);
  // No checks at all is a failure too: something upstream broke before anything was measured.
  return { ok: checks.length > 0 && failed.length === 0, passed: checks.length - failed.length, failed };
}

export type Decision =
  | { action: 'push' }
  | { action: 'done' } // success, but --no-push or --dry-run
  | { action: 'abort'; reason: string } // production untouched or nothing to go back to
  | { action: 'rollback'; to: string };

export interface DecisionInput {
  dryRun: boolean;
  noPush: boolean;
  testsOk: boolean;
  restarted: readonly Unit[];
  smoke: SmokeSummary | null;
  previous: string | null;
  head: string;
}

export function decide(i: DecisionInput): Decision {
  if (!i.testsOk) return { action: 'abort', reason: '테스트 실패 — 재시작하지 않음' };
  if (!i.smoke) return { action: 'abort', reason: '스모크 체크를 하지 못함' };
  if (i.smoke.ok) return i.dryRun || i.noPush ? { action: 'done' } : { action: 'push' };
  if (i.dryRun) return { action: 'abort', reason: 'dry-run: 운영 서버가 체크를 통과하지 못함 (재시작 안 함)' };
  if (i.restarted.length === 0) return { action: 'abort', reason: '재시작한 유닛이 없으니 이번 배포 탓이 아님 — 롤백하지 않음' };
  if (!i.previous) return { action: 'abort', reason: '이전 배포 커밋을 몰라 롤백할 수 없음' };
  if (i.previous === i.head) return { action: 'abort', reason: '이전 배포 커밋과 같은 커밋이라 롤백할 곳이 없음' };
  return { action: 'rollback', to: i.previous };
}

export interface Deployed {
  commit: string;
  at: string;
  restarted: Unit[];
}

export function parseDeployed(text: string | null): Deployed | null {
  if (!text) return null;
  try {
    const d = JSON.parse(text);
    if (typeof d?.commit !== 'string' || !/^[0-9a-f]{40}$/.test(d.commit)) return null;
    return { commit: d.commit, at: String(d.at ?? ''), restarted: Array.isArray(d.restarted) ? d.restarted.filter((u: unknown) => UNITS.includes(u as Unit)) : [] };
  } catch {
    return null;
  }
}

export type Restart = 'auto' | 'all' | 'none' | Unit;

export interface Options {
  dryRun: boolean;
  noPush: boolean;
  restart: Restart;
  help: boolean;
}

export function parseArgs(argv: readonly string[]): Options | string {
  const o: Options = { dryRun: false, noPush: false, restart: 'auto', help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run' || a === '-n') o.dryRun = true;
    else if (a === '--no-push') o.noPush = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else if (a === '--restart' || a.startsWith('--restart=')) {
      const v = a.includes('=') ? a.slice(a.indexOf('=') + 1) : argv[++i];
      const map: Record<string, Restart> = { auto: 'auto', all: 'all', both: 'all', none: 'none', portboard: 'portboard', remote: 'portboard-remote', 'portboard-remote': 'portboard-remote' };
      if (!v || !map[v]) return `--restart 값은 auto | all | none | portboard | remote (받은 값: ${v ?? '없음'})`;
      o.restart = map[v];
    } else return `모르는 옵션: ${a}`;
  }
  return o;
}

export const short = (sha: string | null) => (sha ? sha.slice(0, 7) : '—');

/** "src/server.ts, public/app.js 외 3개" */
export function listPaths(paths: readonly string[], max = 3): string {
  return paths.length <= max ? paths.join(', ') : `${paths.slice(0, max).join(', ')} 외 ${paths.length - max}개`;
}
