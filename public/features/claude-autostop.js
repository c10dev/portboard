// 설정 tab · Claude 세션 (#43, src/features/claude-session.ts): what happens to a Claude Code session's dev servers when
// the session ends (the plugin's SessionEnd hook). GET /api/claude/sessions has the setting and the last auto-stop;
// POST /api/claude/settings {autoStop} changes it. The 서비스 tab's cleanup banner menu sets the same thing.

import { errorText, post, tryJSON } from '../lib/api.js';
import { menuSelect, row } from '../lib/controls.js';
import { $, el, h } from '../lib/dom.js';
import { t } from '../lib/i18n.js';
import { when } from '../lib/time.js';
import { toast } from '../lib/toast.js';

const MODES = [
  ['off', t('claude.mode.off'), t('claude.mode.off.desc')],
  ['scratchpad', t('claude.mode.scratchpad'), t('claude.mode.scratchpad.desc')],
  ['all', t('claude.mode.all'), t('claude.mode.all.desc')],
];

let view = null;

function paint() {
  const body = $('claudeBody');
  if (!body || !view) return;
  const cur = view.settings?.autoStop ?? 'off';
  const last = view.lastAutoStop;
  const pick = menuSelect({
    id: 'autoStop', label: t('claude.whenEnds'), value: cur, write: true,
    options: MODES.map(([value, label, desc]) => ({ value, label, desc })),
    onChange: (v) => save(v),
  });
  body.replaceChildren(
    h('div', { class: 'st-rows' },
      row({ label: t('claude.whenEnds'), desc: MODES.find((m) => m[0] === cur)?.[2], control: pick }),
      row({
        label: t('claude.lastAutoStop'),
        desc: last
          ? `${when(last.at)}: ${last.results.length ? last.results.map((r) => `:${r.port} ${r.ok ? t('claude.result.stopped') : t('claude.result.failed')}`).join(', ') : t('claude.result.none')}`
          : t('claude.lastAutoStop.desc'),
      })),
  );
}

async function save(mode) {
  const r = await post('/api/claude/settings', { autoStop: mode });
  if (!r.ok) {
    toast(t('claude.saveFailed', { error: errorText(r) }), true);
  } else {
    view = { ...view, settings: r.body.settings ? { autoStop: r.body.settings.autoStop ?? mode } : { autoStop: mode } };
    toast(t('claude.saved', { mode: MODES.find((m) => m[0] === mode)[1] }));
  }
  refresh();
}

async function refresh() {
  const body = $('claudeBody');
  if (!body) return;
  const next = await tryJSON('/api/claude/sessions');
  if (!next) return body.replaceChildren(el('p', 'set-note', t('claude.loadFailed')));
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
