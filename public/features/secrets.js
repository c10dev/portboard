// 설정 tab · 비밀값 (GET /api/settings secrets, src/features/settings.ts): the Proxmox API token, the pve1 and Windows
// read-only SSH keys, the ntfy topic and the connector's tokens — status, expiry and each one's rotation runbook
// (docs/runbooks/). Never a value: only what the setup checklist and the self-watch already know.

import { $, el, extLink, h } from '../lib/dom.js';
import { locale, t } from '../lib/i18n.js';
import { settingsDoc } from './about.js';

const TONE = { ok: 'ok', warn: 'warn', missing: 'todo' };
const LABEL = { ok: t('secrets.status.ok'), warn: t('secrets.status.warn'), missing: t('secrets.status.missing') };

function expiry(iso) {
  if (!iso) return null;
  const days = Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000);
  const date = new Date(iso).toLocaleDateString(locale());
  return days < 0 ? t('secrets.expired', { date }) : t('secrets.expires', { date, n: days });
}

function row(s) {
  const exp = expiry(s.expiresAt);
  return h(
    'li',
    { dataset: { secret: s.key } },
    el('span', `dot ${TONE[s.status]}`),
    h('strong', null, s.title),
    h('span', { class: `set-state ${TONE[s.status]}` }, LABEL[s.status]),
    h('p', { class: 'set-detail' }, s.detail),
    h('div', { class: 'set-extra' }, exp ? h('span', { class: Date.parse(s.expiresAt) - Date.now() < 7 * 86_400_000 ? 'set-state warn' : null }, exp) : null, extLink(t('secrets.runbook'), s.runbook)),
  );
}

async function refresh() {
  const body = $('secretsBody');
  if (!body) return;
  const s = await settingsDoc();
  if (!s) return body.replaceChildren(el('p', 'set-note', t('secrets.loadFailed')));
  body.replaceChildren(h('ul', { class: 'set-list' }, s.secrets.map(row)));
}

/** Fill the section once its container is there: now, or when the 설정 modal has built it (settings:mount) */
function mount() {
  const body = $('secretsBody');
  if (!body || body.dataset.mounted) return;
  body.dataset.mounted = '1';
  refresh();
  document.addEventListener('settings:refresh', refresh);
}

mount();
document.addEventListener('settings:mount', mount);
