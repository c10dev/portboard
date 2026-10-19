// 설정 tab · 정보 (GET /api/settings, src/features/settings.ts): the version, the commit deployed (deployed.json) and
// the one this process runs, the addresses (dashboard https :8443 tailnet only, connector https 443 public via
// Funnel, :8790 direct read-only), this server's site values (portboard.json, docs/config.md) and the docs.

import { tryJSON } from '../lib/api.js';
import { $, button, el, extLink, h } from '../lib/dom.js';
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
  return h('span', null, h('code', null, url), ' ', button('복사', () => copy(url), { title: '주소 복사' }), h('span', { class: 'set-note', style: 'display:block;margin:2px 0 0' }, note.what));
}

const SOURCE = { env: '환경 변수', runtime: '실행 중 확인', file: 'portboard.json', default: '기본값' };
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
    : h('span', null, h('code', null, site.file), h('span', { class: 'set-note', style: 'margin:0 0 0 6px' }, site.fileFound ? '사용 중' : '없음 (기본값과 실행 중 확인한 값을 써요)'));
  return [
    h('dt', null, '이 서버'), h('dd', null, h('code', null, site.host), ' · ', h('code', null, site.dnsName), src('dnsName', site)),
    h('dt', null, '체크아웃'), h('dd', null, h('code', null, site.checkout), src('checkout', site)),
    h('dt', null, '저장소 루트'), h('dd', null, site.reposRoots.map((r, i) => [i ? ', ' : '', h('code', null, r)]), src('reposRoots', site)),
    h('dt', null, 'compute-pool'), h('dd', null, h('code', null, site.poolUrl), src('poolUrl', site)),
    h('dt', null, '설정 파일'), h('dd', null, file),
    ...(site.checkoutFile ? [h('dt', null, '체크아웃 설정'), h('dd', null, h('code', null, site.checkoutFile), h('span', { class: 'set-note', style: 'margin:0 0 0 6px' }, '사용 중 (위 파일이 키마다 이겨요)'))] : []),
  ];
}

function paint(s) {
  const body = $('aboutBody');
  const a = s.addresses;
  const deployed = s.deployed
    ? h('span', null, extLink(short(s.deployed.commit), COMMIT + s.deployed.commit), s.deployed.at ? ` · ${when(s.deployed.at)}` : '')
    : h('span', { class: 'set-note', style: 'margin:0' }, 'deployed.json 없음 (scripts/deploy.sh로 배포한 적 없음)');
  const running = s.running
    ? h('span', null, extLink(short(s.running), COMMIT + s.running), s.deployed && s.deployed.commit !== s.running ? h('span', { class: 'set-state warn' }, ' · 배포된 커밋과 달라요') : null)
    : '알 수 없음';
  body.replaceChildren(
    h(
      'dl',
      { class: 'set-kv' },
      h('dt', null, '버전'), h('dd', null, `Portboard ${s.version}${s.profile === 'production' ? '' : ` · 미리보기 (포트 ${s.port})`}`),
      h('dt', null, '배포된 커밋'), h('dd', null, deployed),
      h('dt', null, '이 서버의 커밋'), h('dd', null, running),
      h('dt', null, '대시보드'), h('dd', null, addr(a.dashboard, { what: 'https, tailscale serve · tailnet 기기만 열려요 · 소유자 계정이면 바꿀 수 있어요', missing: 'tailscale serve가 대시보드를 공개하고 있지 않아요' })),
      h('dt', null, '원격 커넥터'), h('dd', null, addr(a.connector, { what: `https${a.connectorPort && a.connectorPort !== 443 ? ` :${a.connectorPort}` : ' 443'}, Tailscale Funnel · 인터넷에 공개 · 읽기 전용 MCP, 승인 코드로만 연결`, missing: 'remote.json에 공개 주소(publicUrl)가 없어요' })),
      h('dt', null, '직접 주소'), h('dd', null, addr(a.direct, { what: `http :${portOf(a.direct, '8790')} · tailnet 기기 누구나 · 읽기 전용`, missing: '알 수 없음' })),
      ...siteRows(s.site),
    ),
    h('h3', null, '문서'),
    h('div', { class: 'set-extra', style: 'display:flex;flex-wrap:wrap;gap:6px 14px;font-size:13px' }, s.docs.map((d) => extLink(`${d.label} ↗`, d.href))),
  );
}

async function refresh() {
  const body = $('aboutBody');
  if (!body) return;
  const s = await settingsDoc();
  if (!s) return body.replaceChildren(el('p', 'set-note', '정보를 읽지 못했어요.'));
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
