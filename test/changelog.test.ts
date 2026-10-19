import { test } from 'node:test';
import assert from 'node:assert/strict';
import { insertRelease, parseFragment, renderRelease } from '../scripts/changelog.ts';

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
