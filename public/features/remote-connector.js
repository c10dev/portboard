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

const day = (ms) => new Date(ms).toLocaleDateString();
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
const left = (ms) => {
  const d = Math.ceil((ms - Date.now()) / 86_400_000);
  return d <= 1 ? `${Math.max(1, Math.round((ms - Date.now()) / 3_600_000))}시간 남음` : `${d}일 남음`;
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
  ok: ['정상', '토큰이 살아 있고 최근에 쓰였어요'],
  soon: ['만료 임박', '곧 승인이 끝나요. 그 앱에서 Portboard를 한 번 쓰면 연장되고, 안 되면 다시 연결하세요'],
  idle: ['응답 없음', '토큰은 살아 있지만 한동안 호출이 없어요. 그 앱에서 한 번 써 보고, 안 되면 다시 연결하세요'],
  expired: ['만료됨', '유효한 토큰이 없어요. 다시 연결해야 해요'],
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
  const used = c.lastUsedAt ? `마지막 사용 ${agoMonths(iso(c.lastUsedAt))}` : '사용 기록 없음';
  const end = c.health === 'soon' ? data.grants.filter((g) => g.clientId === c.id).map((g) => g.expiresAt).sort((a, b) => b - a)[0] : null;
  return [used, end ? `승인 ${left(end)}` : null].filter(Boolean).join(' · ');
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
      h('strong', null, `연결 ${list.length}개가 확인이 필요해요`),
      h(
        'span',
        { class: 'rc-actions' },
        button(howOpen ? '닫기' : '다시 연결', () => {
          howOpen = !howOpen;
          paint();
        }, { title: '다시 연결하는 방법' }),
        button(`${days}일 동안 숨기기`, () => {
          hide(sig, days);
          howOpen = false;
          paint();
        }, { title: '이 브라우저에서만 숨겨요. 다른 연결에 문제가 생기면 다시 보여요.' }),
      ),
    ),
    h('ul', null, list.map((c) => h('li', null, h('b', null, c.name || '이름 없는 클라이언트'), ' ', healthBadge(c.health), ` ${why(c)}`))),
  );
  if (howOpen) {
    box.append(
      h(
        'ol',
        { id: 'rcHow' },
        list.some((c) => c.health === 'idle' || c.health === 'soon')
          ? h('li', null, '응답 없음·만료 임박은 끊긴 게 아닐 수도 있어요. 그 앱에서 Portboard 도구를 한 번 쓰면 정상으로 돌아와요. 안 되면 아래 순서대로 다시 연결하세요.')
          : null,
        h('li', null, '이 페이지에서 ', write(button('승인 코드 만들기', async () => {
          await makeCode();
          $('acBox')?.scrollIntoView({ block: 'center' });
        }, { title: '10분 동안 한 번 쓸 수 있는 코드' })), ' 로 코드를 받으세요 (10분 · 한 번만).'),
        h('li', null, h('b', null, 'claude.ai'), ': 설정 → 커넥터 → Portboard → 연결 해제 후 다시 ', h('b', null, '연결'), '. ', h('b', null, 'ChatGPT'), ': 설정 → 앱 및 커넥터 → Portboard → 연결 해제 후 다시 연결.'),
        h('li', null, '"Portboard 원격 접근 승인" 화면에 코드를 넣고 승인하세요. 새 승인이 아래 목록에 정상으로 보이면 끝이에요. 남은 옛 승인은 토큰 취소로 지워도 돼요.'),
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
        ? '아직 공개 주소가 없어요 (remote.json의 publicUrl). 공개 설정은 원격 MCP 문서를 보세요. '
        : '미리보기: 이 미리보기의 remote.json에는 공개 주소가 없어요 (운영 커넥터와 별개). ',
      extLink('원격 MCP 문서 ↗', 'https://github.com/c10dev/portboard/blob/main/docs/remote-mcp/README.md'),
    );
  }
  return h(
    'div',
    null,
    h('div', { class: 'set-url' }, h('span', { class: 'set-note', style: 'margin:0' }, '붙여 넣을 주소'), h('code', { id: 'rcUrl' }, data.connectorUrl), button('복사', () => copy(data.connectorUrl), { title: '주소 복사' })),
    h(
      'ol',
      { class: 'set-howto' },
      h('li', null, h('b', null, 'claude.ai'), ': 설정 → 커넥터 → ', h('b', null, '커스텀 커넥터 추가'), ' → 이름 Portboard, 위 주소 붙여넣기 → 연결.'),
      h('li', null, h('b', null, 'ChatGPT'), ': 설정 → 앱 및 커넥터 → 고급 설정에서 개발자 모드 켜기 → ', h('b', null, '만들기'), ' → 위 주소, 인증 OAuth.'),
      h('li', null, '"Portboard 원격 접근 승인" 화면이 열리면 아래 ', h('b', null, '승인 코드 만들기'), '로 받은 코드를 넣고 승인하세요. 10분 동안 한 번만 쓸 수 있어요.'),
    ),
  );
}

// ---------- 승인 코드 ----------

function codeState() {
  if (made && !made.used && made.deadline > Date.now()) return null; // the big code says it all
  if (data.approvalExpiresAt && data.approvalExpiresAt > Date.now()) {
    return `대기 중인 코드가 하나 있어요 · ${clock(data.approvalExpiresAt)}까지 (${Math.max(1, Math.ceil((data.approvalExpiresAt - Date.now()) / 60_000))}분 남음). 코드는 만들 때 한 번만 보여요 — 모르면 다시 만드세요 (이전 코드는 무효가 돼요).`;
  }
  return '대기 중인 코드 없음. 연결할 때 만들면 돼요.';
}

function codeBox() {
  const box = h('div', { class: 'ac', id: 'acBox' }, h('h3', { style: 'margin-top:0' }, '승인 코드'));
  const state = codeState();
  if (state) box.append(h('p', { class: 'set-note', id: 'acState', style: 'margin-top:0' }, state));
  if (made) {
    const live = !made.used && made.deadline > Date.now();
    box.append(
      h(
        'div',
        { class: `ac-code${live ? '' : ' expired'}`, id: 'acCode' },
        h('code', { 'aria-label': '승인 코드' }, made.code),
        h('span', { class: 'ac-timer', id: 'acTimer', 'aria-live': 'off' }, made.used === 'ok' ? '사용됐어요 ✓' : made.used ? '더 못 써요' : live ? `${mmss(made.deadline - Date.now())} 남음` : '만료됐어요'),
        live ? button('복사', () => copy(made.code), { title: '코드 복사' }) : null,
      ),
      h('p', { class: 'set-note' }, made.used === 'ok' ? '이 코드로 연결이 승인됐어요. 아래 목록에 클라이언트가 보여요.' : made.used ? '이 코드는 사용됐거나 틀린 시도가 너무 많아 무효가 됐어요. 필요하면 다시 만드세요.' : live ? '승인 화면의 승인 코드 칸에 넣으세요. 대소문자와 - 는 상관없어요. 이 화면을 닫으면 다시 볼 수 없어요.' : '이 코드는 더 못 써요. 다시 만드세요.'),
    );
  }
  box.append(
    h(
      'div',
      { class: 'ac-actions' },
      write(button(made ? '다시 만들기' : '승인 코드 만들기', makeCode, { title: '10분 동안 한 번 쓸 수 있는 코드. 새로 만들면 이전 코드는 무효가 돼요.' })),
      h('span', { class: 'set-note', style: 'margin:0' }, '10분 · 한 번만 · 새로 만들면 이전 코드는 무효'),
    ),
  );
  if (data.profile !== 'production') box.append(h('p', { class: 'set-note' }, '미리보기: 이 미리보기의 remote.json에 만드는 코드라 운영 커넥터(claude.ai·ChatGPT)에는 쓸 수 없어요.'));
  return box;
}

async function makeCode() {
  try {
    const r = await postOrThrow('/api/remote/approval-code');
    made = { code: r.code, deadline: Date.now() + r.ttlMs, used: false, grantsBefore: data?.grants.length ?? 0 };
    toast(r.replaced ? '새 승인 코드를 만들었어요 (이전 코드는 무효)' : '승인 코드를 만들었어요', false, { ms: 3000 });
  } catch (err) {
    toast(`코드를 만들지 못했어요: ${err.message}`, true, { ms: 6000 });
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
    const t = $('acTimer');
    if (!made || made.used || made.deadline <= Date.now() || !t) {
      clearInterval(ticker);
      paint();
      return;
    }
    t.textContent = `${mmss(made.deadline - Date.now())} 남음`;
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
    toast(`토큰 ${r.revoked.tokens}개를 취소했어요`, false, { ms: 3500 });
  } catch (err) {
    toast(`취소 실패: ${err.message}`, true, { ms: 5000 });
  }
  refresh();
}

function grantRow(g) {
  const used = g.lastUsedAt ? `마지막 사용 ${agoMonths(iso(g.lastUsedAt))}` : '아직 안 씀';
  const soon = g.health === 'soon';
  return h(
    'li',
    { dataset: { grant: g.id } },
    healthBadge(g.health),
    h('span', { class: 'rc-when' }, `${day(g.createdAt)} 승인`),
    h('span', null, used),
    h('span', { class: soon ? 'rc-soon' : 'rc-when', title: `리프레시 토큰 만료 ${new Date(g.expiresAt).toLocaleString()}` }, `만료 ${day(g.expiresAt)} (${left(g.expiresAt)})`),
    ...g.scopes.map((s) => h('span', { class: 'rc-scope' }, s)),
    h(
      'span',
      { class: 'rc-actions' },
      write(button('토큰 취소', () => revoke(`/api/remote/tokens/${encodeURIComponent(g.id)}/revoke`, `${g.clientName || '이 클라이언트'}의 이 승인(${day(g.createdAt)})을 취소할까요?\n\n접근 토큰과 리프레시 토큰이 바로 무효가 돼요. 다시 쓰려면 승인 코드로 다시 연결해야 해요.`), { danger: true })),
    ),
  );
}

function clientCard(c) {
  const mine = data.grants.filter((g) => g.clientId === c.id);
  const kind = c.kind === 'hosted' ? '호스팅 클라이언트' : '등록된 클라이언트';
  const sub = [
    c.redirectHosts.length ? `리디렉트 ${c.redirectHosts.join(', ')}` : null,
    c.createdAt ? `${c.kind === 'hosted' ? '첫 승인' : '등록'} ${day(c.createdAt)}` : null,
    c.lastUsedAt ? `마지막 사용 ${agoMonths(iso(c.lastUsedAt))}` : '사용 기록 없음',
  ].filter(Boolean);
  const what = c.kind === 'registered' ? '이 클라이언트의 모든 토큰과 등록을 지울까요?' : '이 클라이언트의 모든 토큰을 취소할까요?';
  const card = h(
    'div',
    { class: 'rc-client', dataset: { client: c.id } },
    h(
      'div',
      { class: 'rc-head' },
      h('strong', null, c.name || '이름 없는 클라이언트'),
      healthBadge(c.health),
      h('span', { class: 'rc-kind' }, kind),
      h('span', { class: 'rc-kind' }, `승인 ${c.grants}개`),
      h(
        'span',
        { class: 'rc-actions' },
        write(button('클라이언트 전체 취소', () => revoke(`/api/remote/clients/${encodeURIComponent(c.id)}/revoke`, `${c.name || '이 클라이언트'}: ${what}\n\n바로 끊기고, 다시 연결하려면 승인 코드를 새로 만들어야 해요.`), { danger: true })),
      ),
    ),
    h('p', { class: 'rc-sub' }, sub.join(' · ')),
  );
  if (mine.length) card.append(h('ul', { class: 'rc-grants' }, mine.map(grantRow)));
  else card.append(h('p', { class: 'rc-note' }, c.health === 'expired' ? '유효한 토큰 없음: 토큰이 모두 만료됐어요. 다시 연결하거나 클라이언트 전체 취소로 지우세요.' : '유효한 토큰 없음 (등록만 남아 있어요)'));
  return card;
}

function clientsBox() {
  return h(
    'div',
    null,
    h('h3', null, `연결된 클라이언트${data.clients.length ? ` ${data.clients.length}` : ''}`),
    h(
      'section',
      { id: 'remoteConnector', class: 'rc', 'aria-label': '연결된 클라이언트' },
      data.clients.map(clientCard),
      h(
        'p',
        { class: 'rc-note' },
        data.clients.length ? '취소하면 다음 요청부터 401로 끊겨요. ' : '아직 연결된 클라이언트가 없어요. ',
        extLink('토큰·비밀값 교체 절차 ↗', RUNBOOK),
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
    box.replaceChildren(el('p', 'set-note', '원격 커넥터 상태를 읽지 못했어요.'));
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
