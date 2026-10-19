// 메모리 (src/core/memory.ts): the reader. Every process's stat and argv (the shared /proc reader in core/proc.ts),
// meminfo, PSI, docker cgroups, and per CLI its session id (from a descendant's environ), cwd and transcript title.

import { open, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readCwd, readProcText, scanProcs } from '../proc.ts';
import { classify } from './classify.ts';
import { parseBtime, parseMeminfo, parsePsi, parseStat, sessionIdFromEnviron } from './parse.ts';
import { buildSample, type DockerRef, type MemorySample, type Proc, type SampleInput, type ServiceRef, type SessionMeta, type Thresholds } from './sample.ts';

const MIN = 60_000;

export interface ReaderOptions {
  /** /proc (tests pass a fixture directory) */
  root?: string;
  /** cgroup v2 system.slice (docker-<id>.scope lives there) */
  cgroupRoot?: string;
  /** container id (12 hex) → name */
  dockerNames?(): Promise<Map<string, string>>;
  /** a session's title (read from its transcript: asked at most every TITLE_TTL per session) */
  title?(id: string): Promise<string | null>;
  /** last write to a session's transcript, ms (a stat: asked every sample) */
  lastActive?(id: string): Promise<number | null>;
}

async function readText(path: string): Promise<string | null> {
  return readFile(path, 'utf8').catch(() => null);
}

/** Every process's stat and argv. Kernel threads (no argv) are left out. */
export function readProcs(root = '/proc'): Promise<Proc[]> {
  return scanProcs(async (pid) => {
    const [st, cmd] = await Promise.all([readProcText(pid, 'stat', root), readProcText(pid, 'cmdline', root)]);
    if (!st || !cmd) return null;
    const s = parseStat(st);
    if (!s) return null;
    const all = cmd.split('\0').filter(Boolean);
    if (!all.length) return null;
    const resume = all.map((a) => /^--resume=([0-9a-f-]{36})$/.exec(a)?.[1]).find(Boolean) ?? null;
    return { ...s, argv: all.slice(0, 6).map((a) => (a.length > 300 ? a.slice(0, 300) : a)), resume } satisfies Proc;
  }, root);
}

/** docker-<id>.scope cgroups: memory.current minus inactive file pages (what `docker stats` shows) */
export async function readDocker(cgroupRoot: string, names: Map<string, string>): Promise<DockerRef[]> {
  const dirs = (await readdir(cgroupRoot).catch(() => [] as string[])).filter((d) => /^docker-[0-9a-f]{64}\.scope$/.test(d));
  return Promise.all(
    dirs.map(async (d) => {
      const id = d.slice(7, 19);
      const [cur, st, procs] = await Promise.all([readText(join(cgroupRoot, d, 'memory.current')), readText(join(cgroupRoot, d, 'memory.stat')), readText(join(cgroupRoot, d, 'cgroup.procs'))]);
      const inactive = Number(/^inactive_file (\d+)/m.exec(st ?? '')?.[1] ?? 0);
      const bytes = Math.max(0, Number(cur ?? 0) - inactive);
      return { id, name: names.get(id) ?? id, mb: Math.round(bytes / 2 ** 20), pids: (procs ?? '').split('\n').filter(Boolean).map(Number) };
    }),
  );
}

const TITLE_MARK = Buffer.from('"customTitle":"');
const TITLE_CHUNK = 1 << 20;
/** One read buffer for every title scan (they run one at a time; a call that finds it taken makes its own) */
let titleBuf: Buffer | null = null;

/**
 * The last customTitle in a transcript, reading only the bytes from `from` on (a transcript only grows), in 1 MB
 * chunks: a 100 MB transcript isn't read again, or held, to see whether its title changed. `size` is where to start
 * next time; a file that shrank (rewritten) is read from the start.
 */
export async function scanTitle(path: string, from = 0, prev: string | null = null): Promise<{ title: string | null; size: number }> {
  const fh = await open(path, 'r').catch(() => null);
  if (!fh) return { title: prev, size: from };
  const buf = titleBuf ?? Buffer.allocUnsafe(TITLE_CHUNK);
  titleBuf = null;
  try {
    const size = (await fh.stat()).size;
    let pos = size < from ? 0 : from;
    let title = size < from ? null : prev;
    // buf[0, keep) is the tail of the previous chunk (a mark or a title cut at its end), read again with the next one
    let keep = 0;
    while (pos < size) {
      const { bytesRead } = await fh.read(buf, keep, Math.min(TITLE_CHUNK - keep, size - pos), pos);
      if (!bytesRead) break;
      pos += bytesRead;
      const len = keep + bytesRead;
      let next = Math.max(0, len - TITLE_MARK.length);
      for (let i = buf.indexOf(TITLE_MARK); i !== -1 && i < len; i = buf.indexOf(TITLE_MARK, i + 1)) {
        if (i + TITLE_MARK.length > len) break;
        const start = i + TITLE_MARK.length;
        let end = start;
        while (end < len && end - start < 4096 && !(buf[end] === 0x22 && buf[end - 1] !== 0x5c)) end++;
        if (end >= len) {
          next = i;
          break;
        }
        try {
          title = JSON.parse(`"${buf.toString('utf8', start, end)}"`);
        } catch {
          // keep the previous one
        }
        next = Math.max(next, end);
      }
      keep = pos < size ? len - next : 0;
      if (keep) buf.copy(buf, 0, next, len);
    }
    return { title, size };
  } finally {
    titleBuf = buf;
    await fh.close().catch(() => {});
  }
}

export interface Sampler {
  /** One sample (services from the port snapshot); keeps CPU ticks for the next idle check */
  sample(services: ServiceRef[], thresholds: Thresholds, now?: number): Promise<MemorySample>;
  /** Resolves when the background title lookups queued so far are done (tests, the first API answer) */
  titlesIdle(): Promise<void>;
}

/**
 * Reads /proc and groups it. Session ids are looked up once per CLI (pid + start time: a process's environment never
 * changes). Titles come from a background queue (the feature passes scanTitle: only appended bytes), one transcript
 * at a time and at most every TITLE_TTL per session: a sample never waits for them. Until a title is in, the row shows
 * its project.
 */
export function createSampler(opts: ReaderOptions = {}): Sampler {
  const root = opts.root ?? '/proc';
  const cgroupRoot = opts.cgroupRoot ?? '/sys/fs/cgroup/system.slice';
  const TITLE_TTL = 10 * MIN;
  const ids = new Map<string, string | null>();
  const cwds = new Map<string, string | null>();
  const titles = new Map<string, { at: number; title: string | null }>();
  let prevCpu: SampleInput['prevCpu'] = null;
  const wanted: string[] = [];
  let worker: Promise<void> = Promise.resolve();
  let working = false;

  function wantTitle(id: string, now: number) {
    if (!opts.title || wanted.includes(id)) return;
    const t = titles.get(id);
    if (t && now - t.at < TITLE_TTL) return;
    wanted.push(id);
    if (working) return;
    working = true;
    worker = (async () => {
      while (wanted.length) {
        const next = wanted[0];
        const title = await opts.title!(next).catch(() => null);
        titles.set(next, { at: Date.now(), title: title ?? titles.get(next)?.title ?? null });
        wanted.shift();
      }
      working = false;
    })();
  }

  async function sessionIdOf(cli: Proc, kids: Map<number, number[]>): Promise<string | null> {
    // BFS over the descendants: the first one with CLAUDE_CODE_SESSION_ID (its MCP servers, its shells)
    const queue = [...(kids.get(cli.pid) ?? [])];
    for (let n = 0; queue.length && n < 12; n++) {
      const pid = queue.shift()!;
      const env = await readProcText(pid, 'environ', root);
      const id = env ? sessionIdFromEnviron(env) : null;
      if (id) return id;
      queue.push(...(kids.get(pid) ?? []));
    }
    return null;
  }

  return {
    async sample(services, thresholds, now = Date.now()) {
      const [procs, meminfo, psiText, statText, names] = await Promise.all([
        readProcs(root),
        readText(join(root, 'meminfo')),
        readText(join(root, 'pressure', 'memory')),
        readText(join(root, 'stat')),
        opts.dockerNames ? opts.dockerNames().catch(() => new Map<string, string>()) : Promise.resolve(new Map<string, string>()),
      ]);
      if (!meminfo) throw new Error('cannot read /proc/meminfo');
      const kids = new Map<number, number[]>();
      for (const p of procs) {
        const l = kids.get(p.ppid);
        if (l) l.push(p.pid);
        else kids.set(p.ppid, [p.pid]);
      }
      const sessions = new Map<number, SessionMeta>();
      const cwdOut = new Map<number, string>();
      const live = new Set<string>();
      for (const cli of procs.filter((p) => classify(p.argv).kind === 'cli')) {
        const key = `${cli.pid}:${cli.startTicks}`;
        live.add(key);
        if (!ids.has(key) || ids.get(key) === null) ids.set(key, (await sessionIdOf(cli, kids)) ?? cli.resume);
        if (!cwds.has(key)) cwds.set(key, (await readCwd(cli.pid, root))?.path ?? null);
        const id = ids.get(key) ?? null;
        const cwd = cwds.get(key);
        if (cwd) cwdOut.set(cli.pid, cwd);
        let title: string | null = null;
        let lastActive: number | null = null;
        if (id) {
          wantTitle(id, now);
          title = titles.get(id)?.title ?? null;
          lastActive = opts.lastActive ? await opts.lastActive(id).catch(() => null) : null;
        }
        sessions.set(cli.pid, { id, title, lastActive });
      }
      for (const k of [...ids.keys()]) {
        if (live.has(k)) continue;
        ids.delete(k);
        cwds.delete(k);
      }
      const docker = await readDocker(cgroupRoot, names);
      const s = buildSample({
        at: now,
        mem: parseMeminfo(meminfo),
        psi: psiText ? parsePsi(psiText) : null,
        btime: (statText ? parseBtime(statText) : null) ?? Math.round(now / 1000),
        procs,
        docker,
        services,
        sessions,
        cwds: cwdOut,
        prevCpu,
        thresholds,
      });
      prevCpu = { at: now, ticks: new Map(Object.entries(s.cpu.ticks)) };
      return s;
    },
    titlesIdle: () => worker,
  };
}
