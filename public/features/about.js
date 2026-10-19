// 설정 tab · 정보 (GET /api/settings, src/features/settings.ts): the version, the commit deployed (deployed.json) and
// the one this process runs, the addresses (dashboard https :8443 tailnet only, connector https 443 public via
// Funnel, :8790 direct read-only), this server's site values (portboard.json, docs/config.md) and the docs.

import { tryJSON } from '../lib/api.js';
import { $, button, el, extLink, h } from '../lib/dom.js';
import { t } from '../lib/i18n.js';
import { when } from '../lib/time.js';
import { copy } from '../lib/toast.js';

let pending = null;
/** GET /api/settings, shared with the 비밀값 section (secrets.js): one request per refresh for both */
export function settingsDoc() {
  if (!pending) {
    pending = tryJSON('/api/settings');
    setTimeout(() => (pending = null), 2_000);
  }
  return pending;
}

const COMMIT = 'https://github.com/c10dev/portboard/commit/';
const short = (c) => c.slice(0, 7);

function addr(url, note) {
  if (!url) return h('span', { class: 'set-note', style: 'margin:0' }, note.missing);
  return h('span', null, h('code', null, url), ' ', button(t('about.copy'), () => copy(url), { title: t('about.copy.title') }), h('span', { class: 'set-note', style: 'display:block;margin:2px 0 0' }, note.what));
}

const SOURCE = { env: t('about.source.env'), runtime: t('about.source.runtime'), file: 'portboard.json', default: t('about.source.default') };
const src = (k, site) => h('span', { class: 'set-note', style: 'margin:0 0 0 6px' }, SOURCE[site.sources?.[k]] ?? '');
const portOf = (url, fallback) => {
  try {
    return new URL(url).port || fallback;
  } catch {
    return fallback;
  }
};

/** 이 서버: the resolved site values (site.ts) and where each came from */
function siteRows(site) {
  if (!site) return [];
  const file = site.fileError
    ? h('span', { class: 'set-state warn' }, `${site.file} · ${site.fileError}`)
    : h('span', null, h('code', null, site.file), h('span', { class: 'set-note', style: 'margin:0 0 0 6px' }, site.fileFound ? t('about.file.inUse') : t('about.file.none')));
  return [
    h('dt', null, t('common.thisServer')), h('dd', null, h('code', null, site.host), ' · ', h('code', null, site.dnsName), src('dnsName', site)),
    h('dt', null, t('about.checkout')), h('dd', null, h('code', null, site.checkout), src('checkout', site)),
    h('dt', null, t('about.reposRoots')), h('dd', null, site.reposRoots.map((r, i) => [i ? ', ' : '', h('code', null, r)]), src('reposRoots', site)),
    h('dt', null, 'compute-pool'), h('dd', null, h('code', null, site.poolUrl), src('poolUrl', site)),
    h('dt', null, t('about.configFile')), h('dd', null, file),
    ...(site.checkoutFile ? [h('dt', null, t('about.checkoutFile')), h('dd', null, h('code', null, site.checkoutFile), h('span', { class: 'set-note', style: 'margin:0 0 0 6px' }, t('about.checkoutFile.note')))] : []),
  ];
}

function paint(s) {
  const body = $('aboutBody');
  const a = s.addresses;
  const deployed = s.deployed
    ? h('span', null, extLink(short(s.deployed.commit), COMMIT + s.deployed.commit), s.deployed.at ? ` · ${when(s.deployed.at)}` : '')
    : h('span', { class: 'set-note', style: 'margin:0' }, t('about.deployed.none'));
  const running = s.running
    ? h('span', null, extLink(short(s.running), COMMIT + s.running), s.deployed && s.deployed.commit !== s.running ? h('span', { class: 'set-state warn' }, ` · ${t('about.running.differs')}`) : null)
    : t('about.unknown');
  body.replaceChildren(
    h(
      'dl',
      { class: 'set-kv' },
      h('dt', null, t('about.version')), h('dd', null, `Portboard ${s.version}${s.profile === 'production' ? '' : ` · ${t('about.preview', { port: s.port })}`}`),
      h('dt', null, t('about.deployed')), h('dd', null, deployed),
      h('dt', null, t('about.running')), h('dd', null, running),
      h('dt', null, t('about.dashboard')), h('dd', null, addr(a.dashboard, { what: t('about.dashboard.what'), missing: t('about.dashboard.missing') })),
      h('dt', null, t('about.connector')), h('dd', null, addr(a.connector, { what: t('about.connector.what', { port: a.connectorPort && a.connectorPort !== 443 ? ` :${a.connectorPort}` : ' 443' }), missing: t('about.connector.missing') })),
      h('dt', null, t('about.direct')), h('dd', null, addr(a.direct, { what: t('about.direct.what', { port: portOf(a.direct, '8790') }), missing: t('about.unknown') })),
      ...siteRows(s.site),
    ),
    h('h3', null, t('about.docs')),
    h('div', { class: 'set-extra', style: 'display:flex;flex-wrap:wrap;gap:6px 14px;font-size:13px' }, s.docs.map((d) => extLink(`${d.label} ↗`, d.href))),
  );
}

async function refresh() {
  const body = $('aboutBody');
  if (!body) return;
  const s = await settingsDoc();
  if (!s) return body.replaceChildren(el('p', 'set-note', t('about.loadFailed')));
  paint(s);
}

/** Fill the section once its container is there: now, or when the 설정 modal has built it (settings:mount) */
function mount() {
  const body = $('aboutBody');
  if (!body || body.dataset.mounted) return;
  body.dataset.mounted = '1';
  refresh();
  document.addEventListener('settings:refresh', refresh);
}

mount();
document.addEventListener('settings:mount', mount);
