// Build `portboard agent` as one executable file (Node single executable application, SEA), for a machine without
// Node (docs/multi-host.md#one-file-agent). The checkout keeps no new dependency: esbuild runs once through npx, at
// the version pinned below.
//
//   node scripts/build-agent.ts [--node <path>] [--out <path>]
//
//   --node   the Node binary to build from (default: this one). It must have SEA turned on, as the nodejs.org builds
//            do; Homebrew's does not. Its OS and CPU are the executable's: use a Linux x64 Node for a Linux x64 machine.
//   --out    the executable (default: build/portboard-agent)
//
// On macOS the executable gets an ad-hoc signature (codesign --sign -), which Apple Silicon needs to run it.

import { spawnSync } from 'node:child_process';
import { mkdirSync, openSync, readSync, closeSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ESBUILD = 'esbuild@0.25.10';
const ROOT = fileURLToPath(new URL('../', import.meta.url));

export interface Options {
  node: string;
  out: string;
}

/** argv after the script; throws with a readable message on an unknown flag or a flag without a value */
export function parseArgs(argv: readonly string[], cwd = process.cwd()): Options {
  const o: Options = { node: process.execPath, out: join(ROOT, 'build', 'portboard-agent') };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag !== '--node' && flag !== '--out') throw new Error(`unknown argument "${flag}" (use --node <path>, --out <path>)`);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`${flag} needs a path`);
    o[flag === '--node' ? 'node' : 'out'] = resolve(cwd, value);
  }
  return o;
}

/** The SEA config for `node --build-sea`: the bundle as an ES module, no warning, no code cache (it ties to one build) */
export function seaConfig(bundle: string, out: string) {
  return { main: bundle, mainFormat: 'module', output: out, disableExperimentalSEAWarning: true, useCodeCache: false };
}

/** Whether the first bytes are a 64-bit Mach-O header (either byte order): only those get codesign */
export function isMachO(head: Uint8Array): boolean {
  if (head.length < 4) return false;
  const magic = ((head[0] << 24) | (head[1] << 16) | (head[2] << 8) | head[3]) >>> 0;
  return magic === 0xfeedfacf || magic === 0xcffaedfe;
}

function firstBytes(path: string): Uint8Array {
  const fd = openSync(path, 'r');
  try {
    const buf = new Uint8Array(4);
    readSync(fd, buf, 0, 4, 0);
    return buf;
  } finally {
    closeSync(fd);
  }
}

function step(cmd: string, args: string[], what: string): string {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8' });
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  if (r.status !== 0) throw new Error(`${what} failed (exit ${r.status})${output ? `:\n${output}` : ''}`);
  return output;
}

function main(argv: readonly string[]): void {
  const o = parseArgs(argv);
  const work = join(dirname(o.out), '.agent-build');
  mkdirSync(work, { recursive: true });
  const bundle = join(work, 'agent.mjs');
  step('npx', ['--yes', ESBUILD, 'src/agent.ts', '--bundle', '--platform=node', '--target=node22', '--format=esm', `--outfile=${bundle}`, '--log-level=warning'], 'esbuild');
  const config = join(work, 'sea-config.json');
  writeFileSync(config, `${JSON.stringify(seaConfig(bundle, o.out), null, 2)}\n`);
  try {
    step(o.node, ['--build-sea', config], 'node --build-sea');
  } catch (err) {
    const msg = (err as Error).message;
    if (/single executable application is disabled|bad option: --build-sea/i.test(msg)) {
      throw new Error(`${msg}\n${o.node} cannot build a single executable. Pass --node with a nodejs.org Node that has --build-sea (Node 26 has it).`);
    }
    throw err;
  }
  if (process.platform === 'darwin' && isMachO(firstBytes(o.out))) step('codesign', ['--force', '--sign', '-', o.out], 'codesign');
  console.log(`built ${o.out}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(String((err as Error).message));
    process.exit(1);
  }
}
