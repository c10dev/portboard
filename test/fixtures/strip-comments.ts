// Source with its comments blanked, for the i18n scans (test/i18n.test.ts, test/i18n-hangul.test.ts): strings,
// template literals and regex literals are kept, line numbers too. A small scanner, not a parser: enough for this
// repo's JS, TS, CSS and HTML.

import { extname } from 'node:path';

/** JS/TS/CSS source with its comments blanked (strings, templates with their ${} code, and regex literals kept) */
export function stripComments(src: string, css = false): string {
  const n = src.length;
  let out = '';
  let i = 0;
  let prev = ''; // last significant char of code, to tell a regex literal from a division

  // code until the `}` that closes a template's ${ (depth counts the braces opened inside)
  function codeUntil(close: boolean) {
    let depth = 0;
    while (i < n) {
      const c = src[i];
      const d = src[i + 1];
      if (close && c === '}' && depth === 0) return;
      if (c === '{') depth++;
      if (c === '}') depth--;
      if (c === '/' && d === '*') {
        const end = src.indexOf('*/', i + 2);
        const stop = end < 0 ? n : end + 2;
        out += src.slice(i, stop).replace(/[^\n]/g, ' ');
        i = stop;
        continue;
      }
      if (!css && c === '/' && d === '/') {
        while (i < n && src[i] !== '\n') { out += ' '; i++; }
        continue;
      }
      if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
        out += src.slice(i, j + 1);
        i = j + 1;
        prev = c;
        continue;
      }
      if (!css && c === '`') {
        out += c;
        i++;
        template();
        prev = '`';
        continue;
      }
      if (!css && c === '/' && (prev === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(prev))) {
        let j = i + 1;
        let cls = false;
        while (j < n && src[j] !== '\n') {
          if (src[j] === '\\') j++;
          else if (src[j] === '[') cls = true;
          else if (src[j] === ']') cls = false;
          else if (src[j] === '/' && !cls) break;
          j++;
        }
        out += src.slice(i, j + 1);
        i = j + 1;
        prev = '/';
        continue;
      }
      if (!/\s/.test(c)) prev = c;
      out += c;
      i++;
    }
  }

  // the rest of a template literal, its ${} parts as code
  function template() {
    while (i < n) {
      const c = src[i];
      if (c === '\\') { out += src.slice(i, i + 2); i += 2; continue; }
      if (c === '`') { out += c; i++; return; }
      if (c === '$' && src[i + 1] === '{') {
        out += '${';
        i += 2;
        prev = '{';
        codeUntil(true);
        if (i < n) { out += '}'; i++; }
        continue;
      }
      out += c;
      i++;
    }
  }

  codeUntil(false);
  return out;
}

export const stripHtml = (src: string) =>
  src.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(<script\b[^>]*>)([\s\S]*?)(<\/script>)/g, (_m, a, body, b) => a + stripComments(body) + b)
    .replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/g, (_m, a, body, b) => a + stripComments(body, true) + b);

export function code(file: string, src: string): string {
  const ext = extname(file);
  if (ext === '.html') return stripHtml(src);
  if (ext === '.css') return stripComments(src, true);
  if (['.js', '.ts', '.mjs'].includes(ext)) return stripComments(src);
  return src;
}

