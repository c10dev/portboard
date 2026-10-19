// Which Bash commands start a dev server on a hard-coded port, or kill whatever holds a port (c10dev/portboard#42).
// The Claude Code plugin's PreToolUse hook (claude-plugin/hooks/port-nudge.ts) asks this before it asks Portboard
// anything, so it must be cheap and pure, and it must not fire on look-alikes: `ssh -p 22`, `docker run -p 8080:80`,
// `psql -p 5432`, git messages, comments, heredoc bodies and quoted text are not dev servers.
//
//   start  vite / next / astro / serve / http-server / nuxt, `npm|pnpm|yarn|bun [run] dev|start|preview|serve`,
//          through npx / pnpm exec / bunx, with --port N, --port=N, -p N (serve -l N), or a PORT=N prefix
//   kill   `kill $(lsof -t -i:N)`, `lsof -ti tcp:N | xargs kill`, `kill $(ss -ltnp … :N …)`, `fuser -k N/tcp`,
//          `npx kill-port N`
//
// A small shell lexer (quotes, escapes, comments, $(…) and backticks, heredocs, redirections) splits the command into
// simple commands; each is matched on its words, never on the raw text.

export type PortIntent = 'start' | 'kill';

export interface PortCommand {
  kind: PortIntent;
  port: number;
  /** What was recognised: "vite", "npm run dev", "fuser -k", "lsof | kill", … */
  tool: string;
}

type Tok = { t: 'w'; v: string } | { t: 'op'; v: string };

const SEP = new Set([';', '&', '&&', '||', '|', '|&', '(', ')', ';;', '\n']);

/** Shell words and control operators. Quoted text stays one word; `$(`/backticks open a nested group. */
export function lex(src: string): Tok[] {
  const out: Tok[] = [];
  const stack: ('top' | 'dq' | 'sub' | 'bt' | 'par')[] = ['top'];
  let word: string | null = null;
  let heredocs: { delim: string; strip: boolean }[] = [];
  const flush = () => {
    if (word !== null) out.push({ t: 'w', v: word });
    word = null;
  };
  const op = (v: string) => {
    flush();
    out.push({ t: 'op', v });
  };
  const n = src.length;
  let i = 0;
  while (i < n) {
    const mode = stack[stack.length - 1];
    const c = src[i];
    if (mode === 'dq') {
      if (c === '"') { stack.pop(); i++; continue; }
      if (c === '\\' && i + 1 < n) { word = (word ?? '') + src[i + 1]; i += 2; continue; }
      if (c === '$' && src[i + 1] === '(') { op('('); stack.push('sub'); i += 2; continue; }
      if (c === '`') { op('('); stack.push('bt'); i++; continue; }
      word = (word ?? '') + c;
      i++;
      continue;
    }
    if (c === '\n') {
      op('\n');
      i++;
      // heredoc bodies start on the next line: skip them whole
      for (const h of heredocs) {
        while (i < n) {
          const end = src.indexOf('\n', i);
          const line = src.slice(i, end < 0 ? n : end);
          i = end < 0 ? n : end + 1;
          if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) break;
        }
      }
      heredocs = [];
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') { flush(); i++; continue; }
    if (c === '#' && word === null) {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      word = (word ?? '') + src.slice(i + 1, end < 0 ? n : end);
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (c === '"') { word = word ?? ''; stack.push('dq'); i++; continue; }
    if (c === '\\') {
      if (src[i + 1] === '\n') { i += 2; continue; }
      word = (word ?? '') + (src[i + 1] ?? '');
      i += 2;
      continue;
    }
    if (c === '$' && src[i + 1] === '(') { op('('); stack.push('sub'); i += 2; continue; }
    if (c === '`') {
      if (mode === 'bt') { op(')'); stack.pop(); } else { op('('); stack.push('bt'); }
      i++;
      continue;
    }
    if (c === '(') { op('('); stack.push('par'); i++; continue; }
    if (c === ')') {
      op(')');
      if (mode === 'sub' || mode === 'par') stack.pop();
      i++;
      continue;
    }
    if (c === '<' || c === '>' || (c === '&' && src[i + 1] === '>')) {
      // a redirection; a bare fd number before it belongs to it (2>&1, 2>/dev/null)
      if (word !== null && /^\d+$/.test(word)) word = null;
      flush();
      let j = i;
      while (j < n && /[<>&|]/.test(src[j]) && j - i < 3) j++;
      if (src.slice(i, j) === '<<' && src[j] === '-') j++;
      const r = src.slice(i, j);
      if (r === '<<' || r === '<<-') {
        // heredoc: read the delimiter word (quotes stripped)
        let k = j;
        while (k < n && (src[k] === ' ' || src[k] === '\t')) k++;
        const m = /^(['"]?)([A-Za-z0-9_][A-Za-z0-9_.-]*)\1/.exec(src.slice(k));
        if (m) {
          heredocs.push({ delim: m[2], strip: r === '<<-' });
          i = k + m[0].length;
        } else i = j;
        out.push({ t: 'op', v: '>&' });
        continue;
      }
      if (r.endsWith('&') && /[\d-]/.test(src[j] ?? '')) {
        while (j < n && /[\d-]/.test(src[j])) j++;
        out.push({ t: 'op', v: '>&' }); // dup: no target word
      } else out.push({ t: 'op', v: '>' }); // the next word is the target
      i = j;
      continue;
    }
    if (c === ';' || c === '&' || c === '|') {
      let j = i + 1;
      if ((c === '&' || c === '|' || c === ';') && src[j] === c) j++;
      else if (c === '|' && src[j] === '&') j++;
      op(src.slice(i, j));
      i = j;
      continue;
    }
    word = (word ?? '') + c;
    i++;
  }
  flush();
  return out;
}

interface Segment {
  words: string[];
  /** The operator before this command ('|' for a pipe, '(' for the first command of a $(…) group) */
  after: string | null;
}

/** Simple commands, redirections dropped. */
export function segments(src: string): Segment[] {
  const out: Segment[] = [];
  let cur: string[] = [];
  let after: string | null = null;
  let skipNext = false;
  const end = (next: string) => {
    if (cur.length) out.push({ words: cur, after });
    cur = [];
    after = next;
  };
  for (const tok of lex(src)) {
    if (tok.t === 'w') {
      if (skipNext) skipNext = false;
      else cur.push(tok.v);
    } else if (tok.v === '>') skipNext = true;
    else if (tok.v === '>&') skipNext = false;
    else if (SEP.has(tok.v)) end(tok.v);
  }
  end('');
  return out;
}

// ---- simple command → program and arguments ----

const ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;
/** Wrappers that run the rest of the line: how many of their own arguments to skip */
const WRAPPERS: Record<string, (args: string[]) => number> = {
  sudo: (a) => optsEnd(a, ['-u', '-g', '-C', '-D', '-h', '-p', '-U']),
  nohup: () => 0,
  exec: (a) => optsEnd(a, ['-a']),
  setsid: (a) => optsEnd(a, []),
  nice: (a) => optsEnd(a, ['-n']),
  time: (a) => optsEnd(a, []),
  command: (a) => optsEnd(a, []),
  stdbuf: (a) => optsEnd(a, ['-i', '-o', '-e']),
  timeout: (a) => {
    const k = optsEnd(a, ['-s', '-k', '--signal', '--kill-after']);
    return a[k] !== undefined ? k + 1 : k; // the duration
  },
  env: (a) => {
    let k = optsEnd(a, ['-u', '-C', '--unset', '--chdir']);
    while (k < a.length && ASSIGN.test(a[k])) k++;
    return k;
  },
  'systemd-run': (a) => optsEnd(a, ['-u', '--unit', '-p', '--property', '-E', '--setenv', '--working-directory', '-M', '--machine', '--description', '--slice', '--uid', '--gid', '--nice', '-H', '--host']),
};

/** Index of the first non-option word (options in `withValue` take the next word) */
function optsEnd(a: string[], withValue: string[]): number {
  let k = 0;
  while (k < a.length && a[k].startsWith('-') && a[k] !== '-') {
    if (a[k] === '--') return k + 1;
    if (withValue.includes(a[k])) k++;
    k++;
  }
  return k;
}

const base = (w: string) => w.slice(w.lastIndexOf('/') + 1);

/** env assignments in front of the program, and the program's words (wrappers peeled off) */
export function peel(words: string[]): { env: Record<string, string>; argv: string[] } {
  const env: Record<string, string> = {};
  let w = words;
  for (let guard = 0; guard < 8; guard++) {
    let k = 0;
    while (k < w.length && ASSIGN.test(w[k])) {
      const m = ASSIGN.exec(w[k])!;
      env[m[1]] = m[2];
      k++;
    }
    w = w.slice(k);
    const wrap = w.length ? WRAPPERS[base(w[0])] : undefined;
    if (!wrap) break;
    if (base(w[0]) === 'env') {
      for (const a of w.slice(1)) {
        const m = ASSIGN.exec(a);
        if (m) env[m[1]] = m[2];
      }
    }
    w = w.slice(1 + wrap(w.slice(1)));
  }
  return { env, argv: w };
}

// ---- start ----

const PORT_RE = /^\d{1,5}$/;
const asPort = (s: string | undefined): number | null => {
  if (s === undefined || !PORT_RE.test(s)) return null;
  const p = Number(s);
  return p >= 1 && p <= 65535 ? p : null;
};

/** Dev-server programs and the flags they take a port with */
const SERVERS: Record<string, { flags: string[]; sub?: string[] }> = {
  vite: { flags: ['--port'] },
  next: { flags: ['--port', '-p'], sub: ['dev', 'start'] },
  astro: { flags: ['--port'], sub: ['dev', 'preview'] },
  nuxt: { flags: ['--port', '-p'], sub: ['dev', 'preview', 'start'] },
  nuxi: { flags: ['--port', '-p'], sub: ['dev', 'preview'] },
  serve: { flags: ['--listen', '-l', '--port', '-p'] },
  'http-server': { flags: ['--port', '-p'] },
  'webpack-dev-server': { flags: ['--port'] },
  'react-scripts': { flags: [], sub: ['start'] },
  'svelte-kit': { flags: ['--port'], sub: ['dev', 'preview'] },
  remix: { flags: ['--port'], sub: ['dev'] },
  'wrangler': { flags: ['--port'], sub: ['dev'] },
};
const PKG = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const SCRIPTS = new Set(['dev', 'start', 'preview', 'serve']);
/** package-manager options that take a value before the script name */
const PKG_VALUE = ['-C', '--dir', '--filter', '-F', '--prefix', '--workspace', '-w', '--cwd'];
/** plain runtimes: only a PORT=N prefix counts (`node -p` prints, it is no port) */
const RUNTIMES = new Set(['node', 'tsx', 'ts-node', 'deno', 'bun', 'python', 'python3', 'uvicorn', 'flask', 'gunicorn', 'rails']);

/** --port N, --port=N, -p N, -pN (when -p is the program's port flag) */
function portFlag(args: string[], flags: string[]): number | null {
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    for (const f of flags) {
      if (a === f) {
        const v = args[k + 1];
        const p = asPort(v) ?? asPort(/^(?:tcp:\/\/)?(?:[\w.-]*:)?(\d{1,5})$/.exec(v ?? '')?.[1]);
        if (p) return p;
      } else if (a.startsWith(`${f}=`)) {
        const p = asPort(a.slice(f.length + 1));
        if (p) return p;
      } else if (f.length === 2 && a.startsWith(f) && PORT_RE.test(a.slice(2))) {
        const p = asPort(a.slice(2));
        if (p) return p;
      }
    }
  }
  return null;
}

function startOf(words: string[]): PortCommand | null {
  const { env, argv } = peel(words);
  if (!argv.length) return null;
  const envPort = asPort(env.PORT);
  let prog = base(argv[0]);
  let args = argv.slice(1);
  let label = prog;

  // npx vite, pnpm exec vite, pnpm dlx serve, bunx vite, yarn vite, npm exec -- vite
  if (prog === 'npx' || prog === 'bunx' || prog === 'pnpx') {
    const k = optsEnd(args, ['-p', '--package']);
    prog = base(args[k] ?? '');
    args = args.slice(k + 1);
    label = prog;
  } else if (PKG.has(prog)) {
    const pm = prog;
    let k = optsEnd(args, PKG_VALUE);
    let verb = args[k];
    if (verb === 'exec' || verb === 'dlx' || verb === 'x') {
      const j = k + 1 + optsEnd(args.slice(k + 1), []);
      prog = base(args[j] ?? '');
      args = args.slice(j + 1);
      label = prog;
    } else {
      let ran = false;
      if (verb === 'run' || verb === 'run-script') {
        k = k + 1 + optsEnd(args.slice(k + 1), PKG_VALUE);
        verb = args[k];
        ran = true;
      }
      if (verb && SCRIPTS.has(verb) && (ran || pm !== 'npm' || verb === 'start')) {
        const rest = args.slice(k + 1);
        const p = portFlag(rest, ['--port', '-p']) ?? envPort;
        return p ? { kind: 'start', port: p, tool: `${pm} ${ran ? 'run ' : ''}${verb}` } : null;
      }
      if (verb && !ran && pm !== 'npm' && SERVERS[verb]) {
        prog = verb;
        args = args.slice(k + 1);
        label = `${pm} ${verb}`;
      } else return null;
    }
  }

  const server = SERVERS[prog];
  if (server) {
    if (server.sub) {
      const k = optsEnd(args, []);
      if (!server.sub.includes(args[k] ?? '')) return null;
      label = `${label} ${args[k]}`;
      args = args.slice(k + 1);
    }
    const p = portFlag(args, server.flags) ?? (prog === 'serve' ? asPort(args.find((a) => PORT_RE.test(a))) : null) ?? envPort;
    return p ? { kind: 'start', port: p, tool: label } : null;
  }
  // python -m http.server 8000
  if ((prog === 'python' || prog === 'python3') && args[0] === '-m' && args[1] === 'http.server') {
    const p = asPort(args.slice(2).find((a) => PORT_RE.test(a))) ?? 8000;
    return { kind: 'start', port: p, tool: 'python -m http.server' };
  }
  if (RUNTIMES.has(prog) && envPort) return { kind: 'start', port: envPort, tool: `PORT=${envPort} ${prog}` };
  return null;
}

// ---- kill ----

/** lsof -i:N, -ti tcp:N, -iTCP:N -sTCP:LISTEN */
function lsofPort(args: string[]): number | null {
  for (let k = 0; k < args.length; k++) {
    const m = /^-[A-Za-z]*i(.*)$/.exec(args[k]);
    if (!m) continue;
    const spec = m[1] || args[k + 1] || '';
    const p = /^(?:tcp|udp|TCP|UDP)?[46]?(?:@[^:]*)?:(\d{1,5})(?:-\d+)?$/.exec(spec);
    if (p) return asPort(p[1]);
  }
  return null;
}

/** fuser N/tcp, fuser -n tcp N */
function fuserPort(args: string[]): number | null {
  for (const a of args) {
    const m = /^(\d{1,5})\/(?:tcp|udp)$/.exec(a);
    if (m) return asPort(m[1]);
  }
  const n = args.indexOf('-n');
  if (n >= 0 && /^(tcp|udp)$/.test(args[n + 1] ?? '')) return asPort(args.slice(n + 2).find((a) => PORT_RE.test(a)));
  return null;
}

/** ss/netstat filters and the grep after them: ':3000', 'sport = :3000', grep -w 3000 */
function portInText(args: string[], bare: boolean): number | null {
  for (const a of args) {
    if (a.startsWith('-')) continue;
    const m = /:(\d{2,5})\b/.exec(a) ?? (bare ? /^(\d{2,5})\b/.exec(a) : null);
    if (m) {
      const p = asPort(m[1]);
      if (p) return p;
    }
  }
  return null;
}

const isKill = (argv: string[]): boolean => {
  const prog = base(argv[0] ?? '');
  if (prog === 'kill') return true;
  if (prog === 'xargs') {
    const k = optsEnd(argv.slice(1), ['-I', '-n', '-P', '-L', '-d', '-s', '-a', '-E']);
    return base(argv[1 + k] ?? '') === 'kill';
  }
  return false;
};

function killsOf(segs: { argv: string[]; after: string | null }[]): PortCommand[] {
  const out: PortCommand[] = [];
  const killing = segs.some((s) => isKill(s.argv));
  for (let k = 0; k < segs.length; k++) {
    const { argv } = segs[k];
    const prog = base(argv[0] ?? '');
    const args = argv.slice(1);
    if (prog === 'fuser') {
      const p = fuserPort(args);
      const k9 = args.some((a) => a === '--kill' || /^-[A-Za-z]*k/.test(a));
      if (p && (k9 || killing)) out.push({ kind: 'kill', port: p, tool: 'fuser -k' });
    } else if (prog === 'kill-port') {
      for (const a of args) {
        const p = asPort(a);
        if (p) out.push({ kind: 'kill', port: p, tool: 'kill-port' });
      }
    } else if (killing && prog === 'lsof') {
      const p = lsofPort(args);
      if (p) out.push({ kind: 'kill', port: p, tool: 'lsof | kill' });
    } else if (killing && (prog === 'ss' || prog === 'netstat')) {
      // the port is in ss's own filter, or in a grep it pipes into
      let p = portInText(args, false);
      for (let j = k + 1; !p && j < segs.length && segs[j].after === '|'; j++) {
        if (base(segs[j].argv[0] ?? '') === 'grep') p = portInText(segs[j].argv.slice(1), true);
      }
      if (p) out.push({ kind: 'kill', port: p, tool: `${prog} | kill` });
    }
  }
  return out;
}

/** Every hard-coded dev-server port and kill-by-port in a Bash command, in order, without duplicates. */
export function parsePortCommands(command: string): PortCommand[] {
  if (typeof command !== 'string' || command.length > 20_000) return [];
  const segs = segments(command).map((s) => ({ ...peel(s.words), after: s.after }));
  const found: PortCommand[] = [];
  for (const s of segs) {
    // npx kill-port 3000
    const prog = base(s.argv[0] ?? '');
    const argv = prog === 'npx' || prog === 'bunx' ? s.argv.slice(1 + optsEnd(s.argv.slice(1), ['-p', '--package'])) : s.argv;
    if (base(argv[0] ?? '') === 'kill-port') continue; // counted with the kills
    // sh -c "…": look inside
    if (/^(ba|z|da)?sh$/.test(prog)) {
      const c = s.argv.indexOf('-c');
      if (c > 0 && s.argv[c + 1]) found.push(...parsePortCommands(s.argv[c + 1]));
      continue;
    }
    const st = startOf([...Object.entries(s.env).map(([k, v]) => `${k}=${v}`), ...s.argv]);
    if (st) found.push(st);
  }
  const kills = killsOf(
    segs.map((s) => {
      const prog = base(s.argv[0] ?? '');
      return prog === 'npx' || prog === 'bunx' ? { ...s, argv: s.argv.slice(1 + optsEnd(s.argv.slice(1), ['-p', '--package'])) } : s;
    }),
  );
  const all = [...kills, ...found];
  const seen = new Set<string>();
  return all.filter((c) => {
    const key = `${c.kind}:${c.port}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Cheap prefilter for the hook: false means parsePortCommands would find nothing. */
export function mayMentionPort(command: string): boolean {
  return /\d{2,5}/.test(command) && /(port|PORT|-p|-l|vite|next|astro|serve|kill|fuser|lsof|http\.server)/.test(command);
}
