// Relative links in the README, roadmap, changelog and docs must point at files that exist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const docs = readdirSync(join(ROOT, 'docs')).flatMap((e) => {
  const p = join('docs', e);
  if (e.endsWith('.md')) return [p];
  const readme = join(p, 'README.md');
  return statSync(join(ROOT, p)).isDirectory() && existsSync(join(ROOT, readme)) ? [readme] : [];
});
// ROADMAP.md stays in the private repo (scripts/public-exclude.txt): checked only where it exists
const files = ['README.md', 'ROADMAP.md', 'CHANGELOG.md', 'changelog.d/README.md', ...docs].filter((f) => existsSync(join(ROOT, f)));

for (const f of files) {
  test(`${f}: relative links resolve`, () => {
    const text = readFileSync(join(ROOT, f), 'utf8');
    const broken = [...text.matchAll(/\]\(([^)\s#]+)(?:#[^)]*)?\)/g)]
      .map((m) => m[1])
      .filter((u) => !/^(https?:|mailto:)/.test(u))
      .filter((u) => !existsSync(normalize(join(ROOT, dirname(f), u))));
    assert.deepEqual(broken, []);
  });
}
