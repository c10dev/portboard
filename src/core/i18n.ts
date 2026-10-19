// The server's half of the UI language (docs/i18n/): the same catalogs and key scheme as the pages' lib/i18n.js
// (public/i18n/en.json, ko.json), for the text the server writes itself — the setup checklist, access-denied
// reasons, alert and digest pushes, new-port and memory notices, suggestions, MCP text meant for people, the remote
// consent page and errors the UI shows.
//
// Which language:
//   - a dashboard request: the page's language, which lib/shell-boot.js keeps in the pb_locale cookie (the device's
//     설정 › 화면 › 언어, else the server's, else the browser's); server.ts runs each request in withLocale()
//   - everything else (alerts and digests sent from a job, the stdio and remote MCP servers): SITE.locale, from
//     PORTBOARD_LOCALE or portboard.json's locale, else en
//
// Keys are dotted ('alerts.down.title'); a value is a string with {name} placeholders, or { one, other } chosen by
// Intl.PluralRules on params.n. test/i18n.test.ts keeps both catalogs equal and every key used, and fails on a t()
// whose key is missing. Text built at import (MCP tool descriptions) stays English: it is for the model, not people.

import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
import { isLocale, LOCALES, SITE, type Locale } from './site.ts';

export type { Locale };
export type Catalog = Record<string, string | Record<string, string>>;
export type Params = Record<string, string | number | null | undefined>;

const DIR = new URL('../../public/i18n/', import.meta.url);

function load(locale: Locale): Catalog {
  try {
    return JSON.parse(readFileSync(new URL(`${locale}.json`, DIR), 'utf8')) as Catalog;
  } catch {
    return {};
  }
}

/** Both catalogs, read once (a deploy restarts the server) */
export const CATALOGS: Record<Locale, Catalog> = Object.fromEntries(LOCALES.map((l) => [l, load(l)])) as Record<Locale, Catalog>;

const als = new AsyncLocalStorage<Locale>();

/** The language of text written now: the request's (withLocale), else the server's */
export const currentLocale = (): Locale => als.getStore() ?? SITE.locale;

/** Run fn with text in `locale` (one dashboard request) */
export const withLocale = <T>(locale: Locale, fn: () => T): T => als.run(locale, fn);

/** The pb_locale cookie of a request (lib/shell-boot.js sets it), when it names a known language */
export function requestLocale(headers: { cookie?: string | string[] }): Locale | null {
  const raw = Array.isArray(headers.cookie) ? headers.cookie.join('; ') : headers.cookie ?? '';
  const m = raw.match(/(?:^|;\s*)pb_locale=([a-z]{2})(?:;|$)/);
  return m && isLocale(m[1]) ? m[1] : null;
}

const rules = new Map<Locale, Intl.PluralRules>();
const plural = (locale: Locale, n: number) => {
  if (!rules.has(locale)) rules.set(locale, new Intl.PluralRules(locale));
  return rules.get(locale)!.select(n);
};

/** {name} → params.name (a missing one stays as written, so it shows in a test) */
export function fill(text: string, params: Params = {}): string {
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (params[k] === undefined || params[k] === null ? m : String(params[k])));
}

/** The catalog text of a key in a language, plural picked by params.n; the key itself when it is missing */
export function lookup(key: string, params: Params = {}, locale: Locale = currentLocale()): string {
  const v = CATALOGS[locale]?.[key];
  if (v === undefined) return key;
  if (typeof v === 'string') return v;
  const n = Number(params.n);
  return v[plural(locale, Number.isFinite(n) ? n : 0)] ?? v.other ?? key;
}

/** t('alerts.down.title', { port: 8790 }) → the text in the current language */
export function t(key: string, params?: Params, locale?: Locale): string {
  return fill(lookup(key, params, locale), params);
}
