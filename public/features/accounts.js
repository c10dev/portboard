// 설정 tab · 계정 (GET /api/accounts, src/features/accounts.ts): the plan, expiry and remaining limits of the Claude
// Code and Codex logins on this machine. Off by default (portboard.json accounts.enabled) and the owner's only.
// Never a token: the server sends only the allowlisted fields.

import { getInit } from '../lib/api.js';
import { $, el, extLink, h } from '../lib/dom.js';
import { locale, t } from '../lib/i18n.js';

const DOCS = 'https://github.com/c10dev/portboard/blob/main/docs/accounts.md';
const TONE = { ok: 'ok', expired: 'warn', none: 'todo', unreadable: 'todo' };
const STATUS = {
  ok: t('accounts.status.ok'),
  expired: t('accounts.status.expired'),
  none: t('accounts.status.none'),
  unreadable: t('accounts.status.unreadable'),
};
const PROVIDER = { claude: t('accounts.provider.claude'), codex: t('accounts.provider.codex') };
const WINDOW = { '5h': t('accounts.window.fiveHour'), weekly: t('accounts.window.weekly'), monthly: t('accounts.window.monthly') };

/** The server's fixed error texts (src/core/accounts/) in the page's language; anything else is shown as it is */
const ERRORS = [
  [/^quota request refused \(HTTP (\d+)\)$/, (m) => t('accounts.error.refused', { code: m[1] })],
  [/^quota request failed \(HTTP (\d+)\)$/, (m) => t('accounts.error.failedHttp', { code: m[1] })],
  [/^quota request failed$/, () => t('accounts.error.failed')],
  [/^quota rate limited$/, () => t('accounts.error.rateLimited')],
  [/^quota request timed out$/, () => t('accounts.error.timedOut')],
  [/^quota response too large$/, () => t('accounts.error.tooLarge')],
  [/^quota response unusable$/, () => t('accounts.error.unusable')],
  [/^access token expired$/, () => t('accounts.error.expired')],
  [/^credentials file unreadable$/, () => t('accounts.error.unreadable')],
];

function errorText(s) {
  for (const [re, f] of ERRORS) {
    const m = re.exec(s);
    if (m) return f(m);
  }
  return s;
}

const when = (iso) => (iso && !Number.isNaN(Date.parse(iso)) ? new Date(iso).toLocaleString(locale()) : null);

function windowRow(w) {
  const name = WINDOW[w.name] ?? w.name;
  if (typeof w.usedPct !== 'number') return h('span', null, t('accounts.window.unknown', { name }));
  const used = Math.round(w.usedPct);
  const reset = when(w.resetsAt);
  return h('span', null, t('accounts.window.line', { name, used, left: 100 - used }), reset ? ` · ${t('accounts.window.resets', { at: reset })}` : null);
}

function row(a) {
  const tone = a.needsReauth && a.status === 'ok' ? 'warn' : TONE[a.status] ?? 'warn';
  const who = [a.plan, a.tier, a.email].filter(Boolean).join(' · ');
  const exp = when(a.expiresAt);
  const q = a.quota;
  return h(
    'li',
    { dataset: { account: a.id } },
    el('span', `dot ${tone}`),
    h('strong', null, PROVIDER[a.provider] ?? a.provider),
    h('span', { class: `set-state ${tone}` }, STATUS[a.status] ?? a.status),
    who ? h('p', { class: 'set-detail' }, who) : null,
    h(
      'div',
      { class: 'set-extra' },
      exp ? h('span', null, t(a.status === 'expired' ? 'accounts.expiredAt' : 'accounts.expires', { date: exp })) : null,
      a.needsReauth ? h('span', { class: 'set-state warn' }, t('accounts.reauth')) : null,
      q ? q.windows.map(windowRow) : null,
      q?.stale ? h('span', { class: 'set-state warn' }, t('accounts.stale', { at: when(q.fetchedAt) ?? '' })) : null,
      a.error ? h('span', { class: 'set-state warn' }, errorText(a.error)) : null,
    ),
  );
}

async function refresh() {
  const body = $('accountsBody');
  if (!body) return;
  let res;
  try {
    res = await fetch('api/accounts', getInit());
  } catch {
    return body.replaceChildren(el('p', 'set-note', t('accounts.loadFailed')));
  }
  if (res.status === 404) {
    return body.replaceChildren(h('p', { class: 'set-note' }, t('accounts.disabled'), ' ', extLink(t('accounts.docs'), DOCS)));
  }
  if (res.status === 403) return body.replaceChildren(el('p', 'set-note', t('accounts.ownerOnly')));
  if (!res.ok) return body.replaceChildren(el('p', 'set-note', t('accounts.loadFailed')));
  let report;
  try {
    report = await res.json();
  } catch {
    return body.replaceChildren(el('p', 'set-note', t('accounts.loadFailed')));
  }
  body.replaceChildren(h('ul', { class: 'set-list' }, report.accounts.map(row)));
}

/** Fill the section once its container is there: now, or when the 설정 modal has built it (settings:mount) */
function mount() {
  const body = $('accountsBody');
  if (!body || body.dataset.mounted) return;
  body.dataset.mounted = '1';
  refresh();
  document.addEventListener('settings:refresh', refresh);
}

mount();
document.addEventListener('settings:mount', mount);
