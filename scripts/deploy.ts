// One-command deploy from the main checkout: npm test → restart the units whose code changed → live smoke checks →
// git push. On a failed smoke check it checks out the previously deployed commit (detached, history untouched),
// restarts, re-checks and exits non-zero. See docs/operations.md "Deploy".
//
//   scripts/deploy.sh                 # test, restart, check, push
//   scripts/deploy.sh --dry-run       # test and check what is running now; no restart, no push, no state written
//   scripts/deploy.sh --no-push       # everything but the push
//   scripts/deploy.sh --restart all   # auto (default) | all | none | portboard | remote
//
// Every module is imported statically: a rollback checks out an older tree under this running process, and nothing
// may be loaded from disk after that.

import { spawn, spawnSync } from 'node:child_process';
import { closeSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync, writeSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chooseUnits, decide, evaluate, listPaths, parseArgs, parseDeployed, planRestart, short, UNITS, type Check, type Deployed, type Unit } from './deploy-plan.ts';
import { describeSecrets, loadSecrets, PUBLIC_DEFAULT, runSmoke } from './deploy-smoke.ts';

const USAGE = `사용법: scripts/deploy.sh [--dry-run] [--no-push] [--restart auto|all|none|portboard|remote]
  --dry-run   테스트와 스모크 체크만 (재시작·push·상태 기록 없음, 브랜치/작업 트리 검사는 경고만)
  --no-push   push 직전에 멈춤
  --restart   기본 auto: 바뀐 파일로 재시작할 유닛을 고름`;

const STATE_DIR = join(homedir(), '.local/state/portboard');
const DEPLOYED = join(STATE_DIR, 'deployed.json');
const LOCK = join(STATE_DIR, 'deploy.lock');
const t0 = Date.now();

const opts = parseArgs(process.argv.slice(2));
if (typeof opts === 'string') fail(2, `${opts}\n${USAGE}`);
if (opts.help) {
  console.log(USAGE);
  process.exit(0);
}

const root = git(['rev-parse', '--show-toplevel'], dirname(fileURLToPath(import.meta.url))).out;
const head = git(['rev-parse', 'HEAD']).out;
const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).out;

// ---- preflight ----
const problems: string[] = [];
if (branch !== 'main') problems.push(`브랜치가 main이 아님 (${branch})`);
if (git(['status', '--porcelain']).out) problems.push('작업 트리에 커밋 안 된 변경이 있음');
for (const u of UNITS) {
  const wd = sh('systemctl', ['--user', 'show', '-p', 'WorkingDirectory', '--value', u]).out;
  if (!wd || real(wd) !== real(root)) problems.push(`${u}는 ${wd || '(알 수 없음)'}에서 돌고 있음 — 이 체크아웃(${root})이 아님`);
}
if (problems.length && !opts.dryRun) fail(2, `배포 거부:\n${problems.map((p) => `  - ${p}`).join('\n')}`);

if (!opts.dryRun) takeLock();

// ---- previous deploy and what changed ----
const deployed = parseDeployed(readText(DEPLOYED));
let previous: string | null = null;
let previousFrom = '';
const deployedOk = !!deployed && isCommit(deployed.commit);
if (deployed && deployedOk) {
  previous = deployed.commit;
  previousFrom = `deployed.json, ${deployed.at.slice(0, 16).replace('T', ' ')}`;
} else {
  // Before this script, every manual deploy ended with a push, so origin/main is what is running.
  const up = git(['rev-parse', '--verify', '--quiet', 'origin/main']);
  if (up.ok && up.out) {
    previous = up.out;
    previousFrom = 'deployed.json 없음 → origin/main 기준';
  }
}

const changed = previous ? git(['diff', '--name-only', previous, 'HEAD']).out.split('\n').filter(Boolean) : [];
const plan = planRestart(changed);
const { units, note } = chooseUnits({ plan, restart: opts.restart, previous, head, guessed: !!previous && !deployedOk });

console.log(`portboard 배포 · ${short(previous)} → ${short(head)} (${branch})${opts.dryRun ? ' · dry-run' : ''}${opts.noPush ? ' · no-push' : ''}`);
console.log(`  이전 배포: ${previous ? `${short(previous)} (${previousFrom})` : '모름 — 두 유닛 모두 재시작'}`);
for (const p of problems) console.log(`  경고: ${p} (dry-run이라 계속)`);
console.log(`  변경 ${changed.length}개 파일`);
for (const u of UNITS) {
  const why = plan.reasons[u];
  const verb = opts.dryRun ? (units.includes(u) ? '재시작할 것' : '재시작 안 할 것') : units.includes(u) ? '재시작' : '재시작 안 함';
  const reason = units.includes(u) ? (why.length ? listPaths(why) : note ? '아래 주의 참고' : `--restart ${opts.restart}`) : why.length ? `--restart ${opts.restart}` : '해당 코드 변경 없음';
  console.log(`  ${u}: ${verb} (${reason})`);
}
if (note) console.log(`  주의: ${note}`);
if (plan.unitFiles.length) console.log(`  주의: ${plan.unitFiles.join(', ')} 변경 — 설치본은 수동으로 cp + systemctl --user daemon-reload 해야 함`);

// ---- tests ----
const tests = await npmTest();
line({ name: 'npm test', ok: tests.ok, detail: tests.detail });
if (!tests.ok) {
  console.log(tests.tail);
  await finish(decide({ dryRun: opts.dryRun, noPush: opts.noPush, testsOk: false, restarted: [], smoke: null, previous, head }));
}

// ---- restart and smoke ----
const restarted = opts.dryRun ? [] : units;
const pre: Check[] = [];
if (restarted.length) {
  const r = sh('systemctl', ['--user', 'restart', ...restarted]);
  pre.push({ name: `systemctl restart ${restarted.join(' ')}`, ok: r.ok, detail: r.ok ? undefined : r.err.split('\n')[0] });
  line(pre[0]);
}
const secrets = await loadSecrets();
console.log(`  비밀값 ${secrets.length}개 로드 (${describeSecrets(secrets)}) — 값은 출력하지 않음`);
const checks = [...pre, ...(await runSmoke({ restarted, publicUrl: publicUrl(), log: line }))];
const smoke = evaluate(checks);
const decision = decide({ dryRun: opts.dryRun, noPush: opts.noPush, testsOk: true, restarted, smoke, previous, head });
await finish(decision, smoke);

// ---- helpers ----

async function finish(d: ReturnType<typeof decide>, smoke?: ReturnType<typeof evaluate>): Promise<never> {
  const took = `${((Date.now() - t0) / 1000).toFixed(1)}s`;
  const tally = smoke ? `체크 ${smoke.passed + smoke.failed.length}개 중 ${smoke.passed}개 통과` : '';
  if (d.action === 'abort') {
    if (smoke && !smoke.ok) console.log(`결과: ${tally}, 실패 ${smoke.failed.map((c) => c.name).join(', ')}`);
    console.log(`중단: ${d.reason} · push 안 함 · ${took}`);
    process.exit(1);
  }
  if (d.action === 'done') {
    if (!opts.dryRun) recordDeploy(head);
    console.log(`결과: ${tally}${opts.dryRun ? ' · dry-run이라 재시작·push·기록 없음' : ` · ${short(head)} 배포 기록 · --no-push라 push 안 함`} · ${took}`);
    process.exit(0);
  }
  if (d.action === 'push') {
    recordDeploy(head);
    const p = git(['push', 'origin', 'main']);
    if (!p.ok) {
      console.log(`결과: ${tally} · 배포는 됨 (${short(head)} 기록), 하지만 push 실패: ${p.err.split('\n').slice(-2).join(' ')} · ${took}`);
      process.exit(1);
    }
    console.log(`결과: ${tally} · ${short(head)} 배포 · origin/main push 완료 · ${took}`);
    process.exit(0);
  }
  return rollback(d.to, smoke!);
}

async function rollback(to: string, first: ReturnType<typeof evaluate>): Promise<never> {
  console.log(`롤백: 실패 ${first.failed.length}개 (${first.failed.map((c) => c.name).join(', ')}) → ${short(to)}로 되돌림 (detached checkout, 히스토리는 그대로)`);
  const co = git(['checkout', '--quiet', '--detach', to]);
  if (!co.ok) {
    console.log(`롤백 실패: git checkout ${short(to)} — ${co.err.split('\n')[0]}`);
    console.log(`결과: ${short(head)} 배포 실패, 롤백도 못 함 · 운영 서버 확인 필요 · push 안 함`);
    process.exit(1);
  }
  const r = sh('systemctl', ['--user', 'restart', ...restarted]);
  const pre: Check = { name: `systemctl restart ${restarted.join(' ')}`, ok: r.ok, detail: r.ok ? undefined : r.err.split('\n')[0] };
  line(pre);
  const second = evaluate([pre, ...(await runSmoke({ restarted, publicUrl: publicUrl(), log: line }))]);
  if (second.ok) recordDeploy(to);
  console.log('결과:');
  console.log(`  ${short(head)} 배포: 체크 ${first.passed + first.failed.length}개 중 ${first.passed}개 통과 — 실패 ${first.failed.map((c) => c.name).join(', ')}`);
  console.log(`  ${short(to)} 롤백: 체크 ${second.passed + second.failed.length}개 중 ${second.passed}개 통과${second.ok ? '' : ` — 실패 ${second.failed.map((c) => c.name).join(', ')}`}`);
  console.log(`  push 안 함. ${root}는 ${short(to)}에 detached 상태 — 고친 뒤: git checkout main && scripts/deploy.sh`);
  process.exit(1);
}

function recordDeploy(commit: string) {
  const d: Deployed = { commit, at: new Date().toISOString(), restarted: [...restarted] };
  mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${DEPLOYED}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(d, null, 2) + '\n');
  renameSync(tmp, DEPLOYED);
}

function line(c: Check) {
  console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
}

function npmTest(): Promise<{ ok: boolean; detail: string; tail: string }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const p = spawn('npm', ['test', '--silent'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (c) => (out += c));
    p.stderr.on('data', (c) => (out += c));
    p.on('close', (code) => {
      // tap ("# pass 226") or spec ("ℹ pass 226") reporter
      const n = (k: string) => Number(new RegExp(`^(?:# |ℹ )${k} (\\d+)`, 'm').exec(out)?.[1] ?? NaN);
      const pass = n('pass');
      const failed = n('fail');
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      const detail = Number.isNaN(pass) ? `종료 코드 ${code} · ${secs}s` : `${pass}개 통과${failed ? `, ${failed}개 실패` : ''} · ${secs}s`;
      resolve({ ok: code === 0, detail, tail: out.trimEnd().split('\n').slice(-30).join('\n') });
    });
  });
}

function publicUrl(): string {
  try {
    const u = JSON.parse(readFileSync(join(homedir(), '.config/portboard/remote.json'), 'utf8')).publicUrl;
    return typeof u === 'string' && u.startsWith('https://') ? u : PUBLIC_DEFAULT;
  } catch {
    return PUBLIC_DEFAULT;
  }
}

function takeLock() {
  mkdirSync(STATE_DIR, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(LOCK, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      process.on('exit', () => {
        try {
          unlinkSync(LOCK);
        } catch {}
      });
      return;
    } catch {
      const pid = Number(readText(LOCK));
      if (pid && alive(pid)) fail(2, `배포 거부: 다른 배포가 진행 중 (pid ${pid}, ${LOCK})`);
      try {
        unlinkSync(LOCK); // stale: its process is gone
      } catch {}
    }
  }
  fail(2, `배포 거부: ${LOCK}를 만들 수 없음`);
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function git(args: string[], cwd = root) {
  return sh('git', args, cwd);
}

function sh(cmd: string, args: string[], cwd: string = root ?? process.cwd()) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() || (r.error?.message ?? '') };
}

function isCommit(sha: string) {
  return git(['cat-file', '-e', `${sha}^{commit}`]).ok;
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function real(p: string) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function fail(code: number, msg: string): never {
  console.error(msg);
  process.exit(code);
}
