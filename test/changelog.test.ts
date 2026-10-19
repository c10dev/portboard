import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { insertRelease, parseFragment, releaseNotes, renderRelease } from '../scripts/changelog.ts';

test('parseFragment accepts known sections and rejects mistakes', () => {
  const f = parseFragment('21', '### Changed\n- a (#21).\n  - detail\n\n### Fixed\n- b\n');
  assert.deepEqual([...f.sections.keys()], ['Changed', 'Fixed']);
  assert.deepEqual(f.sections.get('Changed'), ['- a (#21).', '  - detail']);
  assert.throws(() => parseFragment('x', 'intro\n### Changed\n- a'), /before the first/);
  assert.throws(() => parseFragment('x', '### Misc\n- a'), /unknown section/);
  assert.throws(() => parseFragment('x', '### Fixed\nno bullet'), /no "- " item/);
  assert.throws(() => parseFragment('x', ''), /no ### sections/);
});

test('renderRelease orders sections and fragments naturally; insertRelease goes above the last release', () => {
  const frags = [parseFragment('21-2', '### Fixed\n- second'), parseFragment('9', '### Changed\n- nine'), parseFragment('21', '### Fixed\n- first\n### Changed\n- twenty-one')];
  const sec = renderRelease('0.7.0', 'M6', '2026-10-18', frags);
  assert.equal(sec, '## 0.7.0 — 2026-10-18 (M6)\n\n### Changed\n- nine\n- twenty-one\n\n### Fixed\n- first\n- second\n');
  const cl = '# Changelog\n\n## 0.6.0 — x\n- old\n';
  assert.equal(insertRelease(cl, sec), `# Changelog\n\n${sec}\n## 0.6.0 — x\n- old\n`);
});

test('releaseNotes: one version\'s section without its heading, for the GitHub Release (#9)', () => {
  const cl = '# Changelog\n\n## 1.1.0 — 2026-10-20 (M11)\n\n### Added\n- cli (#9).\n\n## 1.0.0 — 2026-10-18\n\n### Fixed\n- old\n';
  assert.equal(releaseNotes(cl, '1.1.0'), '### Added\n- cli (#9).');
  assert.equal(releaseNotes(cl, '1.0.0'), '### Fixed\n- old');
  assert.equal(releaseNotes(cl, '1.0'), null);
  assert.equal(releaseNotes(cl, '2.0.0'), null);
});

test('every fragment waiting in changelog.d/ parses (what `npm run changelog:check` checks)', () => {
  const dir = fileURLToPath(new URL('../changelog.d/', import.meta.url));
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.md') && x !== 'README.md')) {
    assert.doesNotThrow(() => parseFragment(f.replace(/\.md$/, ''), readFileSync(dir + f, 'utf8')), f);
  }
});
