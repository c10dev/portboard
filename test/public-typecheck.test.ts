// Type-checking public/ (#6): tsconfig.public.json covers every page script but checks only the files that opt in
// with `// @ts-check` on their first line (the rest of the frontend predates it). This keeps the opt-in from going
// backwards: every public/lib module opts in except the ones listed here, and `npm run test:en` stays in step with
// the test directory. `npm run typecheck:public` (CI) does the checking itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { englishFiles, KO_ONLY } from '../scripts/test-en.ts';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

/** Not yet clean under checkJs: move a file out of this list (and add the pragma) once it is. */
const LIB_UNCHECKED = ['controls.js', 'palette.js', 'shell-boot.js', 'shell.js'];

test('tsconfig.public.json: every public/ script, DOM types, opt-in checking, no output', () => {
  const cfg = JSON.parse(read('tsconfig.public.json'));
  assert.deepEqual(cfg.include, ['public/**/*.js']);
  assert.equal(cfg.compilerOptions.allowJs, true);
  assert.equal(cfg.compilerOptions.checkJs, false, 'files opt in with // @ts-check');
  assert.equal(cfg.compilerOptions.noEmit, true);
  assert.ok(cfg.compilerOptions.lib.includes('dom'));
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts['typecheck:public'], 'tsc -p tsconfig.public.json');
  assert.match(read('.github/workflows/test.yml'), /- run: npm run typecheck:public\n[\s\S]*- run: npm run test:en\n/);
});

test('public/lib: every module starts with // @ts-check except the listed ones', () => {
  const lib = readdirSync(new URL('../public/lib/', import.meta.url)).filter((f) => f.endsWith('.js')).sort();
  for (const f of LIB_UNCHECKED) assert.ok(lib.includes(f), `${f} is gone: drop it from LIB_UNCHECKED`);
  const checked = lib.filter((f) => read(`public/lib/${f}`).startsWith('// @ts-check\n'));
  assert.deepEqual(lib.filter((f) => !checked.includes(f)), LIB_UNCHECKED);
  assert.ok(checked.length >= 20, `only ${checked.length} checked`);
});

test('test:en: runs every test file but the ko-only ones, and the ko-only list names real files', () => {
  const files = englishFiles();
  assert.ok(files.includes('public-typecheck.test.ts') && files.includes('routes.test.ts'));
  for (const f of KO_ONLY) assert.ok(!files.includes(f), f);
  assert.throws(() => englishFiles(['a.test.ts']), /KO_ONLY names missing files/);
});
