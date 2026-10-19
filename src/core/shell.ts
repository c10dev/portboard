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

export const VIEWS = [
  { id: 'services', label: '서비스', href: './' },
  { id: 'devices', label: '기기', href: 'devices.html' },
  { id: 'dev', label: '개발', href: 'dev.html' },
  { id: 'settings', label: '설정', href: 'settings.html' },
] as const;

export type ViewId = (typeof VIEWS)[number]['id'];

const ICON = {
  side: '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><rect x="2.5" y="3.5" width="15" height="13" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 3.5v13" stroke="currentColor" stroke-width="1.5"/></svg>',
  insp: '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><rect x="2.5" y="3.5" width="15" height="13" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M12 3.5v13" stroke="currentColor" stroke-width="1.5"/></svg>',
  filter: '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M3 5h14M5.5 10h9M8 15h4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/></svg>',
};

/** Pane widths in CSS px, as lib/shell.js PANE (test/ui-shell.test.ts keeps them equal) */
export const PANE = { side: { min: 200, max: 420, def: 288 }, insp: { min: 280, max: 480, def: 300 } } as const;

/** A pane's resize handle: a focusable vertical separator (← → resize it, see lib/shell.js) */
function handle(id: string, pane: 'side' | 'insp', controls: string, label: string, title: string): string {
  const p = PANE[pane];
  return `<div id="${id}" class="pane-handle ${pane}-handle" role="separator" tabindex="0" aria-orientation="vertical" aria-controls="${controls}" ` +
    `aria-label="${label}" aria-valuemin="${p.min}" aria-valuemax="${p.max}" aria-valuenow="${p.def}" title="${title}"></div>`;
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

/** Each marker's markup for a page */
export function shellParts(opts: { view: ViewId; inspector: boolean; hostname: string; boot: string }): Record<string, string> {
  const { view, inspector } = opts;
  const label = VIEWS.find((v) => v.id === view)!.label;
  return {
    boot: `<script>${opts.boot}\nPortboardBoot.start(${JSON.stringify({ inspector })});</script>`,
    nav:
      `<button type="button" id="sideToggle" class="icon-btn side-toggle" title="사이드바 (⌘\\)" aria-label="사이드바 (⌘\\)" aria-controls="shellSide" aria-keyshortcuts="Meta+\\ Control+\\" aria-expanded="true">${ICON.side}</button>` +
      '<button type="button" id="navBack" class="icon-btn nav-btn" title="뒤로 (⌘[)" aria-label="뒤로">←</button>' +
      '<button type="button" id="navFwd" class="icon-btn nav-btn" title="앞으로 (⌘])" aria-label="앞으로">→</button>',
    view: `<span class="t-view">${label}</span><span class="t-sep">·</span>`,
    hostname: esc(opts.hostname),
    tabs: `<nav class="tabs shell-tabs" aria-label="보기">${VIEWS.map((v) => `<a href="${v.href}"${current(view, v.id)}>${v.label}</a>`).join('')}</nav>`,
    palette: '<button type="button" id="paletteBtn" class="palette-btn" title="검색·명령 (⌘K 또는 /)" aria-label="검색·명령" aria-keyshortcuts="Meta+K /"><span class="pb-ico">🔍</span><kbd>⌘K</kbd></button>',
    filter: `<button type="button" id="filterBtn" class="filter-btn" title="필터" aria-label="필터" aria-expanded="false" aria-controls="filterPanel">${ICON.filter}<span class="filter-dot"></span></button>`,
    'insp-toggle': inspector
      ? `<button type="button" id="inspToggle" class="icon-btn insp-toggle" title="상세 패널" aria-label="상세 패널" aria-controls="inspector" aria-pressed="true">${ICON.insp}</button>`
      : '',
    sidebar:
      '<nav id="shellSide" class="shell-side" aria-label="탐색">' +
      `<div class="side-views" role="list">${VIEWS.map((v) => `<a href="${v.href}" class="side-view" role="listitem" data-view="${v.id}"${current(view, v.id)}><span class="sv-label">${v.label}</span><span class="side-count" id="count-${v.id}"></span></a>`).join('')}</div>` +
      '<section class="side-sec" id="sidePinned" hidden><h2>고정</h2><ul></ul></section>' +
      '<section class="side-sec" id="sideDevices" hidden><h2>기기</h2><ul></ul></section>' +
      '<div class="side-foot" id="shellFoot">' +
      '<a class="btn ob-chip" id="obChip" href="settings.html#start" aria-label="설정 체크리스트 (설정 탭)" hidden><span class="ob-icon">☑</span><span class="ob-text" id="obText"></span></a>' +
      '<button type="button" class="sw-chip" id="swChip" aria-label="데이터 수집 상태" hidden><span class="sw-dot"></span><span class="sw-text" id="swText"></span></button>' +
      '</div></nav>' +
      handle('sideHandle', 'side', 'shellSide', '사이드바 너비', '끌어서 너비 조절 · 클릭하면 사이드바 열기·닫기 (⌘\\)') +
      // the cached counts, pins, devices and chips, before the rest of the page paints
      '<script>PortboardBoot.paintSide();</script>',
    aside:
      (inspector
        ? handle('inspHandle', 'insp', 'inspector', '상세 패널 너비', '끌어서 너비 조절') +
          '<aside id="inspector" class="insp" aria-label="상세"><div class="insp-head"><strong id="inspTitle">상세</strong>' +
          '<button type="button" id="inspClose" class="icon-btn" aria-label="상세 닫기" title="닫기">×</button></div><div id="inspBody" class="insp-body"></div></aside>'
        : '') + '<div class="shell-scrim" id="shellScrim"></div>',
  };
}

/** Markers a page must carry (filter and hostname are optional: only pages with filters or a host title use them) */
export const REQUIRED = ['boot', 'nav', 'view', 'tabs', 'palette', 'insp-toggle', 'sidebar', 'aside'] as const;

const BOOT_FILE = new URL('../../public/lib/shell-boot.js', import.meta.url);

/** Expand every `<!--#shell:name-->` in a page; unknown markers are left as they are (visible in a test) */
export function expandShell(html: string, opts: { hostname?: string; boot?: string } = {}): string {
  if (!html.includes('<!--#shell:')) return html;
  // read on every request, like the rest of public/, so a deploy is live at once
  const boot = opts.boot ?? readFileSync(BOOT_FILE, 'utf8');
  const parts = shellParts({ ...pageOptions(html), hostname: opts.hostname ?? osHostname(), boot });
  return html.replace(/<!--#shell:([\w-]+)-->/g, (m, name: string) => (name in parts ? parts[name] : m));
}
