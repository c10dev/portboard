// No Korean outside the ko catalog (docs/i18n/): every word a person reads comes from public/i18n/<locale>.json, so
// the English UI has nothing left over. Scanned: public/ (pages, scripts, styles, the manifest) and src/ (the text
// the server writes). Allowed: comments, the ko catalog, the language's own name in en.json, and the few places
// below that match Korean on purpose (each says why). Tests, docs/, private/ and the Mac app's ko strings aren't
// scanned.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { code, stripComments, stripHtml } from './fixtures/strip-comments.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HANGUL = /[가-힣ᄀ-ᇿ㄰-㆏]/;

/** file → lines (exact text, trimmed) that may keep Korean, and why */
const ALLOWED: Record<string, { line: RegExp; why: string }[]> = {
  'public/i18n/en.json': [{ line: /^"settings\.display\.lang\.ko": "한국어",?$/, why: 'a language is offered in its own name' }],
  'public/lib/fuzzy.js': [{ line: /^const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';$/, why: 'the initial consonants a Korean name is matched by (초성 search), not text' }],
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(ROOT, dir))) {
    const p = join(dir, name);
    if (statSync(join(ROOT, p)).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const SCANNED = [...walk('public'), ...walk('src')].filter((p) => p !== join('public', 'i18n', 'ko.json') && /\.(js|ts|mjs|html|css|json|webmanifest|svg)$/.test(p));

test('no Korean outside the ko catalog and comments', () => {
  const found: string[] = [];
  for (const f of SCANNED) {
    const lines = code(f, readFileSync(join(ROOT, f), 'utf8')).split('\n');
    const raw = readFileSync(join(ROOT, f), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!HANGUL.test(line)) return;
      const text = raw[i].trim();
      if (ALLOWED[f.replace(/\\/g, '/')]?.some((a) => a.line.test(text))) return;
      found.push(`${f}:${i + 1}: ${text.slice(0, 120)}`);
    });
  }
  assert.deepEqual(found, [], `${found.length} lines with Korean outside public/i18n/ko.json`);
});

test('the comment stripper keeps strings, templates and regexes and blanks comments', () => {
  const src = "const a = '// 문자열'; // 주석\nconst r = /가\\/나/g; /* 블록\n주석 */ const b = `x ${'템플릿'}`;\nconst url = 'https://x'; // 끝";
  const out = stripComments(src);
  assert.match(out, /'\/\/ 문자열'/);
  assert.ok(!out.includes('주석'));
  assert.match(out, /\/가\\\/나\/g/);
  assert.match(out, /템플릿/);
  assert.ok(!out.includes('끝'));
  assert.equal(out.split('\n').length, src.split('\n').length, 'line numbers kept');
  assert.equal(stripComments('a { content: "가"; } /* 나 */', true).includes('나'), false);
  assert.match(stripHtml('<p>가</p><!-- 나 -->'), /가/);
  assert.ok(!stripHtml('<p>x</p><!-- 나 -->').includes('나'));
});
