// The public tree (scripts/public-tree.sh) leaves out the paths in scripts/public-exclude.txt. Whatever stays must not
// point into them: relative links in markdown, and docs URLs the dashboard and the MCP servers hand out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EXCLUDE = readFileSync(join(ROOT, 'scripts/public-exclude.txt'), 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'));

/** A repo path matches an exclude line: a directory prefix (dir/), a *.ext glob in one directory, or the path itself */
export function excluded(path: string, rules = EXCLUDE): boolean {
  const p = path.replace(/^\.\//, '');
  return rules.some((r) => {
    if (r.endsWith('/')) return p === r.slice(0, -1) || p.startsWith(r);
    const star = r.indexOf('*');
    if (star >= 0) return p.startsWith(r.slice(0, star)) && p.endsWith(r.slice(star + 1)) && !p.slice(star, p.length - (r.length - star - 1)).includes('/');
    return p === r;
  });
}

// git ls-files when this is a checkout; the public tree's own files otherwise (a tarball has no .git)
function files(): string[] {
  try {
    return execFileSync('git', ['-C', ROOT, 'ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch {
    return execFileSync('find', ['.', '-type', 'f', '-not', '-path', './node_modules/*'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n').filter(Boolean).map((f) => f.replace(/^\.\//, ''));
  }
}

const PUBLIC = files().filter((f) => !excluded(f));

test('excluded(): directories, one-directory globs and single files', () => {
  const rules = ['docs/layout/', 'docs/mac-app/*.png', 'ROADMAP.md'];
  assert.ok(excluded('docs/layout/a.png', rules));
  assert.ok(excluded('docs/mac-app/x.png', rules));
  assert.ok(!excluded('docs/mac-app/README.md', rules));
  assert.ok(!excluded('docs/mac-app/sub/x.png', rules));
  assert.ok(excluded('ROADMAP.md', rules));
  assert.ok(!excluded('docs/ROADMAP.md', rules));
});

test('public markdown never links into an excluded path', () => {
  const bad: string[] = [];
  for (const f of PUBLIC.filter((x) => x.endsWith('.md'))) {
    const text = readFileSync(join(ROOT, f), 'utf8');
    for (const m of text.matchAll(/\]\(([^)\s#]+)(?:#[^)]*)?\)|<img [^>]*src="([^"]+)"/g)) {
      const u = m[1] ?? m[2];
      if (/^(https?:|mailto:)/.test(u)) continue;
      const target = normalize(join(dirname(f), u));
      if (excluded(target) || excluded(`${target}/`)) bad.push(`${f} → ${u}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('docs URLs in code point at files the public tree keeps', () => {
  const bad: string[] = [];
  for (const f of PUBLIC.filter((x) => /^(src|public|claude-plugin|bin)\/.*\.(ts|js|mjs|html)$/.test(x))) {
    const text = readFileSync(join(ROOT, f), 'utf8');
    for (const m of text.matchAll(/github\.com\/c10dev\/portboard\/blob\/main\/([^'"`\s)#]+)/g)) if (excluded(m[1])) bad.push(`${f} → ${m[1]}`);
    for (const m of text.matchAll(/\$\{(?:DOCS|REPO)\}\/([^'"`\s)#]+)/g)) {
      const p = text.includes('/blob/main/docs\'') && m[0].startsWith('${DOCS}') ? `docs/${m[1]}` : m[1];
      if (excluded(p)) bad.push(`${f} → ${p}`);
    }
  }
  assert.deepEqual(bad, []);
});
