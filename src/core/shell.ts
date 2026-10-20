// The dashboard shell's static markup (docs/layout/): the server expands `<!--#shell:…-->` markers in each page as it
// serves it, so the first paint already has the bar, the sidebar and the inspector in their final place. Before this,
// public/lib/shell.js built them after the module ran, and every tab click showed the unstyled page first. shell.js now
// only wires what is here (ids and classes must match it), and lib/shell-boot.js — inlined into <head> — applies the
// remembered toggles, app mode, read-only and the cached sidebar before anything paints.
//
// One copy for every page: a page writes the few wrappers it owns (header.top, .brand, the title h1, .controls,
// .shell, .shell-main) around its own controls and content, and these markers fill in the rest:
//
//   <!--#shell:boot-->       in <head>: the inlined boot script, started with this page's options
//   <!--#shell:nav-->        sidebar toggle, ← →
//   <!--#shell:view-->       the title's view name and its "·"
//   <!--#shell:hostname-->   this server's name (the 서비스 title before the host list arrives)
//   <!--#shell:tabs-->       the phone's tab strip
//   <!--#shell:palette-->    the ⌘K button (lib/palette.js wires it)
//   <!--#shell:filter-->     the filter popover's button (index, dev)
//   <!--#shell:insp-toggle--> the inspector toggle (pages with <body data-inspector>)
//   <!--#shell:sidebar-->    the sidebar: views with counts, 고정, 기기, the footer chips, and its resize handle
//   <!--#shell:aside-->      the inspector and its resize handle (pages with data-inspector) and the overlay scrim
//
// The resize handles (role=separator) say the default widths; lib/shell-boot.js applies the remembered ones before the
// first paint and lib/shell.js keeps aria-valuenow current.
//
// test/ui-shell.test.ts checks every page carries every marker it needs and the wrappers around them.

import { readFileSync } from 'node:fs';
import { hostname as osHostname } from 'node:os';
import { CATALOGS, t } from './i18n.ts';
import { LOCALES, SITE, type Locale } from './site.ts';

export const VIEWS = [
  { id: 'services', label: 'shell.view.services', href: './' },
  { id: 'devices', label: 'shell.view.devices', href: 'devices.html' },
  { id: 'dev', label: 'shell.view.dev', href: 'dev.html' },
  { id: 'settings', label: 'shell.view.settings', href: 'settings.html' },
] as const;

export type ViewId = (typeof VIEWS)[number]['id'];

const ICON = {
  side: '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><rect x="2.5" y="3.5" width="15" height="13" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 3.5v13" stroke="currentColor" stroke-width="1.5"/></svg>',
  insp: '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><rect x="2.5" y="3.5" width="15" height="13" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M12 3.5v13" stroke="currentColor" stroke-width="1.5"/></svg>',
  filter: '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M3 5h14M5.5 10h9M8 15h4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/></svg>',
  gear: '<svg class="sv-icon" viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><circle cx="10" cy="10" r="2.6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10 2.5v2.2M10 15.3v2.2M2.5 10h2.2M15.3 10h2.2M4.7 4.7l1.6 1.6M13.7 13.7l1.6 1.6M4.7 15.3l1.6-1.6M13.7 6.3l1.6-1.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
};

/** Pane widths in CSS px, as lib/shell.js PANE (test/ui-shell.test.ts keeps them equal) */
export const PANE = { side: { min: 200, max: 420, def: 288 }, insp: { min: 280, max: 480, def: 300 } } as const;

/** A pane's resize handle: a focusable vertical separator (← → resize it, see lib/shell.js) */
function handle(id: string, pane: 'side' | 'insp', controls: string, label: string, title: string): string {
  const p = PANE[pane];
  return `<div id="${id}" class="pane-handle ${pane}-handle" role="separator" tabindex="0" aria-orientation="vertical" aria-controls="${controls}" ` +
    `data-t-aria-label="${label}" aria-valuemin="${p.min}" aria-valuemax="${p.max}" aria-valuenow="${p.def}" data-t-title="${title}"></div>`;
}

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]);

/** The page's view and whether it has an inspector, from its <body data-view data-inspector> */
export function pageOptions(html: string): { view: ViewId; inspector: boolean } {
  const body = html.match(/<body\b([^>]*)>/)?.[1] ?? '';
  const view = body.match(/\bdata-view="([^"]+)"/)?.[1];
  return { view: VIEWS.some((v) => v.id === view) ? (view as ViewId) : 'services', inspector: /\bdata-inspector\b/.test(body) };
}

const current = (view: ViewId, id: string) => (view === id ? ' aria-current="page"' : '');

/** A sidebar view link with its count; in the top list a listitem, in the footer (설정) with an icon in front */
function sideView(v: (typeof VIEWS)[number], view: ViewId, icon = ''): string {
  return `<a href="${v.href}" class="side-view"${icon ? '' : ' role="listitem"'} data-view="${v.id}"${current(view, v.id)}>${icon}` +
    `<span class="sv-label" data-t="${v.label}"></span><span class="side-count" id="count-${v.id}"></span></a>`;
}

/** Each marker's markup for a page. Text is a data-t / data-t-<attr> key, filled by expandShell (fillStrings). */
export function shellParts(opts: { view: ViewId; inspector: boolean; hostname: string; boot: string; locale?: Locale }): Record<string, string> {
  const { view, inspector } = opts;
  const label = VIEWS.find((v) => v.id === view)!.label;
  const locale = opts.locale ?? SITE.locale;
  return {
    boot: `<script>${opts.boot}\nPortboardBoot.start(${JSON.stringify({ inspector, ...bootLocale(locale) }).replace(/</g, '\\u003c')});</script>`,
    nav:
      `<button type="button" id="sideToggle" class="icon-btn side-toggle" data-t-title="shell.sidebar" data-t-aria-label="shell.sidebar" aria-controls="shellSide" aria-keyshortcuts="Meta+\\ Control+\\" aria-expanded="true">${ICON.side}</button>` +
      '<button type="button" id="navBack" class="icon-btn nav-btn" data-t-title="shell.back.title" data-t-aria-label="shell.back">←</button>' +
      '<button type="button" id="navFwd" class="icon-btn nav-btn" data-t-title="shell.fwd.title" data-t-aria-label="shell.fwd">→</button>',
    view: `<span class="t-view" data-t="${label}"></span><span class="t-sep">·</span>`,
    hostname: esc(opts.hostname),
    tabs: `<nav class="tabs shell-tabs" data-t-aria-label="shell.tabs">${VIEWS.map((v) => `<a href="${v.href}"${current(view, v.id)} data-t="${v.label}"></a>`).join('')}</nav>`,
    palette: '<button type="button" id="paletteBtn" class="palette-btn" data-t-title="shell.palette.title" data-t-aria-label="shell.palette" aria-keyshortcuts="Meta+K /"><span class="pb-ico">🔍</span><kbd>⌘K</kbd></button>',
    filter: `<button type="button" id="filterBtn" class="filter-btn" data-t-title="shell.filter" data-t-aria-label="shell.filter" aria-expanded="false" aria-controls="filterPanel">${ICON.filter}<span class="filter-dot"></span></button>`,
    'insp-toggle': inspector
      ? `<button type="button" id="inspToggle" class="icon-btn insp-toggle" data-t-title="shell.insp.toggle" data-t-aria-label="shell.insp.toggle" aria-controls="inspector" aria-pressed="true">${ICON.insp}</button>`
      : '',
    sidebar:
      '<nav id="shellSide" class="shell-side" data-t-aria-label="shell.side">' +
      `<div class="side-views" role="list">${VIEWS.filter((v) => v.id !== 'settings').map((v) => sideView(v, view)).join('')}</div>` +
      '<section class="side-sec" id="sidePinned" hidden><h2 data-t="shell.pinned"></h2><ul></ul></section>' +
      '<section class="side-sec" id="sideDevices" hidden><h2 data-t="shell.devices"></h2><ul></ul></section>' +
      // 설정 sits at the bottom with the setup and collector chips, like the Claude app's account area
      `<div class="side-foot" id="shellFoot">${sideView(VIEWS.find((v) => v.id === 'settings')!, view, ICON.gear)}` +
      '<a class="btn ob-chip" id="obChip" href="settings.html#start" data-t-aria-label="shell.obChip" hidden><span class="ob-icon">☑</span><span class="ob-text" id="obText"></span></a>' +
      '<button type="button" class="sw-chip" id="swChip" data-t-aria-label="shell.swChip" hidden><span class="sw-dot"></span><span class="sw-text" id="swText"></span></button>' +
      '</div></nav>' +
      handle('sideHandle', 'side', 'shellSide', 'shell.sideHandle', 'shell.sideHandle.title') +
      // the cached counts, pins, devices and chips (and this device's language), before the rest of the page paints
      '<script>PortboardBoot.paintSide();</script>',
    aside:
      (inspector
        ? handle('inspHandle', 'insp', 'inspector', 'shell.inspHandle', 'shell.inspHandle.title') +
          '<aside id="inspector" class="insp" data-t-aria-label="shell.insp"><div class="insp-head"><strong id="inspTitle" data-t="shell.insp"></strong>' +
          '<button type="button" id="inspClose" class="icon-btn" data-t-aria-label="shell.insp.close" data-t-title="common.close">×</button></div><div id="inspBody" class="insp-body"></div></aside>'
        : '') + '<div class="shell-scrim" id="shellScrim"></div>',
  };
}

/** The boot script's language options: the server's locale, whether it was set, and the strings it may relabel with */
export function bootLocale(locale: Locale) {
  const strings: Record<string, Record<string, string>> = {};
  for (const l of LOCALES) {
    strings[l] = {};
    for (const [k, v] of Object.entries(CATALOGS[l])) if (BOOT_PREFIXES.some((p) => k.startsWith(p)) && typeof v === 'string') strings[l][k] = v;
  }
  return { locale, explicit: SITE.sources.locale !== 'default', locales: [...LOCALES], strings };
}

/** The keys lib/shell-boot.js gets inlined: the shell's, the static pages' markup and its own */
export const BOOT_PREFIXES = ['shell.', 'page.', 'boot.', 'common.'];

/**
 * A page's text in one language: an element `data-t="key"` with nothing inside gets the text (`data-th`: its markup),
 * and `data-t-<attr>="key"`
 * adds attr="text" (title, aria-label, placeholder, label). lib/shell-boot.js redoes it in the browser when the
 * device's language is another one.
 */
export function fillStrings(html: string, locale: Locale): string {
  const text = (k: string) => esc(t(k, undefined, locale));
  return html
    .replace(/(<[a-z][\w-]*\b[^>]*?\sdata-t="([\w.-]+)"[^>]*>)(<\/)/g, (_m, open: string, k: string, close: string) => `${open}${text(k)}${close}`)
    // data-th: the catalog's own markup (<code>, <b>; never data), for the few static lines that have it
    .replace(/(<[a-z][\w-]*\b[^>]*?\sdata-th="([\w.-]+)"[^>]*>)(<\/)/g, (_m, open: string, k: string, close: string) => `${open}${t(k, undefined, locale)}${close}`)
    .replace(/\sdata-t-([a-z-]+)="([\w.-]+)"/g, (m, attr: string, k: string) => `${m} ${attr}="${text(k)}"`);
}

/** Markers a page must carry (filter and hostname are optional: only pages with filters or a host title use them) */
export const REQUIRED = ['boot', 'nav', 'view', 'tabs', 'palette', 'insp-toggle', 'sidebar', 'aside'] as const;

const BOOT_FILE = new URL('../../public/lib/shell-boot.js', import.meta.url);

/** Expand every `<!--#shell:name-->` in a page; unknown markers are left as they are (visible in a test) */
export function expandShell(html: string, opts: { hostname?: string; boot?: string; locale?: Locale } = {}): string {
  // a page without the shell (settings.html) still gets its text
  if (!html.includes('<!--#shell:')) return html.includes(' data-t') ? fillStrings(html.replace(/<html lang="[^"]*"/, `<html lang="${opts.locale ?? SITE.locale}"`), opts.locale ?? SITE.locale) : html;
  // read on every request, like the rest of public/, so a deploy is live at once
  const boot = opts.boot ?? readFileSync(BOOT_FILE, 'utf8');
  const locale = opts.locale ?? SITE.locale;
  const parts = shellParts({ ...pageOptions(html), hostname: opts.hostname ?? osHostname(), boot, locale });
  const out = html
    .replace(/<html lang="[^"]*"/, `<html lang="${locale}"`)
    .replace(/<!--#shell:([\w-]+)-->/g, (m, name: string) => (name in parts ? parts[name] : m));
  // the page's own markup relabelled for a device in another language, before the first paint
  const filled = fillStrings(out, locale);
  const end = filled.lastIndexOf('</body>');
  return end < 0 ? filled : `${filled.slice(0, end)}<script>window.PortboardBoot && PortboardBoot.relabel();</script>\n${filled.slice(end)}`;
}
