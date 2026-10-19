// 설정 tab · 원격 커넥터 (src/features/remote-connector.ts, c10dev/portboard#31): connecting claude.ai and ChatGPT to the
// public read-only MCP, from one place.
//   - the URL to paste (remote.json publicUrl + /mcp) and how to add it in claude.ai and ChatGPT
//   - 승인 코드 만들기 (POST /api/remote/approval-code): the one-time code the consent page asks for, shown once, large,
//     with a countdown; 다시 만들기 replaces it. The page keeps it in memory only: after a reload only "a code is
//     pending until …" is left (GET /api/remote/clients approvalExpiresAt)
//   - who holds a token (clients and their authorizations), with 토큰 취소 / 클라이언트 전체 취소
//   - 커넥터 상태 (src/remote/health.ts, computed by the server): a badge per client and authorization (정상 · 만료 임박 ·
//     응답 없음 · 만료됨) and, when any client isn't 정상, a banner "연결 n개가 확인이 필요해요" with 다시 연결 (the steps,
//     with 승인 코드 만들기) and "n일 동안 숨기기" (this browser only, localStorage; back early when another connection
//     needs a look)
// No token value or code hash ever reaches the page. Moved here from the 기기 tab.

import { postOrThrow, tryJSON } from '../lib/api.js';
import { $, button, el, extLink, h } from '../lib/dom.js';
import { locale, t, tn } from '../lib/i18n.js';
import { agoMonths } from '../lib/time.js';
import { copy, toast } from '../lib/toast.js';

const RUNBOOK = 'https://github.com/c10dev/portboard/blob/main/docs/runbooks/remote-connector.md';

const STYLE = `
.rc { display: grid; gap: 10px; }
.rc-client { padding: 12px 14px; border: 1px solid var(--line); border-radius: 10px; }
.rc-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.rc-head strong { font-size: 14px; }
.rc-head .rc-actions { margin-left: auto; }
.rc-sub { color: var(--muted); font-size: 12.5px; margin: 2px 0 0; }
.rc-grants { list-style: none; margin: 8px 0 0; padding: 0; }
.rc-grants li { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 7px 0; border-top: 1px solid var(--line); font-size: 13px; }
.rc-grants .rc-when { color: var(--muted); }
.rc-grants .rc-actions { margin-left: auto; }
.rc-scope { padding: 0 6px; border-radius: 999px; font: 11px var(--mono); background: var(--neutral-bg); color: var(--muted); }
.rc-kind { padding: 0 6px; border-radius: 999px; font-size: 11px; background: var(--neutral-bg); color: var(--muted); }
.rc-soon { color: var(--warn); }
.rc-note { color: var(--muted); font-size: 12.5px; margin: 0; }
.rc button.danger { color: var(--danger); }
.rc-health { padding: 0 7px; border-radius: 999px; font-size: 11px; font-weight: 600; white-space: nowrap; }
.rc-health.ok { background: var(--ok-bg); color: var(--ok); }
.rc-health.soon, .rc-health.idle { background: var(--warn-bg); color: var(--warn); }
.rc-health.expired { background: var(--neutral-bg); color: var(--danger); }
.rc-banner { display: grid; gap: 8px; margin: 0 0 14px; padding: 10px 14px; border-radius: 10px; background: var(--warn-bg); color: var(--text); }
.rc-banner-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.rc-banner-head strong { color: var(--warn); font-size: 14px; }
.rc-banner-head .rc-actions { margin-left: auto; display: flex; gap: 6px; }
.rc-banner ul { margin: 0; padding-left: 18px; font-size: 13px; }
.rc-banner ol { margin: 0; padding-left: 20px; font-size: 13px; display: grid; gap: 4px; }
`;

const day = (ms) => new Date(ms).toLocaleDateString(locale());
const clock = (ms) => new Date(ms).toLocaleTimeString(locale(),  { hour: '2-digit', minute: '2-digit' });
const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
const left = (ms) => {
  const d = Math.ceil((ms - Date.now()) / 86_400_000);
  return d <= 1 ? t('remote.left.hours', { n: Math.max(1, Math.round((ms - Date.now()) / 3_600_000)) }) : t('remote.left.days', { n: d });
};
const mmss = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** Marks a control as a write, so a read-only viewer sees it greyed out (lib/access.js). */
const write = (b) => (b.setAttribute('data-write', ''), b);

let data = null;
/** The code made on this page: {code, deadline (local ms), used: false | 'ok' | 'burnt', grantsBefore} — never stored anywhere else */
let made = null;
let ticker = null;
/** 다시 연결's steps are open */
let howOpen = false;

// ---------- 커넥터 상태 ----------

const HEALTH = {
  ok: [t('remote.health.ok'), t('remote.health.ok.tip')],
  soon: [t('remote.health.soon'), t('remote.health.soon.tip')],
  idle: [t('remote.health.idle'), t('remote.health.idle.tip')],
  expired: [t('remote.health.expired'), t('remote.health.expired.tip')],
};
const healthBadge = (health) => (health && HEALTH[health] ? h('span', { class: `rc-health ${health}`, title: HEALTH[health][1], dataset: { health } }, HEALTH[health][0]) : null);
const attentionOf = () => data.clients.filter((c) => c.health && c.health !== 'ok');

const HIDE_KEY = 'portboard.remoteHealth.hidden';
/** What the banner is about: hiding it holds until that changes (another client, another state) or the days run out */
const sigOf = (list) => list.map((c) => `${c.id}:${c.health}`).sort().join(',');
function hidden(sig) {
  try {
    const v = JSON.parse(localStorage.getItem(HIDE_KEY) ?? 'null');
    return !!v && v.sig === sig && typeof v.until === 'number' && v.until > Date.now();
  } catch {
    return false;
  }
}
function hide(sig, days) {
  try {
    localStorage.setItem(HIDE_KEY, JSON.stringify({ sig, until: Date.now() + days * 86_400_000 }));
  } catch {
    // private window or storage blocked: hidden for this page view only
  }
}

function why(c) {
  const used = c.lastUsedAt ? t('remote.lastUsed', { ago: agoMonths(iso(c.lastUsedAt)) }) : t('remote.neverUsed');
  const end = c.health === 'soon' ? data.grants.filter((g) => g.clientId === c.id).map((g) => g.expiresAt).sort((a, b) => b - a)[0] : null;
  return [used, end ? t('remote.grantLeft', { left: left(end) }) : null].filter(Boolean).join(' · ');
}

function banner() {
  const list = attentionOf();
  const sig = sigOf(list);
  if (!list.length || (hidden(sig) && !howOpen)) return null;
  const days = data.thresholds?.hideDays ?? 7;
  const box = h(
    'div',
    { class: 'rc-banner', id: 'rcBanner', role: 'status' },
    h(
      'div',
      { class: 'rc-banner-head' },
      h('strong', null, t('remote.banner.title', { n: list.length })),
      h(
        'span',
        { class: 'rc-actions' },
        button(howOpen ? t('common.close') : t('remote.banner.reconnect'), () => {
          howOpen = !howOpen;
          paint();
        }, { title: t('remote.banner.reconnect.title') }),
        button(t('remote.banner.hide', { n: days }), () => {
          hide(sig, days);
          howOpen = false;
          paint();
        }, { title: t('remote.banner.hide.title') }),
      ),
    ),
    h('ul', null, list.map((c) => h('li', null, h('b', null, c.name || t('remote.unnamed')), ' ', healthBadge(c.health), ` ${why(c)}`))),
  );
  if (howOpen) {
    box.append(
      h(
        'ol',
        { id: 'rcHow' },
        list.some((c) => c.health === 'idle' || c.health === 'soon')
          ? h('li', null, t('remote.how.idle'))
          : null,
        h('li', null, tn('remote.how.code', { button: write(button(t('remote.makeCode'), async () => {
          await makeCode();
          $('acBox')?.scrollIntoView({ block: 'center' });
        }, { title: t('remote.makeCode.title') })) })),
        h('li', null, tn('remote.how.apps')),
        h('li', null, t('remote.how.approve')),
      ),
    );
  }
  return box;
}

// ---------- the URL and how to connect ----------

function urlBox() {
  if (!data.connectorUrl) {
    return h(
      'p',
      { class: 'set-note' },
      data.profile === 'production'
        ? t('remote.url.none')
        : t('remote.url.nonePreview'),
      extLink(t('remote.url.docs'), 'https://github.com/c10dev/portboard/blob/main/docs/remote-mcp/README.md'),
    );
  }
  return h(
    'div',
    null,
    h('div', { class: 'set-url' }, h('span', { class: 'set-note', style: 'margin:0' }, t('remote.url.label')), h('code', { id: 'rcUrl' }, data.connectorUrl), button(t('remote.copy'), () => copy(data.connectorUrl), { title: t('remote.url.copy') })),
    h(
      'ol',
      { class: 'set-howto' },
      h('li', null, tn('remote.howto.claude')),
      h('li', null, tn('remote.howto.chatgpt')),
      h('li', null, tn('remote.howto.approve')),
    ),
  );
}

// ---------- 승인 코드 ----------

function codeState() {
  if (made && !made.used && made.deadline > Date.now()) return null; // the big code says it all
  if (data.approvalExpiresAt && data.approvalExpiresAt > Date.now()) {
    return t('remote.code.pending', { until: clock(data.approvalExpiresAt), n: Math.max(1, Math.ceil((data.approvalExpiresAt - Date.now()) / 60_000)) });
  }
  return t('remote.code.none');
}

function codeBox() {
  const box = h('div', { class: 'ac', id: 'acBox' }, h('h3', { style: 'margin-top:0' }, t('remote.code.title')));
  const state = codeState();
  if (state) box.append(h('p', { class: 'set-note', id: 'acState', style: 'margin-top:0' }, state));
  if (made) {
    const live = !made.used && made.deadline > Date.now();
    box.append(
      h(
        'div',
        { class: `ac-code${live ? '' : ' expired'}`, id: 'acCode' },
        h('code', { 'aria-label': t('remote.code.title') }, made.code),
        h('span', { class: 'ac-timer', id: 'acTimer', 'aria-live': 'off' }, made.used === 'ok' ? t('remote.code.used') : made.used ? t('remote.code.dead') : live ? t('remote.code.left', { time: mmss(made.deadline - Date.now()) }) : t('remote.code.expired')),
        live ? button(t('remote.copy'), () => copy(made.code), { title: t('remote.code.copy') }) : null,
      ),
      h('p', { class: 'set-note' }, made.used === 'ok' ? t('remote.code.note.ok') : made.used ? t('remote.code.note.burnt') : live ? t('remote.code.note.live') : t('remote.code.note.expired')),
    );
  }
  box.append(
    h(
      'div',
      { class: 'ac-actions' },
      write(button(made ? t('remote.code.remake') : t('remote.makeCode'), makeCode, { title: t('remote.code.make.title') })),
      h('span', { class: 'set-note', style: 'margin:0' }, t('remote.code.rules')),
    ),
  );
  if (data.profile !== 'production') box.append(h('p', { class: 'set-note' }, t('remote.code.preview')));
  return box;
}

async function makeCode() {
  try {
    const r = await postOrThrow('/api/remote/approval-code');
    made = { code: r.code, deadline: Date.now() + r.ttlMs, used: false, grantsBefore: data?.grants.length ?? 0 };
    toast(r.replaced ? t('remote.code.replaced') : t('remote.code.made'), false, { ms: 3000 });
  } catch (err) {
    toast(t('remote.code.failed', { error: err.message }), true, { ms: 6000 });
  }
  await refresh();
  startTicker();
}

/** The countdown, and a light poll while the code is live: once the consent page used it, say so and list the client. */
function startTicker() {
  clearInterval(ticker);
  if (!made || made.used) return;
  let n = 0;
  ticker = setInterval(async () => {
    const timer = $('acTimer');
    if (!made || made.used || made.deadline <= Date.now() || !timer) {
      clearInterval(ticker);
      paint();
      return;
    }
    timer.textContent = t('remote.code.left', { time: mmss(made.deadline - Date.now()) });
    if (++n % 5 === 0 && !document.hidden) {
      const next = await tryJSON('/api/remote/clients');
      if (next && !next.pendingApproval && made && made.deadline > Date.now()) {
        // gone before its time: used for an approval (a new grant), or burnt by too many wrong tries
        made.used = next.grants.length > made.grantsBefore ? 'ok' : 'burnt';
        data = next;
        clearInterval(ticker);
        paint();
      }
    }
  }, 1000);
}

// ---------- clients and tokens ----------

async function revoke(path, question) {
  if (!window.confirm(question)) return;
  try {
    const r = await postOrThrow(path);
    toast(t('remote.revoked', { n: r.revoked.tokens }), false, { ms: 3500 });
  } catch (err) {
    toast(t('remote.revokeFailed', { error: err.message }), true, { ms: 5000 });
  }
  refresh();
}

function grantRow(g) {
  const used = g.lastUsedAt ? t('remote.lastUsed', { ago: agoMonths(iso(g.lastUsedAt)) }) : t('remote.notYetUsed');
  const soon = g.health === 'soon';
  return h(
    'li',
    { dataset: { grant: g.id } },
    healthBadge(g.health),
    h('span', { class: 'rc-when' }, t('remote.grant.approved', { date: day(g.createdAt) })),
    h('span', null, used),
    h('span', { class: soon ? 'rc-soon' : 'rc-when', title: t('remote.grant.refreshExpires', { when: new Date(g.expiresAt).toLocaleString(locale()) }) }, t('remote.grant.expires', { date: day(g.expiresAt), left: left(g.expiresAt) })),
    ...g.scopes.map((s) => h('span', { class: 'rc-scope' }, s)),
    h(
      'span',
      { class: 'rc-actions' },
      write(button(t('remote.revokeToken'), () => revoke(`/api/remote/tokens/${encodeURIComponent(g.id)}/revoke`, t('remote.grant.confirm', { client: g.clientName || t('remote.thisClient'), date: day(g.createdAt) })), { danger: true })),
    ),
  );
}

function clientCard(c) {
  const mine = data.grants.filter((g) => g.clientId === c.id);
  const kind = c.kind === 'hosted' ? t('remote.kind.hosted') : t('remote.kind.registered');
  const sub = [
    c.redirectHosts.length ? t('remote.client.redirect', { hosts: c.redirectHosts.join(', ') }) : null,
    c.createdAt ? (c.kind === 'hosted' ? t('remote.client.firstApproved', { date: day(c.createdAt) }) : t('remote.client.registered', { date: day(c.createdAt) })) : null,
    c.lastUsedAt ? t('remote.lastUsed', { ago: agoMonths(iso(c.lastUsedAt)) }) : t('remote.neverUsed'),
  ].filter(Boolean);
  const what = c.kind === 'registered' ? t('remote.client.confirmRegistered') : t('remote.client.confirmHosted');
  const card = h(
    'div',
    { class: 'rc-client', dataset: { client: c.id } },
    h(
      'div',
      { class: 'rc-head' },
      h('strong', null, c.name || t('remote.unnamed')),
      healthBadge(c.health),
      h('span', { class: 'rc-kind' }, kind),
      h('span', { class: 'rc-kind' }, t('remote.client.grants', { n: c.grants })),
      h(
        'span',
        { class: 'rc-actions' },
        write(button(t('remote.revokeClient'), () => revoke(`/api/remote/clients/${encodeURIComponent(c.id)}/revoke`, t('remote.client.confirm', { client: c.name || t('remote.thisClient'), what })), { danger: true })),
      ),
    ),
    h('p', { class: 'rc-sub' }, sub.join(' · ')),
  );
  if (mine.length) card.append(h('ul', { class: 'rc-grants' }, mine.map(grantRow)));
  else card.append(h('p', { class: 'rc-note' }, c.health === 'expired' ? t('remote.client.noTokensExpired') : t('remote.client.noTokens')));
  return card;
}

function clientsBox() {
  return h(
    'div',
    null,
    h('h3', null, data.clients.length ? t('remote.clients.titleCount', { n: data.clients.length }) : t('remote.clients.title')),
    h(
      'section',
      { id: 'remoteConnector', class: 'rc', 'aria-label': t('remote.clients.title') },
      data.clients.map(clientCard),
      h(
        'p',
        { class: 'rc-note' },
        data.clients.length ? t('remote.clients.revokeNote') : t('remote.clients.none'),
        extLink(t('remote.clients.runbook'), RUNBOOK),
      ),
    ),
  );
}

function paint() {
  const box = $('remoteBody');
  if (!box || !data) return;
  box.replaceChildren(...[banner(), urlBox(), codeBox(), clientsBox()].filter(Boolean));
}

async function refresh() {
  const box = $('remoteBody');
  if (!box) return;
  const next = await tryJSON('/api/remote/clients');
  if (!next) {
    box.replaceChildren(el('p', 'set-note', t('remote.loadFailed')));
    return;
  }
  data = next;
  paint();
}

/** Fill the section once its container is there: now, or when the 설정 modal has built it (settings:mount) */
function mount() {
  const body = $('remoteBody');
  if (!body || body.dataset.mounted) return;
  body.dataset.mounted = '1';
  if (!$('rcStyle')) document.head.append(h('style', { id: 'rcStyle', text: STYLE }));
  refresh();
  document.addEventListener('settings:refresh', refresh);
}

mount();
document.addEventListener('settings:mount', mount);
