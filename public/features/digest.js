// 일간/주간 요약 알림 (c10dev/portboard#34): a 요약 알림 section with the setting (끄기 / 매일 / 매주 월요일, a time in
// KST), 미리보기 and 지금 보내기. In the 🔔 dialog (alerts.js) it adds its section the first time the dialog opens and
// doesn't touch the rest of it; on the 설정 tab it fills the 알림 section (#notifyBody), under the alert channel's
// status (GET /api/alerts, read-only: the channel itself lives in compute-pool's alerts.json).

import { errorText, post, tryJSON } from '../lib/api.js';
import { menuSelect, row } from '../lib/controls.js';
import { $, el, h } from '../lib/dom.js';
import { toast } from '../lib/toast.js';

const STYLE = `
.digest-box { margin-top: 14px; padding-top: 10px; border-top: 1px solid var(--line); }
.digest-box h4 { margin-top: 0; }
.digest-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 13px; }
.digest-row select, .digest-row input { font: inherit; padding: 3px 6px; }
.digest-state { font-size: 12px; margin: 6px 0 0; }
.digest-preview { white-space: pre-wrap; font: 13px/1.5 inherit; font-family: inherit; margin: 8px 0 0; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--card, transparent); }
.digest-preview strong { display: block; margin-bottom: 2px; }
.digest-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px; }
`;

let view = null;

/** "10/19(월) 09:00" in KST, whatever the browser's time zone (the setting is in KST) */
function kst(iso) {
  const d = new Date(Date.parse(iso) + 9 * 3600_000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${'일월화수목금토'[d.getUTCDay()]}) ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

const MODES = [
  { value: 'off', label: '끄기' },
  { value: 'daily', label: '매일' },
  { value: 'weekly', label: '매주 월요일' },
];

function section() {
  // a menu-select (lib/controls.js) has .value, .disabled and change like the <select> it replaced
  const mode = menuSelect({ id: 'digestMode', label: '요약 알림 주기', options: MODES, value: 'off', write: true, onChange: save });
  const time = h('input', { id: 'digestTime', class: 'ctl-time', type: 'time', step: '60', 'aria-label': '보낼 시각 (KST)', onchange: save, dataset: { write: '1' } });
  const actions = h('div', { class: 'digest-actions' },
    h('button', { type: 'button', id: 'digestPreviewBtn', text: '미리보기', onclick: preview }),
    h('button', { type: 'button', id: 'digestSendBtn', text: '지금 보내기', onclick: sendNow, dataset: { write: '1' } }));
  if ($('notifyBody')) {
    // the 설정 modal: rows (label and state on the left, the controls on the right)
    return h('section', { id: 'digestBox', class: 'st-rows' },
      row({ label: '요약 알림', desc: h('span', { id: 'digestState' }), control: h('span', { class: 'ctl-group' }, mode, time, h('span', { class: 'muted', text: 'KST' })) }),
      row({ label: '미리보기·보내기', desc: '지금까지의 요약을 미리 보거나 알림 채널로 바로 보내요 (예약에는 영향 없음)', control: actions }),
      h('div', { id: 'digestPreview', class: 'digest-preview', hidden: true }));
  }
  return h('section', { id: 'digestBox', class: 'digest-box' },
    h('h4', null, '요약 알림', h('a', { href: 'settings.html#notify', style: 'margin-left:8px;font-weight:400;font-size:12px' }, '설정 › 알림 →')),
    h('div', { class: 'digest-row' }, mode, time, h('span', { class: 'muted', text: 'KST' })),
    h('p', { id: 'digestState', class: 'digest-state muted' }),
    h('div', { id: 'digestPreview', class: 'digest-preview', hidden: true }),
    actions);
}

function stateText(v) {
  const s = v.settings;
  const parts = [];
  if (s.mode === 'off') parts.push('꺼져 있어요. 켜면 정한 시각부터 하루(또는 한 주) 요약을 보내요.');
  else parts.push(`${s.mode === 'weekly' ? '매주 월요일' : '매일'} ${s.time}에 보내요${v.nextAt ? ` · 다음 ${kst(v.nextAt)}` : ''}`);
  if (v.lastSent) parts.push(`마지막 ${kst(v.lastSent)}`);
  if (!v.channel.configured) parts.push('알림 채널 없음');
  else if (!v.scheduled && s.mode !== 'off') parts.push('이 서버(미리보기)는 예약 발송을 하지 않아요');
  return parts.join(' · ');
}

function paint() {
  if (!view || !$('digestBox')) return;
  $('digestMode').value = view.settings.mode;
  $('digestTime').value = view.settings.time;
  $('digestTime').disabled = view.settings.mode === 'off';
  $('digestState').textContent = stateText(view);
  $('digestSendBtn').disabled = !view.channel.configured;
  $('digestSendBtn').title = view.channel.configured ? '지금까지의 요약을 알림 채널로 보내요 (예약에는 영향 없음)' : '알림 채널 없음';
}

async function load() {
  const next = await tryJSON('/api/digest');
  if (!next) return;
  view = next;
  paint();
}

async function save() {
  const body = { mode: $('digestMode').value };
  if ($('digestTime').value) body.time = $('digestTime').value.slice(0, 5);
  try {
    const r = await post('/api/digest', body);
    if (!r.ok) throw new Error(errorText(r));
    view = r.body;
    paint();
    toast(view.settings.mode === 'off' ? '요약 알림을 껐어요' : `요약 알림: ${view.settings.mode === 'weekly' ? '매주 월요일' : '매일'} ${view.settings.time}`);
  } catch (err) {
    toast(`저장 실패: ${err.message}`, true);
    load();
  }
}

function show(d) {
  const box = $('digestPreview');
  box.replaceChildren(h('strong', { text: d.title }), d.body);
  box.hidden = false;
}

async function preview() {
  const d = await tryJSON('/api/digest/preview');
  if (!d) return toast('미리보기를 만들지 못했어요', true);
  show(d);
}

async function sendNow() {
  const btn = $('digestSendBtn');
  btn.disabled = true;
  try {
    const r = await post('/api/digest/send');
    if (r.body.digest) show(r.body.digest);
    toast(r.ok ? '요약을 보냈어요' : r.body.message ?? errorText(r), !r.ok);
  } catch (err) {
    toast(`보내기 실패: ${err.message}`, true);
  } finally {
    btn.disabled = false;
    load();
  }
}

function mount() {
  const dialog = $('alertsDialog');
  if (!dialog) return;
  // with the 설정 modal's 알림 built, the setting lives there (one #digestBox per page): the dialog links to it
  if ($('notifyBody')) {
    if ($('digestLink')) return;
    const link = h('p', { id: 'digestLink', class: 'digest-box' }, h('a', { href: 'settings.html#notify' }, '요약 알림은 설정 › 알림에서 →'));
    const help = dialog.querySelector('.alerts-help');
    if (help) help.before(link);
    else dialog.querySelector('footer')?.before(link);
    return;
  }
  if ($('digestBox')) return;
  if (!$('digestStyle')) document.head.append(h('style', { id: 'digestStyle', text: STYLE }));
  const help = dialog.querySelector('.alerts-help');
  if (help) help.before(section());
  else dialog.querySelector('footer')?.before(section());
  paint();
}

// alerts.js wires the button (and creates the dialog) first, so by the time this listener runs the dialog exists.
$('alertsBtn')?.addEventListener('click', () => {
  mount();
  load();
});

// ---------- the 설정 tab's 알림 section ----------

const KIND = { ntfy: 'ntfy', webhook: 'webhook' };

async function channelLine() {
  const [a, health] = await Promise.all([tryJSON('/api/alerts'), tryJSON('/api/health')]);
  const preview = health?.profile === 'preview';
  const box = $('notifyChannel');
  if (!box) return;
  if (!a) return box.replaceChildren(el('p', 'set-note', '알림 상태를 읽지 못했어요.'));
  const on = a.channel.configured;
  const watching = a.watching?.length ?? 0;
  box.replaceChildren(
    h('ul', { class: 'set-list' },
      h('li', null,
        el('span', `dot ${on ? 'ok' : 'todo'}`),
        h('strong', null, '알림 채널'),
        h('span', { class: `set-state ${on ? 'ok' : 'todo'}` }, on ? a.channel.kinds.map((k) => KIND[k] ?? k).join(' · ') : preview ? '미리보기: 꺼짐' : '없음'),
        h('p', { class: 'set-detail' },
          on ? `감시 중 ${watching}개 · ${a.checkEverySec}초마다 확인. 채널은 compute-pool의 alerts.json에서 읽고, 여기서는 바꾸지 않아요.`
            : preview
              ? '미리보기는 알림을 보내지 않아요 (PORTBOARD_PREVIEW_ALERTS=1일 때만). 운영 대시보드의 채널 상태는 비밀값의 ntfy 항목에 있어요.'
              : '알림 채널이 없어서 다운 알림과 요약 알림을 못 보내요. 시작하기의 알림 채널 항목을 보세요.'),
        h('div', { class: 'set-extra' }, h('a', { href: './' }, '감시할 포트는 서비스 탭의 🔔에서 →')))),
  );
}

/** Fill the 알림 section once its container is there (now, or on the modal's settings:mount) */
export function mountSettings() {
  const body = $('notifyBody');
  if (!body || body.dataset.mounted) return;
  body.dataset.mounted = '1';
  if (!$('digestStyle')) document.head.append(h('style', { id: 'digestStyle', text: STYLE }));
  // the 🔔 dialog had it first: it moves here, and the dialog links here instead
  const old = $('digestBox');
  if (old) {
    old.remove();
    mount();
  }
  body.replaceChildren(h('div', { id: 'notifyChannel' }), section());
  channelLine();
  load();
  document.addEventListener('settings:refresh', () => {
    channelLine();
    load();
  });
}

mountSettings();
document.addEventListener('settings:mount', mountSettings);
