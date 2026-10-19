// The pages' text (docs/i18n/): t(key, params) from the catalog of the page's language, public/i18n/<locale>.json.
// The same keys and format as the server's src/core/i18n.ts: dotted keys, {name} placeholders, and a value of
// { one, other } for a count (Intl.PluralRules on params.n).
//
// The language is the one lib/shell-boot.js chose before the first paint and put on <html lang>: 설정 › 화면 › 언어
// on this device (localStorage pb.locale: 'ko' | 'en', none for 자동), else the server's locale when it is set, else
// the browser's. Changing it reloads the page. In node (the tests) it is PORTBOARD_LOCALE, else en.
//
// The catalog is loaded before any module that imports this one runs (top-level await), so t() is synchronous and a
// module may call it at import. Keys are literal strings at the call site ('ports.badge.hidden', never built from
// parts): test/i18n.test.ts finds them that way, fails on a missing one and on catalog keys nothing uses.

export const LOCALES = ['en', 'ko'];
/** 설정 › 화면 › 언어 on this device (lib/shell-boot.js reads the same key) */
export const LOCALE_KEY = 'pb.locale';
/** The cookie that tells the server which language a page's API text should be in (src/core/i18n.ts) */
export const LOCALE_COOKIE = 'pb_locale';

// served over http(s) to a page; file: in node, where a test may have a fake document
const inBrowser = import.meta.url.startsWith('http');

function detect() {
  if (inBrowser) {
    const l = document.documentElement.lang;
    return LOCALES.includes(l) ? l : 'en';
  }
  const env = globalThis.process?.env?.PORTBOARD_LOCALE;
  return LOCALES.includes(env) ? env : 'en';
}

let lang = detect();
let catalog = {};
let rules = null;

async function load(l) {
  const url = new URL(`../i18n/${l}.json`, import.meta.url);
  if (inBrowser) {
    const res = await fetch(url);
    return res.ok ? res.json() : {};
  }
  return (await import(url.href, { with: { type: 'json' } })).default;
}

try {
  catalog = await load(lang);
} catch {
  catalog = {};
}

/** The page's language: 'en' | 'ko' */
export const locale = () => lang;

/** Use another catalog (tests) */
export function setCatalog(l, c) {
  lang = l;
  catalog = c;
  rules = null;
}

function lookup(key, params) {
  const v = catalog[key];
  if (v === undefined) return key;
  if (typeof v === 'string') return v;
  rules ??= new Intl.PluralRules(lang);
  const n = Number(params?.n);
  return v[rules.select(Number.isFinite(n) ? n : 0)] ?? v.other ?? key;
}

const fill = (text, params) => text.replace(/\{(\w+)\}/g, (m, k) => (params?.[k] === undefined || params[k] === null ? m : String(params[k])));

/** t('ports.badge.hidden') → text; params fill {name}, params.n also picks one/other */
export function t(key, params) {
  return fill(lookup(key, params), params);
}

const TAGS = new Set(['b', 'code', 'kbd', 'em', 'strong']);
const isNode = (v) => v !== null && typeof v === 'object';

/**
 * Rich text for h() children: the catalog may mark <b>…</b>, <code>…</code>, <kbd>, <em>, <strong> (no attributes),
 * and a param may be a node (a link, a button) or an array of them, placed where its {name} is. Params that are
 * strings stay text: nothing from data becomes markup.
 */
export function tn(key, params) {
  const text = lookup(key, params);
  const out = [];
  const re = /<(\/?)(b|code|kbd|em|strong)>/g;
  let stack = [{ tag: null, kids: out }];
  let at = 0;
  const pushText = (s) => {
    for (const part of s.split(/(\{\w+\})/)) {
      if (!part) continue;
      const m = part.match(/^\{(\w+)\}$/);
      const v = m ? params?.[m[1]] : undefined;
      const kids = stack.at(-1).kids;
      if (m && v !== undefined && v !== null) {
        if (Array.isArray(v)) kids.push(...v);
        else kids.push(isNode(v) ? v : String(v));
      } else kids.push(part);
    }
  };
  for (const m of text.matchAll(re)) {
    pushText(text.slice(at, m.index));
    at = m.index + m[0].length;
    if (!TAGS.has(m[2])) continue;
    if (!m[1]) stack.push({ tag: m[2], kids: [] });
    else if (stack.length > 1) {
      const top = stack.pop();
      const n = document.createElement(top.tag);
      n.append(...top.kids);
      stack.at(-1).kids.push(n);
    }
  }
  pushText(text.slice(at));
  while (stack.length > 1) stack.at(-2).kids.push(...stack.pop().kids);
  return out;
}

/** This device's 언어 choice: 'ko' | 'en', or 'auto' (nothing stored, a blocked storage) */
export function loadLocalePref(storage = globalThis.localStorage) {
  try {
    const v = storage?.getItem(LOCALE_KEY);
    return LOCALES.includes(v) ? v : 'auto';
  } catch {
    return 'auto';
  }
}

/** Remember the choice ('auto' forgets it); the caller reloads so the page is built again in it */
export function saveLocalePref(v, storage = globalThis.localStorage) {
  try {
    if (LOCALES.includes(v)) storage?.setItem(LOCALE_KEY, v);
    else storage?.removeItem(LOCALE_KEY);
  } catch {}
}

/** Numbers the page's way (1,234) */
export const num = (n, opts) => Number(n).toLocaleString(lang, opts);
