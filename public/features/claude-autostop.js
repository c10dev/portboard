// 설정 tab · Claude 세션 (#43, src/features/claude-session.ts): what happens to a Claude Code session's dev servers when
// the session ends (the plugin's SessionEnd hook). GET /api/claude/sessions has the setting and the last auto-stop;
// POST /api/claude/settings {autoStop} changes it. The 서비스 tab's cleanup banner menu sets the same thing.

import { errorText, post, tryJSON } from '../lib/api.js';
import { menuSelect, row } from '../lib/controls.js';
import { $, el, h } from '../lib/dom.js';
import { when } from '../lib/time.js';
import { toast } from '../lib/toast.js';

const MODES = [
  ['off', '끄기 (기본)', '세션이 끝나도 아무것도 멈추지 않아요. 남은 서버는 서비스 탭의 정리 배너에 떠요.'],
  ['scratchpad', 'scratchpad·임시 유닛만', '그 세션의 scratchpad에서 돌던 서버와 Portboard가 띄운 임시 유닛(pb-dev-, pb-sd-)만 멈춰요. 워크트리의 서버는 그대로 둬요.'],
  ['all', '그 세션의 서버 모두', '그 세션이 띄운 서버를 모두 멈춰요 (고정한 포트와 정리 대상이 아닌 서비스는 빼고).'],
];

let view = null;

function paint() {
  const body = $('claudeBody');
  if (!body || !view) return;
  const cur = view.settings?.autoStop ?? 'off';
  const last = view.lastAutoStop;
  const pick = menuSelect({
    id: 'autoStop', label: '세션이 끝나면', value: cur, write: true,
    options: MODES.map(([value, label, desc]) => ({ value, label, desc })),
    onChange: (v) => save(v),
  });
  body.replaceChildren(
    h('div', { class: 'st-rows' },
      row({ label: '세션이 끝나면', desc: MODES.find((m) => m[0] === cur)?.[2], control: pick }),
      row({
        label: '마지막 자동 중지',
        desc: last
          ? `${when(last.at)}: ${last.results.length ? last.results.map((r) => `:${r.port} ${r.ok ? '멈춤' : '실패'}`).join(', ') : '멈출 서버 없음'}`
          : 'Claude Code의 portboard 플러그인이 세션 종료를 알려 줄 때만 동작해요.',
      })),
  );
}

async function save(mode) {
  const r = await post('/api/claude/settings', { autoStop: mode });
  if (!r.ok) {
    toast(`저장하지 못했어요: ${errorText(r)}`, true);
  } else {
    view = { ...view, settings: r.body.settings ? { autoStop: r.body.settings.autoStop ?? mode } : { autoStop: mode } };
    toast(`세션이 끝나면: ${MODES.find((m) => m[0] === mode)[1]}`);
  }
  refresh();
}

async function refresh() {
  const body = $('claudeBody');
  if (!body) return;
  const next = await tryJSON('/api/claude/sessions');
  if (!next) return body.replaceChildren(el('p', 'set-note', 'Claude 세션 설정을 읽지 못했어요.'));
  view = next;
  paint();
}

/** Fill the section once its container is there: now, or when the 설정 modal has built it (settings:mount) */
function mount() {
  const body = $('claudeBody');
  if (!body || body.dataset.mounted) return;
  body.dataset.mounted = '1';
  refresh();
  document.addEventListener('settings:refresh', refresh);
}

mount();
document.addEventListener('settings:mount', mount);
