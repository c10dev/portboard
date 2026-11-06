// scripts/build-agent.ts (the one-file agent, docs/multi-host.md#one-file-agent) and what a bundle of the code
// needs: no file read next to the code at import (c10dev/portboard#37).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isMachO, parseArgs, seaConfig } from '../scripts/build-agent.ts';

test('parseArgs: defaults, paths against the cwd, and readable errors', () => {
  const d = parseArgs([]);
  assert.equal(d.node, process.execPath);
  assert.match(d.out, /\/build\/portboard-agent$/);
  assert.deepEqual(parseArgs(['--node', 'n/bin/node', '--out', '/tmp/pa'], '/w'), { node: '/w/n/bin/node', out: '/tmp/pa' });
  assert.throws(() => parseArgs(['--target', 'x']), /unknown argument "--target"/);
  assert.throws(() => parseArgs(['--node']), /--node needs a path/);
  assert.throws(() => parseArgs(['--out', '--node', 'x']), /--out needs a path/);
});

test('seaConfig: an ES module main, no warning, no code cache', () => {
  assert.deepEqual(seaConfig('/b/agent.mjs', '/o/pa'), {
    main: '/b/agent.mjs',
    mainFormat: 'module',
    output: '/o/pa',
    disableExperimentalSEAWarning: true,
    useCodeCache: false,
  });
});

test('isMachO: 64-bit Mach-O in either byte order; ELF, PE and short input are not', () => {
  assert.equal(isMachO(Uint8Array.of(0xcf, 0xfa, 0xed, 0xfe)), true);
  assert.equal(isMachO(Uint8Array.of(0xfe, 0xed, 0xfa, 0xcf)), true);
  assert.equal(isMachO(Uint8Array.of(0x7f, 0x45, 0x4c, 0x46)), false);
  assert.equal(isMachO(Uint8Array.of(0x4d, 0x5a, 0x90, 0x00)), false);
  assert.equal(isMachO(Uint8Array.of(0xcf, 0xfa)), false);
});

test('i18n catalogs are static JSON imports, not a file read next to the code (#37)', () => {
  const src = readFileSync(new URL('../src/core/i18n.ts', import.meta.url), 'utf8');
  for (const locale of ['en', 'ko']) {
    assert.match(src, new RegExp(`import ${locale} from '\\.\\./\\.\\./public/i18n/${locale}\\.json' with \\{ type: 'json' \\};`));
  }
  assert.doesNotMatch(src, /readFileSync|import\.meta\.url/, 'a single executable has no public/ folder');
});
