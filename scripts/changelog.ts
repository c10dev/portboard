// Fold changelog.d/*.md fragments into a new version section of CHANGELOG.md (see changelog.d/README.md).
//
//   node scripts/changelog.ts --check
//   node scripts/changelog.ts <version> [title]
//   node scripts/changelog.ts --notes <version>     print that version's section (the GitHub Release body)

import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SECTIONS = ['Added', 'Changed', 'Fixed', 'Removed', 'Security', 'Docs'] as const;
export type Section = (typeof SECTIONS)[number];

export interface Fragment {
  name: string;
  sections: Map<Section, string[]>;
}

/** Parse one fragment; throws with a readable message when the format is wrong. */
export function parseFragment(name: string, text: string): Fragment {
  const sections = new Map<Section, string[]>();
  let current: Section | null = null;
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const line = raw.trimEnd();
    const h = /^### (.+)$/.exec(line);
    if (h) {
      const s = h[1].trim() as Section;
      if (!SECTIONS.includes(s)) throw new Error(`${name}: unknown section "${h[1]}" (use ${SECTIONS.join(', ')})`);
      current = s;
      if (!sections.has(s)) sections.set(s, []);
      continue;
    }
    if (!line) continue;
    if (!current) throw new Error(`${name}: text before the first ### heading`);
    sections.get(current)!.push(line);
  }
  if (!sections.size) throw new Error(`${name}: no ### sections`);
  for (const [s, lines] of sections) if (!lines.some((l) => l.startsWith('- '))) throw new Error(`${name}: section ${s} has no "- " item`);
  return { name, sections };
}

/** Natural sort: 9 before 10, 21 before 21-2. */
export function byName(a: Fragment, b: Fragment): number {
  return a.name.localeCompare(b.name, 'en', { numeric: true });
}

export function renderRelease(version: string, title: string | null, date: string, fragments: Fragment[]): string {
  const out = [`## ${version} — ${date}${title ? ` (${title})` : ''}`, ''];
  for (const s of SECTIONS) {
    const items = [...fragments].sort(byName).flatMap((f) => f.sections.get(s) ?? []);
    if (!items.length) continue;
    out.push(`### ${s}`, ...items, '');
  }
  return out.join('\n');
}

/** Insert the new section above the first "## " heading (after the "# Changelog" title). */
export function insertRelease(changelog: string, section: string): string {
  const i = changelog.search(/^## /m);
  if (i < 0) return `${changelog.trimEnd()}\n\n${section}\n`;
  return `${changelog.slice(0, i)}${section}\n${changelog.slice(i)}`;
}

/** The body of one version's section (without its "## " heading), or null when CHANGELOG.md has none. */
export function releaseNotes(changelog: string, version: string): string | null {
  const lines = changelog.replace(/\r/g, '').split('\n');
  const start = lines.findIndex((l) => l === `## ${version}` || l.startsWith(`## ${version} `));
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim();
}

function main(argv: string[]) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  if (argv[0] === '--notes') {
    const version = (argv[1] ?? '').replace(/^v/, '');
    const notes = releaseNotes(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), version);
    if (notes === null) throw new Error(`CHANGELOG.md has no "## ${version}" section: run npm run changelog -- ${version || '<version>'} first`);
    console.log(notes);
    return;
  }
  const dir = join(root, 'changelog.d');
  const files = readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'README.md');
  const fragments = files.map((f) => parseFragment(f.replace(/\.md$/, ''), readFileSync(join(dir, f), 'utf8')));
  if (argv[0] === '--check' || !argv[0]) {
    console.log(`changelog.d: ${fragments.length} fragment(s) ok`);
    return;
  }
  if (!/^\d+\.\d+\.\d+$/.test(argv[0])) throw new Error(`version must look like 0.7.0, got "${argv[0]}"`);
  if (!fragments.length) throw new Error('no fragments to release');
  const date = new Date().toISOString().slice(0, 10);
  const path = join(root, 'CHANGELOG.md');
  writeFileSync(path, insertRelease(readFileSync(path, 'utf8'), renderRelease(argv[0], argv[1] ?? null, date, fragments)));
  for (const f of files) rmSync(join(dir, f));
  console.log(`CHANGELOG.md: ${argv[0]} from ${fragments.length} fragment(s); fragments removed`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(String((err as Error).message));
    process.exit(1);
  }
}
