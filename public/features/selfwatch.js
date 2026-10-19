// Self-watch (GET /api/health?detail): a small header chip "수집 정상" / "2개 실패" and a dialog with each collector's
// state and the credentials that can expire. Self-contained: a page only loads this script; the chip goes in the shell's
// sidebar footer (lib/shell.js #shellFoot), or a header .controls on a page without the shell.

import { tryJSON } from '../lib/api.js';
import { modal } from '../lib/dialog.js';
import { $, el, extLink } from '../lib/dom.js';
import { ago as agoText, lasting as lastingText } from '../lib/time.js';

let status = null;

const DIALOG = `
<dialog id="swDialog" class="alerts-dlg sw-dlg">
  <header>
    <strong>데이터 수집 상태</strong>
    <button type="button" id="swClose">닫기</button>
  </header>
  <h4>수집기</h4>
  <ul id="swList" class="alerts-list"></ul>
  <p id="swMemory" class="alerts-help" hidden></p>
  <h4>토큰·키 만료</h4>
  <ul id="swExpiry" class="alerts-list"></ul>
  <p id="swHelp" class="alerts-help"></p>
</dialog>`;

const ago = (iso) => agoText(iso, { suffix: ' 전', floor: true });
const lasting = (iso) => lastingText(iso, '방금부터');

function collectorText(c) {
  const err = c.lastError ? ` · ${c.lastError}` : '';
  switch (c.view) {
    case 'ok': return [`정상${c.lastOk ? ` · ${ago(c.lastOk)} 성공` : ''}`, 'ok'];
    case 'down': return [`실패 ${c.failingSince ? lasting(c.failingSince) : ''}${c.alerted ? ' · 알림 보냄' : ''}${err}`, 'bad'];
    case 'failing': return [`실패 ${c.failingSince ? lasting(c.failingSince) : ''}${err}`, 'warn'];
    case 'setup': return [`설정 전${err}`, 'muted'];
    case 'off': return [`꺼짐${err}`, 'muted'];
    default: return ['첫 확인 전', 'muted'];
  }
}

function expiryText(i) {
  const left = i.expiresAt ? Math.round((Date.parse(i.expiresAt) - Date.now()) / 86400000) : null;
  const note = i.note ? ` · ${i.note}` : '';
  switch (i.status) {
    case 'never': return [`만료 없음${note}`, 'ok'];
    case 'ok': return [`${left}일 남음 (${new Date(i.expiresAt).toLocaleDateString()})${note}`, 'ok'];
    case 'soon': return [`곧 만료 · ${Math.max(0, left)}일 남음${note}`, 'warn'];
    case 'expired': return [`만료됨${note}`, 'bad'];
    default: return [`알 수 없음${note}`, 'muted'];
  }
}

function paintChip() {
  const b = $('swChip');
  if (!b || !status) return;
  const bad = status.failing > 0;
  const soon = status.expiry.items.filter((i) => i.status === 'soon' || i.status === 'expired').length;
  // memory pressure (features/memory.ts): a warn tone, below a failing collector
  const mem = status.memory?.pressure ? status.memory : null;
  b.hidden = false;
  b.classList.toggle('alarm', bad);
  b.classList.toggle('warn', !bad && (soon > 0 || !!mem));
  $('swText').textContent = bad ? status.summary : mem ? '메모리 부족' : soon ? `토큰 ${soon}개 만료 임박` : status.summary;
  b.title = bad
    ? `데이터 수집 · ${status.collectors.filter((c) => c.view === 'failing' || c.view === 'down').map((c) => c.label).join(', ')} 실패`
    : mem ? `메모리 · ${mem.reasons.join(', ')} (사용 가능 ${mem.availablePct}%, 스왑 ${mem.swapPct}%) · 기기 탭에서 보기`
    : '데이터 수집 · 모든 수집기 정상';
}

function paintDialog() {
  if (!status) return;
  $('swList').replaceChildren(...status.collectors.map((c) => {
    const li = el('li', 'alerts-item');
    const [text, tone] = collectorText(c);
    li.append(el('span', `dot ${tone}`), el('strong', null, c.label), el('span', `alerts-state ${tone}`, text));
    return li;
  }));
  const mem = status.memory;
  const memLine = $('swMemory');
  memLine.hidden = !mem?.pressure;
  if (mem?.pressure) memLine.replaceChildren(`메모리 부족: ${mem.reasons.join(', ')} · 사용 가능 ${mem.availablePct}% · 스왑 ${mem.swapPct}%. `, Object.assign(el('a', 'sw-runbook', '기기 탭 메모리 →'), { href: 'devices.html#memory' }));
  if (!status.collectors.length) $('swList').replaceChildren(el('li', 'muted', '아직 보고한 수집기가 없어요 (시작 직후).'));
  const items = status.expiry.items;
  $('swExpiry').replaceChildren(...(items.length ? items : [null]).map((i) => {
    if (!i) return el('li', 'muted', status.expiry.checkedAt ? '만료를 확인할 토큰이 없어요.' : '아직 확인 전이에요.');
    const li = el('li', 'alerts-item');
    const [text, tone] = expiryText(i);
    li.append(el('span', `dot ${tone}`), el('strong', null, i.name), el('span', `alerts-state ${tone}`, text));
    if (i.runbook) li.append(extLink('교체 절차 ↗', i.runbook, 'sw-runbook'));
    return li;
  }));
  $('swHelp').textContent =
    `${status.checkEverySec / 60}분마다 확인해요. 수집기가 ${status.thresholdMin}분 넘게 계속 실패하면 다운 알림 채널로 한 번 알리고 (같은 수집기는 1시간에 한 번까지), ` +
    '다시 되면 알려요. 토큰은 만료 7일 전에 한 번 알려요. 설정 전·꺼진 수집기는 알리지 않아요.';
}

async function refresh() {
  // the page works without it
  const next = await tryJSON('/api/health?detail');
  if (!next) return;
  status = next;
  paintChip();
  if ($('swDialog')?.open) paintDialog();
}

function init() {
  // the shell's sidebar footer carries the chip already (src/core/shell.ts); a page without the shell gets one
  let b = $('swChip');
  if (!b) {
    const controls = $('shellFoot') ?? document.querySelector('header.top .controls');
    if (!controls) return;
    b = el('button', 'sw-chip');
    b.id = 'swChip';
    b.type = 'button';
    b.hidden = true;
    b.setAttribute('aria-label', '데이터 수집 상태');
    b.append(el('span', 'sw-dot'), el('span', 'sw-text'));
    b.lastElementChild.id = 'swText';
    if (controls.id === 'shellFoot') controls.insertBefore(b, $('obChip')?.nextSibling ?? controls.firstChild);
    else controls.insertBefore(b, $('alertsBtn') ?? controls.lastElementChild);
  }
  const dialog = modal('swDialog', DIALOG, 'swClose');
  b.addEventListener('click', () => {
    paintDialog();
    dialog.showModal();
    refresh();
  });
  refresh();
  setInterval(() => { if (!document.hidden) refresh(); }, 60_000);
}

init();
