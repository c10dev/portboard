// UI smoke without a browser: every page's local scripts/styles exist, every front-end module parses, and the ES module
// graph holds together (each relative import resolves to a file under public/ that exports the names imported).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { uiTags } from '../src/features/registry.ts';
import { expandShell } from '../src/core/shell.ts';

const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
const pages = readdirSync(PUBLIC).filter((f) => f.endsWith('.html'));
/** Pages with the shell: settings.html only redirects to the 설정 modal over 서비스 (public/settings.js) */
const shellPages = pages.filter((p) => p !== 'settings.html');
const modules = (readdirSync(PUBLIC, { recursive: true }) as string[]).filter((f) => f.endsWith('.js')).sort();

test('there are pages to check', () => {
  assert.ok(pages.includes('index.html') && pages.includes('devices.html'), pages.join(', '));
});

/** Scripts the server inlines into every page instead of linking them (src/core/shell.ts) */
const INLINED = ['lib/shell-boot.js'];

/** <script src> and <link href> of a page as served: the file with its shell markers expanded, plus the feature scripts */
function pageRefs(page: string): string[] {
  const html = expandShell(readFileSync(join(PUBLIC, page), 'utf8'), { hostname: 'h', boot: '' }) + uiTags(page);
  return [...html.matchAll(/<(?:script[^>]*\ssrc|link[^>]*\shref)="([^"]+)"/g)].map((m) => m[1]);
}

for (const page of pages) {
  test(`${page}: local <script src> and <link href> files exist`, () => {
    const local = pageRefs(page).filter((r) => !/^(https?:)?\/\//.test(r) && !r.startsWith('data:'));
    assert.ok(local.length > 0, `${page} references no local assets`);
    for (const ref of local) {
      const path = join(PUBLIC, ref.replace(/^\//, '').split(/[?#]/)[0]);
      assert.ok(existsSync(path), `${page} → ${ref} is missing`);
    }
  });
}

for (const js of modules) {
  test(`${js} parses`, () => {
    // --check parses without running; --input-type is unnecessary for files with a .js extension in a "type": "module" package
    execFileSync(process.execPath, ['--check', join(PUBLIC, js)], { stdio: 'pipe' });
  });
}

/** import { a, b as c } from './x.js' / import * as n from / import './x.js' → [{ spec, names }] */
function importsOf(src: string): { spec: string; names: string[] }[] {
  const out: { spec: string; names: string[] }[] = [];
  for (const m of src.matchAll(/^\s*import\s+(?:(\{[^}]*\})|\*\s+as\s+\w+|\w+)?\s*(?:from\s+)?['"]([^'"]+)['"]/gm)) {
    const names = m[1] ? m[1].slice(1, -1).split(',').map((n) => n.trim().split(/\s+as\s+/)[0]).filter(Boolean) : [];
    out.push({ spec: m[2], names });
  }
  for (const m of src.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push({ spec: m[1], names: [] });
  return out;
}

/** Names a module exports: export function / const / let / class / async function, and export { a, b as c } */
function exportsOf(src: string): Set<string> {
  const names = new Set<string>();
  for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([\w$]+)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const n = part.trim().split(/\s+as\s+/).pop();
      if (n) names.add(n);
    }
  }
  return names;
}

test('front-end modules: every relative import resolves inside public/ and exports what is imported', () => {
  const problems: string[] = [];
  let edges = 0;
  for (const js of modules) {
    const file = join(PUBLIC, js);
    for (const { spec, names } of importsOf(readFileSync(file, 'utf8'))) {
      if (!spec.startsWith('.')) { problems.push(`${js}: bare import "${spec}" (no build step, no packages)`); continue; }
      const target = join(dirname(file), spec);
      const rel = relative(PUBLIC, target);
      if (rel.startsWith('..')) { problems.push(`${js}: "${spec}" leaves public/`); continue; }
      if (!existsSync(target)) { problems.push(`${js}: "${spec}" → ${rel} is missing`); continue; }
      edges++;
      const exported = exportsOf(readFileSync(target, 'utf8'));
      for (const n of names) if (!exported.has(n)) problems.push(`${js}: ${rel} does not export ${n}`);
    }
  }
  assert.deepEqual(problems, []);
  assert.ok(edges > 20, `only ${edges} imports found: is the parser still matching?`);
});

test('front-end modules: every module is reachable from a page', () => {
  const seen = new Set<string>();
  const visit = (rel: string) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    const file = join(PUBLIC, rel);
    for (const { spec } of importsOf(readFileSync(file, 'utf8'))) visit(relative(PUBLIC, join(dirname(file), spec)));
  };
  for (const page of pages) {
    for (const ref of pageRefs(page)) if (ref.endsWith('.js')) visit(ref.replace(/^\//, ''));
  }
  // the 설정 modal's section scripts (registry page #settings), which features/settings-modal.js imports on first open
  for (const m of uiTags('#settings').matchAll(/src="([^"]+)"/g)) visit(m[1]);
  assert.deepEqual(modules.filter((m) => !seen.has(m) && !INLINED.includes(m)), [], 'modules no page loads');
  // the inlined ones really are inlined, on every page
  for (const page of shellPages) {
    const served = expandShell(readFileSync(join(PUBLIC, page), 'utf8'), { hostname: 'h' });
    for (const m of INLINED) assert.ok(served.includes(readFileSync(join(PUBLIC, m), 'utf8')), `${page} inlines ${m}`);
  }
});

test('lib/ is shared: it imports nothing from the pages or features/', () => {
  for (const js of modules.filter((m) => m.startsWith('lib/'))) {
    for (const { spec } of importsOf(readFileSync(join(PUBLIC, js), 'utf8'))) {
      assert.ok(spec.startsWith('./'), `${js} imports ${spec}`);
    }
  }
});

test('the command palette (#35) is on every page: each page reaches lib/palette.js, lib/fuzzy.js and features/palette.js', () => {
  const want = ['lib/palette.js', 'lib/fuzzy.js', 'features/palette.js'];
  for (const page of shellPages) {
    const seen = new Set<string>();
    const visit = (rel: string) => {
      if (seen.has(rel)) return;
      seen.add(rel);
      const file = join(PUBLIC, rel);
      for (const { spec } of importsOf(readFileSync(file, 'utf8'))) visit(relative(PUBLIC, join(dirname(file), spec)));
    };
    for (const ref of pageRefs(page)) if (ref.endsWith('.js')) visit(ref.replace(/^\//, ''));
    assert.deepEqual(want.filter((m) => !seen.has(m)), [], `${page} has no palette`);
  }
  assert.ok(existsSync(join(PUBLIC, 'palette.css')), 'lib/palette.js links palette.css');
});

test('the shell (docs/layout/) is on every page: each page links shell.css and reaches lib/shell.js and features/nav.js', () => {
  const want = ['lib/shell.js', 'features/nav.js'];
  for (const page of shellPages) {
    const seen = new Set<string>();
    const visit = (rel: string) => {
      if (seen.has(rel)) return;
      seen.add(rel);
      const file = join(PUBLIC, rel);
      for (const { spec } of importsOf(readFileSync(file, 'utf8'))) visit(relative(PUBLIC, join(dirname(file), spec)));
    };
    for (const ref of pageRefs(page)) if (ref.endsWith('.js')) visit(ref.replace(/^\//, ''));
    assert.deepEqual(want.filter((m) => !seen.has(m)), [], `${page} has no shell`);
    assert.ok(pageRefs(page).includes('shell.css'), `${page} does not link shell.css`);
  }
});
