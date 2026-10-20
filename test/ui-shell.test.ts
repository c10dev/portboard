// The dashboard shell (src/core/shell.ts, public/lib/shell.js, shell-boot.js, shell.css, features/nav.js,
// features/port-inspector.js; docs/layout/): its pure parts, every page's markers and wrappers, and a render smoke on a
// small fake DOM of each page as the server sends it — the bar keeps header.top, .brand and .controls for the Mac app,
// the page's own controls keep their ids, the boot paints the cached sidebar, the sidebar and inspector are wired.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FakeDocument, FakeElement, fakeWindow, loadPage, runBoot } from './fixtures/fake-dom.ts';
import { lookup } from '../src/core/i18n.ts';
import { bootLocale, expandShell, pageOptions, PANE as SERVER_PANE, REQUIRED, VIEWS as SERVER_VIEWS } from '../src/core/shell.ts';
// @ts-expect-error plain browser module, no types
import { clampWidth, done, layoutFor, loadState, maxWidth, mountShell, PANE, saveState, share, onShared, stepSelection, typingIn, viewOf, VIEWS, WIDTH } from '../public/lib/shell.js';
// @ts-expect-error plain browser module, no types
import { chipState, NAV_KEY, navCounts, navDevices, navPinned } from '../public/features/nav.js';
// @ts-expect-error plain browser module, no types
import { inspectorFacts, portsOverview, renderInspector } from '../public/features/port-inspector.js';
// @ts-expect-error plain browser module, no types
import { portBadges } from '../public/features/ports.js';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const PAGES = { 'index.html': ['app.js', 'services'], 'devices.html': ['devices.js', 'devices'], 'dev.html': ['dev.js', 'dev'], 'service.html': ['service.js', 'services'] } as const;

const port = (over: Record<string, unknown> = {}) => ({
  port: 8790, listening: true, scope: 'loopback', addresses: ['127.0.0.1'], kind: 'app', container: null, composeProject: null,
  processes: [{ pid: 2, cmdline: 'node src/server.ts', cwd: '~/projects/portboard', project: 'portboard', unit: 'portboard.service', unitDescription: 'Portboard' }],
  systemOwner: null, group: null, role: null, name: 'Portboard', detectedName: 'Portboard', label: null, pinned: false, hidden: false, alert: false,
  visible: true, probe: { http: true, status: 200, title: 'Portboard' }, served: 'https://x:8443', canExpose: false,
  urls: { direct: 'http://devbox:8790', served: 'https://devbox.ts.net:8443', ssh: 'ssh -N -L 8790:127.0.0.1:8790 dev@devbox' },
  control: { type: 'systemd', unit: 'portboard.service' }, canRestart: true, canStop: true, ...over,
});

// ---- pure parts ----

test('viewOf: <body data-view> wins; else the file name; service.html belongs to 서비스', () => {
  assert.equal(viewOf('/devices.html', 'dev'), 'dev');
  assert.equal(viewOf('/devices.html', 'nonsense'), 'devices');
  assert.equal(viewOf('/', undefined), 'services');
  assert.equal(viewOf('/service.html', undefined), 'services');
  assert.equal(viewOf('/dev.html'), 'dev');
  assert.equal(viewOf('/settings.html'), 'settings');
  assert.deepEqual(VIEWS.map((v: any) => v.label), ['서비스', '기기', '개발', '설정']);
});

test('loadState / saveState: both shown by default; broken, missing or throwing storage never breaks the page', () => {
  const def = { side: true, insp: true, sideW: 288, inspW: 300 };
  assert.deepEqual(loadState(null), def);
  assert.deepEqual(loadState({ getItem: () => '{not json' }), def);
  assert.deepEqual(loadState({ getItem: () => '7' }), def);
  assert.deepEqual(loadState({ getItem: () => { throw new Error('denied'); } }), def);
  assert.deepEqual(loadState({ getItem: () => '{"side":false}' }), { ...def, side: false });
  // widths from an older or edited pb.shell are clamped into range, junk is the default
  assert.deepEqual(loadState({ getItem: () => '{"sideW":9999,"inspW":"abc"}' }), { ...def, sideW: 420 });
  assert.deepEqual(loadState({ getItem: () => '{"sideW":10,"inspW":350.6}' }), { ...def, sideW: 200, inspW: 351 });
  const m = new Map<string, string>();
  saveState({ setItem: (k: string, v: string) => m.set(k, v) }, { side: false, insp: true, sideW: 333, inspW: 1000 });
  assert.deepEqual(JSON.parse(m.get('pb.shell')!), { side: false, insp: true, sideW: 333, inspW: 480 });
  assert.doesNotThrow(() => saveState({ setItem: () => { throw new Error('quota'); } }, { side: true, insp: true }));
});

test('clampWidth / maxWidth: sidebar 200–420 (288), inspector 280–480 (300), the list keeps 324 px', () => {
  assert.deepEqual(PANE, { side: { min: 200, max: 420, def: 288 }, insp: { min: 280, max: 480, def: 300 }, list: 324, gap: 8, drag: 3 });
  assert.equal(clampWidth('side', 150), 200);
  assert.equal(clampWidth('side', 421), 420);
  assert.equal(clampWidth('side', 300.4), 300);
  assert.equal(clampWidth('side', null), 288);
  assert.equal(clampWidth('side', ''), 288);
  assert.equal(clampWidth('side', NaN), 288);
  assert.equal(clampWidth('insp', 279), 280);
  assert.equal(clampWidth('insp', 481), 480);
  assert.equal(clampWidth('insp', undefined), 300);
  // 1440 with a 480 inspector column: the sidebar may take 1440 - 8 - 324 - 480 = 628, capped at 420
  assert.equal(maxWidth('side', 1440, 480), 420);
  assert.equal(maxWidth('side', 1100, 480), 288);
  // the inspector next to a 420 sidebar at 1232: 1232 - 8 - 324 - 420 = 480
  assert.equal(maxWidth('insp', 1232, 420), 480);
  assert.equal(maxWidth('insp', 1200, 420), 448);
  // never under the pane's minimum, whatever the viewport
  assert.equal(maxWidth('side', 500, 0), 200);
  assert.equal(maxWidth('insp', 300, 420), 280);
});

test('layoutFor: inspector a column from 1200, sidebar a column from 704, phone at 640 and below', () => {
  assert.deepEqual(layoutFor(1440), { side: 'column', insp: 'column', phone: false });
  assert.deepEqual(layoutFor(1200), { side: 'column', insp: 'column', phone: false });
  assert.deepEqual(layoutFor(1199), { side: 'column', insp: 'overlay', phone: false });
  assert.deepEqual(layoutFor(704), { side: 'column', insp: 'overlay', phone: false });
  assert.deepEqual(layoutFor(703), { side: 'overlay', insp: 'overlay', phone: false });
  assert.deepEqual(layoutFor(390), { side: 'overlay', insp: 'overlay', phone: true });
  // shell.css uses the same numbers
  const css = read('public/shell.css');
  assert.match(css, new RegExp(`max-width: ${WIDTH.inspectorColumn - 1}\\.98px`));
  assert.match(css, new RegExp(`max-width: ${WIDTH.sidebarColumn - 1}\\.98px`));
  assert.match(css, new RegExp(`max-width: ${WIDTH.compact - 1}\\.98px`));
  assert.match(css, new RegExp(`max-width: ${WIDTH.phone}px`));
  // at 1440 the sidebar, the pane's 8 px, the capped column and the inspector fit side by side
  const px = (name: string) => Number(css.match(new RegExp(`--${name}: (\\d+)px`))?.[1]);
  assert.equal(px('side-w'), 288);
  assert.equal(px('bar-h'), 48);
  assert.equal(px('col-max'), 808);
  assert.ok(px('side-w') + 8 + px('col-max') + 300 <= 1440);
  assert.ok(WIDTH.inspectorColumn - px('side-w') - 8 - 300 >= 560, 'the list keeps room when the inspector becomes a column');
  assert.match(css, new RegExp(`min-width: ${WIDTH.phone + 1}px`));
});

test('layoutFor: wider panes move the breakpoints up so the list keeps 324 px; the defaults change nothing', () => {
  const at = (w: number, panes: Record<string, unknown>) => { const l = layoutFor(w, panes); return `${l.side}/${l.insp}`; };
  // the defaults are the fixed breakpoints (288 + 8 + 604 + 300 = 1200; 704)
  assert.equal(at(1200, { sideW: 288, inspW: 300 }), 'column/column');
  assert.equal(at(1199, { sideW: 288, inspW: 300 }), 'column/overlay');
  assert.equal(at(704, { sideW: 288 }), 'column/overlay');
  assert.equal(at(703, { sideW: 288 }), 'overlay/overlay');
  // narrower panes never move them down
  assert.equal(at(1199, { sideW: 200, inspW: 280 }), 'column/overlay');
  assert.equal(at(703, { sideW: 200 }), 'overlay/overlay');
  // a 420 sidebar is a column from 420 + 8 + 324 = 752
  assert.equal(at(752, { sideW: 420 }), 'column/overlay');
  assert.equal(at(751, { sideW: 420 }), 'overlay/overlay');
  // 420 + 8 + 324 + 480 = 1232 for both at their widest
  assert.equal(at(1232, { sideW: 420, inspW: 480 }), 'column/column');
  assert.equal(at(1231, { sideW: 420, inspW: 480 }), 'column/overlay');
  // a closed sidebar (or a drawer) leaves the inspector its room
  assert.equal(at(1210, { sideW: 420, inspW: 480, side: false }), 'column/column');
  assert.equal(at(1210, { sideW: 420, inspW: 480, side: true }), 'column/overlay');
  // junk widths are the defaults
  assert.equal(at(1200, { sideW: 'x', inspW: -5 }), 'column/column');
  // shell.css shows the drawer or the sheet by data-*-mode above the fixed breakpoints, and the remembered widths
  const css = read('public/shell.css');
  const own = css.slice(css.indexOf('/* ==== Resizable panes'), css.indexOf('/* ==== end: resizable panes'));
  assert.ok(own.length > 200, 'a marked section of its own');
  assert.match(own, /@media \(min-width: 704px\) \{\s*:root\[data-side="open"\]:not\(\[data-side-mode="overlay"\]\) \{ --side-w: var\(--side-open, 288px\); \}/);
  assert.match(own, /@media \(min-width: 1200px\) \{\s*:root\[data-insp="open"\]:not\(\[data-insp-mode="overlay"\]\) \{ --insp-w: var\(--insp-open, 300px\); \}/);
  assert.match(own, /:root\[data-side-mode="overlay"\] \.shell-side \{/);
  assert.match(own, /:root\[data-insp\]\[data-insp-mode="overlay"\] \.insp \{/);
});

test('pane widths: lib/shell.js, shell-boot.js and src/core/shell.ts say the same numbers; the boot repeats layoutFor', () => {
  for (const pane of ['side', 'insp'] as const) assert.deepEqual(SERVER_PANE[pane], { min: PANE[pane].min, max: PANE[pane].max, def: PANE[pane].def });
  const pane = (p: { min: number; max: number; def: number }) => `{ min: ${p.min}, max: ${p.max}, def: ${p.def} }`;
  assert.ok(BOOT.includes(`var PANE = { side: ${pane(PANE.side)}, insp: ${pane(PANE.insp)}, list: ${PANE.list}, gap: ${PANE.gap} };`), 'shell-boot.js PANE');
  assert.match(BOOT, new RegExp(`SIDE_COLUMN = ${WIDTH.sidebarColumn};`));
  assert.match(BOOT, new RegExp(`INSP_COLUMN = ${WIDTH.inspectorColumn};`));
  const boot = runBoot(BOOT, new FakeDocument(), fakeWindow(1440));
  for (const w of [640, 703, 704, 751, 752, 900, 1199, 1200, 1231, 1232, 1440]) {
    for (const [sideW, inspW] of [[200, 280], [288, 300], [350, 400], [420, 480]]) {
      for (const side of [true, false]) {
        const l = layoutFor(w, { sideW, inspW, side });
        assert.deepEqual(boot.modes(w, sideW, inspW, side), { side: l.side, insp: l.insp }, `${w} ${sideW} ${inspW} ${side}`);
      }
    }
  }
});

test('stepSelection: ↑/↓ stop at the ends; from nothing ↓ is the first and ↑ the last', () => {
  const keys = [22, 3000, 8790];
  assert.equal(stepSelection(keys, null, 1), 22);
  assert.equal(stepSelection(keys, null, -1), 8790);
  assert.equal(stepSelection(keys, 3000, 1), 8790);
  assert.equal(stepSelection(keys, 8790, 1), 8790);
  assert.equal(stepSelection(keys, 22, -1), 22);
  assert.equal(stepSelection(keys, 9999, 1), 22, 'a selection that went away starts over');
  assert.equal(stepSelection([], null, 1), null);
});

test('typingIn: fields, selects, editable text and an open dialog keep their keys', () => {
  const noDialog = { querySelector: () => null };
  assert.equal(typingIn({ tagName: 'INPUT' }, noDialog), true);
  assert.equal(typingIn({ tagName: 'SELECT' }, noDialog), true);
  assert.equal(typingIn({ tagName: 'DIV', isContentEditable: true }, noDialog), true);
  assert.equal(typingIn({ tagName: 'BODY' }, noDialog), false);
  assert.equal(typingIn({ tagName: 'BODY' }, { querySelector: () => ({}) }), true);
});

test('share / onShared: a late listener gets the latest value at once, then every new one', () => {
  const seen: unknown[] = [];
  share('t-key', 1);
  onShared('t-key', (v: unknown) => seen.push(v));
  share('t-key', 2);
  assert.deepEqual(seen, [1, 2]);
});

test('sidebar: counts, 고정 links to the row, 기기 dots from the pool state or online', () => {
  const ports = { ports: [port({ pinned: true }), port({ port: 22, visible: false }), port({ port: 3000, listening: false, pinned: true, name: 'web' })] };
  const devices = { devices: [
    { id: 'devbox', name: 'devbox', self: true, online: true, pool: null },
    { id: 'mac', name: 'mac', online: true, pool: { state: 'agent-busy' } },
    { id: 'desk', name: 'desk', online: true, pool: { state: 'host-down' } },
    { id: 'phone', name: 'phone', online: false, pool: null },
  ] };
  assert.deepEqual(navCounts({ ports, devices, worktrees: { totals: { worktrees: 12 } }, onboarding: { total: 10, ok: 7 } }), { services: 1, devices: 3, dev: 12, settings: 3 });
  assert.deepEqual(navCounts({ onboarding: { total: 10, ok: 10 } }), { settings: null }, 'all done: no number');
  assert.deepEqual(navPinned(ports).map((p: any) => [p.href, p.sub, p.tone]), [['./#8790', '8790', null], ['./#3000', '3000', 'warn']]);
  assert.deepEqual(navDevices(devices).map((d: any) => [d.text, d.tone, d.href]), [
    ['devbox (이 서버)', 'ok', 'devices.html#devbox'], ['mac', 'warn', 'devices.html#mac'], ['desk', 'bad', 'devices.html#desk'], ['phone', 'off', 'devices.html#phone'],
  ]);
});

test('dense rows keep the key badges: tailnet HTTPS, 리스닝 없음, local only (not the rest)', () => {
  globalThis.document = new FakeDocument() as any;
  const keys = (p: any) => portBadges(p).filter((b: any) => b.classList.contains('key')).map((b: any) => b.textContent);
  assert.deepEqual(keys(port()), ['tailnet HTTPS']);
  assert.deepEqual(keys(port({ served: null })), ['local only']);
  assert.deepEqual(keys(port({ listening: false, served: null })), ['리스닝 없음']);
  assert.deepEqual(keys(port({ scope: 'all', served: null })), []);
  assert.ok(portBadges(port({ scope: 'all', served: null })).some((b: any) => b.textContent === '모든 인터페이스'), 'the inspector still shows the others');
});

test('badge tones: tailnet HTTPS is how it is reached (info), local only is a plain fact (no warning colour)', () => {
  globalThis.document = new FakeDocument() as any;
  const tone = (p: any, text: string) => portBadges(p).find((b: any) => b.textContent === text)?.className;
  assert.equal(tone(port(), 'tailnet HTTPS'), 'badge info key');
  assert.equal(tone(port({ served: null }), 'local only'), 'badge key');
  assert.equal(tone(port({ listening: false, served: null }), '리스닝 없음'), 'badge warn key', 'a watched port that stopped still warns');
});

test('portsOverview: 한눈에 counts the shown ports, in use, on tailnet, this server only and the down alerts', () => {
  globalThis.document = new FakeDocument() as any;
  const ports = [port(), port({ port: 3000, served: null }), port({ port: 22, visible: false, scope: 'all', served: null }), port({ port: 5173, scope: 'all', served: null, alert: true })];
  const usage = { byPort: { 3000: [{ name: 'mac' }], 22: [{ name: 'mac' }] } };
  const rows = (node: any) => {
    const kids = node.querySelector('dl').children;
    const out: string[][] = [];
    for (let i = 0; i < kids.length; i += 2) out.push([kids[i].textContent, kids[i + 1].textContent]);
    return out;
  };
  assert.deepEqual(rows(portsOverview(ports, usage)), [['포트', '3'], ['지금 사용 중', '1'], ['tailnet 공개', '1'], ['이 서버에서만', '1'], ['다운 알림', '1']]);
  const down = portsOverview(ports, null, 2);
  assert.deepEqual(rows(down).map(([k]) => k), ['포트', 'tailnet 공개', '이 서버에서만', '다운 알림'], 'no usage yet: no 지금 사용 중 line');
  assert.equal(rows(down).at(-1)?.[1], '3 · 2개 다운', 'watched ports nothing listens on count as down');
});

test('inspectorFacts: command, path, PID, unit, control under 무엇인지; addresses and SSH under 주소', () => {
  const f = inspectorFacts(port());
  assert.deepEqual(f.what.map(([k]: string[]) => k), ['명령', '경로', 'PID', 'systemd', '제어', '페이지 제목']);
  assert.deepEqual(f.reach.map(([k]: string[]) => k), ['주소', '직접 URL', 'Tailnet URL', 'SSH']);
  const two = inspectorFacts(port({ processes: [port().processes[0], { pid: 3, cmdline: 'x', cwd: null, project: null, unit: null }] }));
  assert.ok(two.what.some(([k]: string[]) => k === 'PID 2'), 'several processes are numbered');
});

// ---- every page uses the shell ----

for (const [page, [script, view]] of Object.entries(PAGES)) {
  test(`${page}: data-view="${view}", shell.css after style.css, ${script} imports lib/shell.js first`, () => {
    const html = read(`public/${page}`);
    assert.match(html, new RegExp(`<body data-view="${view}"`));
    assert.ok(html.indexOf('href="shell.css"') > html.indexOf('href="style.css"'), 'shell.css overrides style.css');
    const firstImport = read(`public/${script}`).match(/^import .*$/m)?.[0] ?? '';
    assert.match(firstImport, /from '\.\/lib\/shell\.js'|^import '\.\/lib\/shell\.js'/, firstImport);
  });
}

test('index.html: the inspector, the host picker in the title and the filters in the popover, with their ids', () => {
  const html = read('public/index.html');
  assert.match(html, /<body data-view="services" data-inspector>/);
  const ctx = html.match(/<span class="t-ctx" id="shellCtx">([\s\S]*?)<\/span><\/h1>/)?.[1] ?? '';
  assert.match(ctx, /id="hostSel"/);
  const filters = html.match(/<div class="menu-panel filter-panel" id="filterPanel">([\s\S]*?)<\/div>/)?.[1] ?? '';
  for (const id of ['q', 'inUse', 'showSystem']) assert.match(filters, new RegExp(`id="${id}"`), id);
  assert.match(read('public/dev.html'), /id="filterPanel">\s*<label class="check"><input id="onlyRemovable"/);
});

test('the footer chips and the read-only note go to the sidebar footer, with the old header as fallback', () => {
  for (const f of ['public/features/onboarding.js', 'public/features/selfwatch.js', 'public/lib/access.js']) {
    assert.match(read(f), /shellFoot/, f);
  }
  // decorating features also decorate the inspector
  for (const f of ['public/features/owners.js', 'public/features/suggestions.js']) assert.match(read(f), /#inspBody \.insp-port/, f);
});

// ---- the static shell (src/core/shell.ts): one copy, expanded into every page by the server ----

const BOOT = read('public/lib/shell-boot.js');
const served = (page: string) => expandShell(read(`public/${page}`), { hostname: 'devbox', boot: BOOT });

for (const page of Object.keys(PAGES)) {
  test(`${page}: carries every shell marker inside the wrappers it owns, and nothing is left unexpanded`, () => {
    const html = read(`public/${page}`);
    for (const m of REQUIRED) assert.equal(html.split(`<!--#shell:${m}-->`).length, 2, `${page}: one <!--#shell:${m}-->`);
    assert.match(html, /<link rel="stylesheet" href="[\w-]+\.css">\s*<!--#shell:boot-->\s*<\/head>/, 'the boot runs after the stylesheets, before <body>');
    assert.match(html, /<header class="top">\s*<div class="brand">\s*<!--#shell:nav-->\s*<h1 id="shellTitle" class="shell-title"><!--#shell:view--><span class="t-ctx" id="shellCtx">/);
    assert.match(html, /<div class="controls">\s*<!--#shell:palette-->/);
    assert.match(html, /<!--#shell:insp-toggle-->\s*<\/div>\s*<\/header>\s*<div class="shell">\s*<!--#shell:sidebar-->\s*<div class="shell-main" id="shellMain">/);
    assert.match(html, /<\/div>\s*<!--#shell:aside-->\s*<\/div>/);
    const out = served(page);
    assert.ok(!out.includes('<!--#shell:'), 'every marker expanded');
    for (const id of ['sideToggle', 'navBack', 'navFwd', 'paletteBtn', 'shellSide', 'shellFoot', 'obChip', 'swChip', 'shellScrim', 'count-services']) assert.match(out, new RegExp(`id="${id}"`), id);
    assert.equal(out.includes('id="inspector"'), page === 'index.html', 'only the 서비스 tab has the inspector');
    assert.match(out, /<nav class="tabs shell-tabs"/);
  });
}

test('shell markup: the views match lib/shell.js, aria-current follows the page, the boot is safe to inline', () => {
  assert.deepEqual(SERVER_VIEWS.map((v) => [v.id, lookup(v.label, {}, 'ko'), v.href]), VIEWS.map((v: any) => [v.id, v.label, v.href]));
  assert.deepEqual(pageOptions('<body data-view="dev">'), { view: 'dev', inspector: false });
  assert.deepEqual(pageOptions('<body data-view="nope" data-inspector>'), { view: 'services', inspector: true });
  const dev = served('dev.html');
  assert.match(dev, /<a href="dev.html" class="side-view" role="listitem" data-view="dev" aria-current="page">/);
  assert.match(dev, /<span class="t-view" data-t="shell.view.dev">개발<\/span>/);
  assert.match(served('index.html'), /<span data-t="common.thisServer">이 서버<\/span> devbox<\/span>/);
  assert.match(expandShell('<body data-view="services"><span><!--#shell:hostname--></span>', { hostname: '<x>', boot: '' }), /&lt;x&gt;/);
  assert.ok(!/<\/script|<!--/i.test(BOOT), 'nothing in the boot script can end or confuse its inline <script>');
  assert.equal(expandShell('<p>no markers</p>', { boot: '' }), '<p>no markers</p>');
  // the server reads it per request, from public/
  assert.ok(expandShell(read('public/dev.html'), { hostname: 'h' }).includes('window.PortboardBoot'));
});

// ---- render smoke on a fake DOM: the page as the server sends it ----

function mount(width: number, { storage = new Map<string, string>(), session = new Map<string, string>(), page = 'index.html', userAgent = 'node' } = {}) {
  const doc = new FakeDocument();
  globalThis.document = doc as any;
  loadPage(doc, served(page));
  const win: any = fakeWindow(width, storage, session);
  const boot = runBoot(BOOT, doc, win, userAgent);
  boot.start({ inspector: page === 'index.html', ...bootLocale('ko') });
  boot.paintSide();
  const api = mountShell(doc, win);
  const $ = (id: string) => doc.getElementById(id)!;
  return { doc, win, api, $, header: doc.querySelector('header.top')!, q: $('q'), sel: $('hostSel') };
}

test('render: one bar (header.top, .brand left, .controls right), the page controls kept, sidebar, main and inspector', () => {
  const { doc, api, header, q, sel } = mount(1440);
  assert.ok(api);
  assert.equal(doc.querySelectorAll('header.top').length, 1);
  const brand = header.querySelector('.brand')!;
  assert.deepEqual(brand.children.map((c: FakeElement) => c.id), ['sideToggle', 'navBack', 'navFwd', 'shellTitle']);
  // the title is the h1 lib/profile.js puts its 미리보기 badge after; the host picker is in it
  assert.equal(brand.querySelector('h1')!.id, 'shellTitle');
  assert.ok(doc.getElementById('shellCtx')!.contains(sel));
  assert.ok(doc.getElementById('shellTitle')!.textContent.startsWith('서비스·이 서버 devbox'));
  // right: ⌘K, the filter popover (the search field inside), 🔔, ↻, the inspector toggle
  const controls = header.querySelector('.controls')!;
  assert.deepEqual(controls.children.map((c: FakeElement) => c.id), ['paletteBtn', 'filterPop', 'alertsBtn', 'refresh', 'inspToggle']);
  assert.ok(doc.getElementById('filterPop')!.contains(q));
  // the tab strip for the phone layout
  assert.ok(header.querySelector('nav')!.classList.contains('shell-tabs'));
  // layout: sidebar (views, 고정, 기기, footer), main (the page's own content), inspector, scrim; dialogs and the toast stay in <body>
  const frame = doc.body.querySelector('.shell')!;
  // (and the inline script that paints the cached sidebar right after it; scripts take no grid cell)
  // (the resize handles are position: fixed, no grid cell either)
  assert.deepEqual(frame.children.filter((c: FakeElement) => c.tagName !== 'SCRIPT').map((c: FakeElement) => c.id), ['shellSide', 'sideHandle', 'shellMain', 'inspHandle', 'inspector', 'shellScrim']);
  assert.match(frame.querySelector('script')!.textContent, /PortboardBoot\.paintSide\(\)/);
  assert.deepEqual(doc.getElementById('shellSide')!.children.map((c: FakeElement) => c.id || c.className), ['side-views', 'sidePinned', 'sideDevices', 'shellFoot']);
  assert.deepEqual(doc.getElementById('shellMain')!.children.map((c: FakeElement) => c.id || c.tagName), ['status', 'MAIN']);
  assert.ok(['toast', 'logs', 'row'].every((id) => doc.getElementById(id)!.parentNode === doc.body));
  assert.equal(doc.querySelector('.side-view[aria-current="page"]')!.dataset.view, 'services');
  // 설정 is the footer's first row, not one of the views at the top
  assert.deepEqual(doc.querySelector('.side-views')!.children.map((c: FakeElement) => c.dataset.view), ['services', 'devices', 'dev']);
  assert.equal(doc.getElementById('shellFoot')!.children[0].dataset.view, 'settings');
  assert.equal(mountShell(doc, fakeWindow(1440)), api, 'mounting twice is the same shell');
  // the main column waits for the rows, the owners banner and the alerts, each named
  assert.equal(doc.querySelector('main')!.dataset.wait, 'page owners alerts');
  done('page', doc);
  done('alerts', doc);
  assert.equal(doc.querySelector('main')!.dataset.wait, 'owners');
  done('owners', doc);
  assert.equal(doc.querySelector('main')!.hasAttribute('data-wait'), false);
});

test('render: every page mounts the same shell from its served HTML', () => {
  for (const [page, [, view]] of Object.entries(PAGES)) {
    const { doc, api } = mount(1440, { page });
    assert.ok(api, page);
    assert.equal(api.view, view, page);
    assert.equal(doc.documentElement.dataset.insp, page === 'index.html' ? 'open' : 'closed', `${page}: no inspector column without an inspector`);
    assert.equal(doc.querySelector('.side-view[aria-current="page"]')!.dataset.view, view, page);
  }
});

test('boot: the remembered toggles, app mode, read-only and the cached sidebar are on the page before the modules run', () => {
  const nav = {
    counts: { services: 17, devices: 7, dev: 71, settings: 2 },
    pinned: [{ key: 3000, text: 'webapp', sub: '3000', href: './#3000' }],
    devices: [{ key: 'mac', text: 'mac', tone: 'warn', href: 'devices.html#mac', title: 'mac · 사용 중' }],
    chips: { ob: { hidden: false, warn: true, text: '설정 8/10', title: 't' }, sw: { hidden: false, tone: 'alarm', text: '1개 실패' } },
  };
  const doc = new FakeDocument();
  globalThis.document = doc as any;
  loadPage(doc, served('devices.html'));
  const win: any = fakeWindow(1440, new Map([['pb.shell', '{"side":false,"insp":true}'], ['pb.nav', JSON.stringify(nav)]]), new Map([['pb.ro', '{"readonly":true,"reason":"쓰기 허용 목록에 없는 기기예요."}']]));
  const boot = runBoot(BOOT, doc, win, 'Mozilla/5.0 portboard-mac/1.0');
  boot.start({ inspector: false, ...bootLocale('ko') });
  const root = doc.documentElement;
  assert.deepEqual([root.dataset.side, root.dataset.insp, root.dataset.app, root.dataset.readonly], ['closed', 'closed', 'mac', '1']);
  boot.paintSide();
  const $ = (id: string) => doc.getElementById(id)!;
  assert.equal($('count-dev').textContent, '71');
  assert.equal($('sidePinned').hidden, false);
  assert.equal($('sidePinned').querySelector('a')!.getAttribute('href'), './#3000');
  assert.ok($('sideDevices').querySelector('a')!.classList.contains('t-warn'));
  assert.equal($('obChip').hidden, false);
  assert.equal($('obText').textContent, '설정 8/10');
  assert.ok($('swChip').classList.contains('alarm'));
  assert.match($('shellFoot').querySelector('.readonly-note')!.textContent, /쓰기 허용 목록/);

  // storage that is empty, broken or throws: defaults, nothing painted, no error
  const bare = new FakeDocument();
  globalThis.document = bare as any;
  loadPage(bare, served('dev.html'));
  const broken: any = fakeWindow(1440, new Map([['pb.nav', '{oops'], ['pb.shell', 'nope']]));
  broken.sessionStorage = { getItem: () => { throw new Error('denied'); } };
  const b = runBoot(BOOT, bare, broken);
  assert.doesNotThrow(() => { b.start({ inspector: false, ...bootLocale('ko') }); b.paintSide(); });
  assert.equal(bare.documentElement.dataset.side, 'open');
  assert.equal(bare.getElementById('sidePinned')!.hidden, true);
  assert.equal(bare.getElementById('count-dev')!.textContent, '');
});

test('render: toggles remember the desktop state; narrow widths use overlays instead, ⌘\\ and Escape work', () => {
  const storage = new Map<string, string>();
  const wide = mount(1440, { storage });
  const root = wide.doc.documentElement;
  assert.equal(root.dataset.side, 'open');
  assert.equal(root.dataset.insp, 'open');
  wide.$('sideToggle').click();
  assert.equal(root.dataset.side, 'closed');
  assert.equal(JSON.parse(storage.get('pb.shell')!).side, false);
  assert.ok(wide.doc.key('\\', { metaKey: true }), '⌘\\ is taken');
  assert.equal(root.dataset.side, 'open');
  wide.$('inspClose').click();
  assert.equal(root.dataset.insp, 'closed');
  assert.equal(wide.api.inspector.shown, false);
  wide.api.inspector.open();
  assert.equal(wide.api.inspector.shown, true);
  // the filter popover opens on its button and closes with Escape
  wide.$('filterBtn').click();
  assert.ok(wide.$('filterPop').classList.contains('open'));
  assert.equal(wide.$('filterBtn').getAttribute('aria-expanded'), 'true');
  wide.doc.key('Escape');
  assert.ok(!wide.$('filterPop').classList.contains('open'));

  // a fresh page reads it back
  const again = mount(1440, { storage: new Map([['pb.shell', '{"side":false,"insp":true}']]) });
  assert.equal(again.doc.documentElement.dataset.side, 'closed');

  const narrow = mount(700);
  const r = narrow.doc.documentElement;
  narrow.$('sideToggle').click();
  assert.ok('sideOverlay' in r.dataset, 'under 704 the toggle opens the drawer');
  assert.equal(r.dataset.side, 'open', 'and leaves the remembered state alone');
  narrow.api.inspector.open();
  assert.ok('inspOverlay' in r.dataset && !('sideOverlay' in r.dataset), 'one overlay at a time');
  narrow.doc.key('Escape');
  assert.ok(!('inspOverlay' in r.dataset));
  assert.equal(mount(390).api.inspector.usable, false, 'on a phone 상세 stays inline in the rows');
});

test('render: ← → are the history; setContext and the sidebar lists fill in', () => {
  const { doc, win, api } = mount(1440);
  doc.getElementById('navBack')!.click();
  doc.getElementById('navFwd')!.click();
  assert.deepEqual(win.calls, ['back', 'forward']);
  api.setCounts({ services: 16, devices: 7 });
  assert.equal(doc.getElementById('count-services')!.textContent, '16');
  assert.equal(doc.getElementById('count-dev')!.textContent, '');
  api.setDevices([{ text: 'mac', tone: 'warn', href: 'devices.html#mac', key: 'mac' }]);
  const dev = doc.getElementById('sideDevices')!;
  assert.equal(dev.hidden, false);
  assert.equal(dev.querySelector('a')!.getAttribute('href'), 'devices.html#mac');
  assert.ok(dev.querySelector('a')!.classList.contains('t-warn'));
  api.setPinned([]);
  assert.equal(doc.getElementById('sidePinned')!.hidden, true);
  api.setContext(doc.createTextNode('8790 Portboard') as any);
  assert.equal(doc.getElementById('shellCtx')!.textContent, '8790 Portboard');
});

test('nav cache: the footer chips are saved as they show', () => {
  const { doc } = mount(1440);
  doc.getElementById('obChip')!.hidden = false;
  doc.getElementById('obText')!.textContent = '설정 7/10';
  doc.getElementById('swChip')!.classList.add('warn');
  assert.deepEqual(chipState(doc), { ob: { hidden: false, warn: false, text: '설정 7/10', title: '' }, sw: { hidden: true, tone: 'warn', text: '' } });
  assert.equal(NAV_KEY, 'pb.nav');
  assert.match(BOOT, /var NAV_KEY = 'pb\.nav';/, 'the boot reads the same key');
});

test('render: the inspector shows a port with its actions (writes marked data-write) and an empty state', () => {
  const { doc, api } = mount(1440);
  globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ source: 'journalctl', lines: ['a', 'b'] }) })) as any;
  const ctx = { busy: new Set(), usage: { byPort: { 8790: [{ kind: 'tailnet', name: 'mac', connections: 2, id: 'mac' }] }, history: { byPort: {} } }, act() {}, confirmAct() {}, openLogs() {}, shown: () => true };
  renderInspector(api.inspector, port(), ctx);
  try {
    const body = doc.getElementById('inspBody')!;
    assert.equal(doc.getElementById('inspTitle')!.textContent, '8790 상세');
    assert.equal(body.querySelector('.insp-port')!.querySelector('.port')!.textContent, '8790', 'owners.js / suggestions.js find it like a row');
    const actions = body.querySelector('.insp-actions')!.children.map((b: FakeElement) => [b.textContent, b.dataset.write ?? '']);
    assert.deepEqual(actions, [['열기 ↗', ''], ['공개 해제', '1'], ['로그', ''], ['재시작', '1'], ['중지', '1'], ['상세 페이지', '']]);
    assert.deepEqual(body.querySelectorAll('h3').map((x: FakeElement) => x.textContent), ['무엇인지', '주소', '업/다운', '누가 쓰나', '로그 · 마지막 40줄']);
    assert.match(body.querySelector('.insp-list')!.textContent, /mac ×2/);
  } finally {
    // nothing selected: the empty state, and the logs tail's timer stops
    renderInspector(api.inspector, null, ctx);
  }
  assert.match(doc.getElementById('inspBody')!.textContent, /포트를 고르면/);
});

test('boot: the remembered widths and the modes are on <html> before the first paint', () => {
  const doc = new FakeDocument();
  globalThis.document = doc as any;
  loadPage(doc, served('index.html'));
  const boot = runBoot(BOOT, doc, fakeWindow(1220, new Map([['pb.shell', '{"side":true,"insp":true,"sideW":420,"inspW":480}']])));
  boot.start({ inspector: true, ...bootLocale('ko') });
  const root = doc.documentElement;
  assert.equal(root.style['--side-open'], '420px');
  assert.equal(root.style['--insp-open'], '480px');
  // 1220 < 420 + 8 + 324 + 480: the inspector is a sheet already at the first paint
  assert.deepEqual([root.dataset.sideMode, root.dataset.inspMode], ['column', 'overlay']);
  const plain = new FakeDocument();
  globalThis.document = plain as any;
  loadPage(plain, served('index.html'));
  runBoot(BOOT, plain, fakeWindow(1440, new Map([['pb.shell', '{"sideW":"wide"}']]))).start({ inspector: true, ...bootLocale('ko') });
  assert.equal(plain.documentElement.style['--side-open'], '288px');
  assert.deepEqual([plain.documentElement.dataset.sideMode, plain.documentElement.dataset.inspMode], ['column', 'column']);
});

test('resize handles: server-rendered separators outside the bar, with the default widths', () => {
  const html = served('index.html');
  assert.match(html, /<div id="sideHandle" class="pane-handle side-handle" role="separator" tabindex="0" aria-orientation="vertical" aria-controls="shellSide" data-t-aria-label="shell.sideHandle" aria-label="사이드바 너비" aria-valuemin="200" aria-valuemax="420" aria-valuenow="288"/);
  assert.match(html, /<div id="inspHandle" class="pane-handle insp-handle" role="separator" tabindex="0" aria-orientation="vertical" aria-controls="inspector" data-t-aria-label="shell.inspHandle" aria-label="상세 패널 너비" aria-valuemin="280" aria-valuemax="480" aria-valuenow="300"/);
  assert.ok(!served('dev.html').includes('id="inspHandle"'), 'no inspector, no handle');
  // the Mac app drags the window by header.top only (lib/macapp.js barReport): the handles are not in it
  const { doc, header } = mount(1440, { userAgent: 'Mozilla/5.0 portboard-mac/1.0' });
  assert.ok(!header.contains(doc.getElementById('sideHandle')) && !header.contains(doc.getElementById('inspHandle')));
});

test('resize: drag past 3 px, clamp to 200–420 and the list\'s 324 px, collapse under 100, a click toggles', () => {
  const storage = new Map<string, string>();
  const { doc, $ } = mount(1440, { storage });
  const root = doc.documentElement;
  const h = $('sideHandle');
  const drag = (el: FakeElement, from: number, ...xs: number[]) => {
    el.dispatch('pointerdown', { button: 0, clientX: from, pointerId: 1 });
    for (const x of xs) el.dispatch('pointermove', { clientX: x, pointerId: 1 });
    el.dispatch('pointerup', { clientX: xs.at(-1) ?? from, pointerId: 1 });
  };
  // 2 px is still a click: it toggles the sidebar
  drag(h, 288, 290);
  assert.equal(root.dataset.side, 'closed');
  assert.equal(h.getAttribute('aria-valuetext'), '닫힘');
  drag(h, 0);
  assert.equal(root.dataset.side, 'open');
  // a real drag: wider, live on <html>, saved on release
  drag(h, 288, 292, 340);
  assert.equal(root.style['--side-open'], '340px');
  assert.equal(h.getAttribute('aria-valuenow'), '340');
  assert.equal(JSON.parse(storage.get('pb.shell')!).sideW, 340);
  assert.ok(!('resizing' in root.dataset));
  // past the max: 420
  drag(h, 340, 900);
  assert.equal(root.style['--side-open'], '420px');
  // under the min: 200; under half of it: closed (the width stays for next time)
  drag(h, 420, 150);
  assert.equal(root.style['--side-open'], '200px');
  drag(h, 200, 90);
  assert.equal(root.dataset.side, 'closed');
  assert.equal(JSON.parse(storage.get('pb.shell')!).side, false);
  assert.equal(JSON.parse(storage.get('pb.shell')!).sideW, 200);
  // dragging from the closed edge opens it at the pointer
  drag($('sideHandle'), 0, 10, 260);
  assert.deepEqual([root.dataset.side, root.style['--side-open']], ['open', '260px']);

  // the inspector's handle is its left edge: left widens it, up to 480 and the list's 324 px
  const ih = $('inspHandle');
  drag(ih, 1140, 1100);
  assert.equal(root.style['--insp-open'], '340px');
  drag(ih, 1100, 100);
  assert.equal(root.style['--insp-open'], '480px');
  drag(ih, 900, 1400);
  assert.equal(root.style['--insp-open'], '280px', 'never under its minimum, and it does not collapse');
  assert.equal(root.dataset.insp, 'open');

  // a narrow window caps the sidebar so the list keeps 324 px next to the inspector column
  const tight = mount(1200, { storage: new Map([['pb.shell', '{"inspW":480}']]) });
  tight.$('sideHandle').dispatch('pointerdown', { button: 0, clientX: 288, pointerId: 1 });
  tight.$('sideHandle').dispatch('pointermove', { clientX: 600, pointerId: 1 });
  assert.equal(tight.doc.documentElement.style['--side-open'], `${1200 - 8 - 324 - 480}px`);
  assert.equal(tight.doc.documentElement.dataset.inspMode, 'column', 'the drag never pushes the inspector into a sheet');
});

test('resize: ← → / Home / End on a focused handle, Enter toggles the sidebar; a window resize moves the modes', () => {
  const storage = new Map<string, string>();
  const { doc, win, $, api } = mount(1440, { storage });
  const root = doc.documentElement;
  const press = (el: FakeElement, key: string, mods: Record<string, boolean> = {}) => el.dispatch('keydown', { key, ...mods });
  press($('sideHandle'), 'ArrowRight');
  assert.equal(root.style['--side-open'], '296px');
  press($('sideHandle'), 'ArrowLeft', { shiftKey: true });
  assert.equal(root.style['--side-open'], '264px');
  press($('sideHandle'), 'End');
  assert.equal($('sideHandle').getAttribute('aria-valuenow'), '420');
  press($('sideHandle'), 'Home');
  assert.equal($('sideHandle').getAttribute('aria-valuenow'), '200');
  assert.equal(JSON.parse(storage.get('pb.shell')!).sideW, 200);
  press($('inspHandle'), 'ArrowLeft');
  assert.equal(root.style['--insp-open'], '308px', 'left widens the inspector');
  press($('sideHandle'), 'Enter');
  assert.equal(root.dataset.side, 'closed');
  press($('sideHandle'), 'Enter');
  assert.equal(root.dataset.side, 'open');

  // both at their widest, then the window narrows under 420 + 8 + 324 + 480: the inspector becomes the sheet
  press($('sideHandle'), 'End');
  press($('inspHandle'), 'End');
  assert.equal(root.dataset.inspMode, 'column');
  win.innerWidth = 1220;
  win.fire('resize');
  assert.equal(root.dataset.inspMode, 'overlay');
  assert.equal(api.inspector.shown, false, 'a sheet that was not asked for');
  api.inspector.open();
  assert.ok('inspOverlay' in root.dataset);
  win.innerWidth = 1440;
  win.fire('resize');
  assert.equal(root.dataset.inspMode, 'column');
  assert.ok(!('inspOverlay' in root.dataset), 'back to a column: the sheet is gone');
  // a 420 sidebar is a drawer under 752
  win.innerWidth = 740;
  win.fire('resize');
  assert.equal(root.dataset.sideMode, 'overlay');
  $('sideToggle').click();
  assert.ok('sideOverlay' in root.dataset, 'the toggle opens the drawer');
});

test('keys: ⌘\\ and ⌘/ go through lib/keys.js; ⌘/ opens 키보드 단축키 with the Mac app\'s keys in the app', () => {
  const { doc } = mount(1440, { userAgent: 'Mozilla/5.0 portboard-mac/1.0' });
  const root = doc.documentElement;
  assert.ok(doc.key('\\', { ctrlKey: true }));
  assert.equal(root.dataset.side, 'closed');
  // ⌘\ works while typing too (as before); a plain "\" does nothing
  assert.ok(doc.key('\\', { metaKey: true }, doc.getElementById('q')));
  assert.equal(root.dataset.side, 'open');
  assert.equal(doc.key('\\'), false);
  assert.ok(doc.key('/', { metaKey: true }));
  const d = doc.getElementById('keysDialog')!;
  assert.ok(d, 'the dialog');
  const text = d.textContent;
  assert.match(text, /키보드 단축키/);
  for (const s of ['전체', '목록', '패널', 'Mac 앱', '검색·명령', '사이드바 열기·닫기', '브라우저에서 열기']) assert.ok(text.includes(s), s);
  // Escape with nothing open is the browser's
  assert.equal(doc.key('Escape'), false);
});
