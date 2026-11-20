// 설정 tab · 계정 (GET /api/accounts, src/features/accounts.ts): the plan, expiry and remaining limits of the Claude
// Code and Codex logins on this machine, and of the accounts added here. Off by default (portboard.json
// accounts.enabled) and the owner's only. Never a token: the server sends only the allowlisted fields.
//
// Adding an account (POST /api/accounts/login/*): Claude shows a sign-in link and takes the code the page shows;
// ChatGPT/Codex and GitHub Copilot show a device code and ask the server once per interval. Closing the settings
// modal stops the asking and cancels the flow. The pasted code goes to the server in the request body only: it is not
// kept, logged or put in a URL here.

import { getInit, post, postOrThrow } from '../lib/api.js';
import { $, button, el, extLink, h } from '../lib/dom.js';
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
/** What an added account is called: the service, not the CLI */
const ADDED = { claude: t('accounts.add.claude'), codex: t('accounts.add.codex'), copilot: t('accounts.add.copilot') };
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
  [/not read on this platform$/, () => t('accounts.error.platform')],
  [/^accounts file unreadable$/, () => t('accounts.login.error.file')],
  [/^login state mismatch$/, () => t('accounts.login.error.state')],
  [/^login flow expired$/, () => t('accounts.login.error.flowExpired')],
  [/^login flow not found$/, () => t('accounts.login.error.notFound')],
  [/^login denied$/, () => t('accounts.login.error.denied')],
  [/^login request failed \((?:HTTP )?(\d+)\)$/, (m) => t('accounts.login.error.failedHttp', { code: m[1] })],
  [/^login request failed$/, () => t('accounts.login.error.failed')],
  [/^login request timed out$/, () => t('accounts.login.error.timedOut')],
  [/^login response unusable$/, () => t('accounts.login.error.unusable')],
  [/^too many login flows$/, () => t('accounts.login.error.tooMany')],
  [/^invalid login request$/, () => t('accounts.login.error.invalid')],
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
  const added = a.source === 'added';
  // an added account is not refreshed yet: the CLI hint would send the owner to the wrong place
  const err = added && a.error === 'access token expired' ? t('accounts.error.expiredAdded') : a.error ? errorText(a.error) : null;
  return h(
    'li',
    { dataset: { account: a.id } },
    el('span', `dot ${tone}`),
    h('strong', null, (added ? ADDED[a.provider] : PROVIDER[a.provider]) ?? a.provider, a.alias ? ` · ${a.alias}` : null),
    h('span', { class: `set-state ${tone}` }, STATUS[a.status] ?? a.status),
    who ? h('p', { class: 'set-detail' }, who) : null,
    h(
      'div',
      { class: 'set-extra' },
      added ? h('span', { class: 'set-state' }, t('accounts.added')) : null,
      exp ? h('span', null, t(Date.parse(a.expiresAt) < Date.now() ? 'accounts.expiredAt' : 'accounts.expires', { date: exp })) : null,
      a.needsReauth ? h('span', { class: 'set-state warn' }, t('accounts.reauth')) : null,
      added && a.provider === 'copilot' ? h('span', null, t('accounts.copilot.noLimits')) : null,
      q ? q.windows.map(windowRow) : null,
      q?.stale ? h('span', { class: 'set-state warn' }, t('accounts.stale', { at: when(q.fetchedAt) ?? '' })) : null,
      err ? h('span', { class: 'set-state warn' }, err) : null,
    ),
  );
}

async function refresh() {
  const body = $('accountsList');
  const add = $('accountsAdd');
  if (!body) return;
  if (add) add.hidden = true;
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
  if (add) add.hidden = false;
}

// ---- adding an account ----

const mmss = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** The flow on screen, or null: {id, pollTimer, tick}. `gen` changes whenever it ends, so a late answer is ignored. */
let flow = null;
let gen = 0;

function endFlow(cancel) {
  gen += 1;
  if (!flow) return;
  const f = flow;
  flow = null;
  clearTimeout(f.pollTimer);
  clearInterval(f.tick);
  if (cancel) post('api/accounts/login/cancel', { flowId: f.id }).catch(() => {});
}

const place = (...nodes) => $('accountsAdd')?.replaceChildren(...nodes);
const failure = (msg) => h('p', { class: 'set-note', role: 'alert' }, errorText(msg));
const reason = (err) => String(err?.message ?? '');

/** The three buttons, with an optional note above them (a result or an error) */
function choices(note) {
  endFlow(true);
  place(
    note ?? null,
    h('div', { class: 'set-row' },
      h('strong', null, t('accounts.add.title')),
      Object.entries(ADDED).map(([id, label]) => button(label, () => nameStep(id), { write: true }))),
  );
}

/** The name field, then start */
function nameStep(provider) {
  const input = h('input', { type: 'text', class: 'ctl-text', id: 'accountsAlias', maxlength: 40, autocomplete: 'off', spellcheck: 'false' });
  const go = button(t('accounts.add.start'), () => begin(provider, input.value), { write: true });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go.click(); });
  place(
    h('strong', null, ADDED[provider]),
    h('div', { class: 'set-row' }, h('label', { for: 'accountsAlias' }, t('accounts.add.alias')), input),
    h('div', { class: 'set-row' }, go, button(t('accounts.add.cancel'), () => choices())),
  );
  input.focus();
}

async function begin(provider, name) {
  place(h('p', { class: 'set-note' }, t('accounts.add.working')));
  gen += 1;
  const mine = gen;
  let r;
  try {
    r = await postOrThrow('api/accounts/login/start', { provider, alias: name.trim() || undefined });
  } catch (err) {
    if (gen === mine) choices(failure(reason(err)));
    return;
  }
  if (gen !== mine) {
    // the modal closed while the server answered: the flow it just opened is cancelled
    post('api/accounts/login/cancel', { flowId: r.flowId }).catch(() => {});
    return;
  }
  flow = { id: r.flowId, pollTimer: 0, tick: 0 };
  if (r.kind === 'paste') paste(r);
  else device(r);
}

function paste(r) {
  const input = h('input', { type: 'text', class: 'ctl-text', id: 'accountsCode', autocomplete: 'off', spellcheck: 'false' });
  const fin = button(t('accounts.add.finish'), async () => {
    const mine = gen;
    const code = input.value.trim();
    if (!code || !flow) return;
    fin.disabled = true;
    try {
      await postOrThrow('api/accounts/login/finish', { flowId: flow.id, code });
    } catch (err) {
      // the flow is used up whatever the outcome: the owner starts again
      if (gen === mine) {
        flow = null;
        choices(failure(reason(err)));
      }
      return;
    }
    if (gen !== mine) return;
    flow = null;
    choices(h('p', { class: 'set-note' }, t('accounts.add.done')));
    refresh();
  }, { write: true });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') fin.click(); });
  const link = /^https:\/\/claude\.ai\//.test(r.authorizeUrl ?? '') ? extLink(t('accounts.add.open'), r.authorizeUrl) : null;
  place(
    h('strong', null, ADDED.claude),
    h('p', { class: 'set-note' }, t('accounts.add.pasteLead')),
    h('div', { class: 'set-row' }, link),
    h('div', { class: 'set-row' }, h('label', { for: 'accountsCode' }, t('accounts.add.paste')), input),
    h('div', { class: 'set-row' }, fin, button(t('accounts.add.cancel'), () => choices())),
  );
  input.focus();
}

function device(r) {
  const f = flow;
  const deadline = Date.parse(r.expiresAt);
  const code = h('code', { class: 'set-cmd', id: 'accountsUserCode' }, r.userCode);
  // large and spaced, to read across a desk and type: the design system's mono face, set through the style object
  code.style.fontSize = '28px';
  code.style.letterSpacing = '0.12em';
  code.style.padding = '8px 14px';
  const left = h('span', { class: 'set-state' }, '');
  const copy = button(t('accounts.add.copy'), async () => {
    try {
      await navigator.clipboard.writeText(r.userCode);
      copy.textContent = t('accounts.add.copied');
    } catch {
      // clipboard blocked: the code is on screen to select
    }
  });
  const link = /^https:\/\/(auth\.openai\.com|github\.com)\//.test(r.verificationUrl ?? '') ? extLink(t('accounts.add.verify'), r.verificationUrl) : null;
  place(
    h('strong', null, ADDED[r.provider]),
    h('p', { class: 'set-note' }, t('accounts.add.deviceLead')),
    h('div', { class: 'set-row' }, code, copy),
    h('div', { class: 'set-row' }, link),
    h('div', { class: 'set-row' }, left, button(t('accounts.add.cancel'), () => choices())),
  );
  const paintLeft = () => { left.textContent = t('accounts.add.remaining', { time: mmss(deadline - Date.now()) }); };
  paintLeft();
  f.tick = setInterval(paintLeft, 1000);
  const schedule = (seconds) => { f.pollTimer = setTimeout(poll, Math.max(1, seconds) * 1000); };
  const poll = async () => {
    const mine = gen;
    let out;
    try {
      out = await postOrThrow('api/accounts/login/poll', { flowId: f.id });
    } catch (err) {
      if (gen === mine) {
        flow = null;
        choices(failure(reason(err)));
      }
      return;
    }
    if (gen !== mine) return;
    if (out.state === 'pending') return schedule(out.interval ?? r.interval ?? 5);
    // the server drops the flow on any other answer: nothing to cancel
    flow = null;
    if (out.state === 'done') {
      choices(h('p', { class: 'set-note' }, t('accounts.add.done')));
      refresh();
    } else choices(failure(out.error ?? 'login request failed'));
  };
  schedule(r.interval ?? 5);
}

/** Fill the section once its container is there: now, or when the 설정 modal has built it (settings:mount) */
function mount() {
  const body = $('accountsBody');
  if (!body || body.dataset.mounted) return;
  body.dataset.mounted = '1';
  // a refresh redraws the list and leaves a flow on screen alone
  body.replaceChildren(h('div', { id: 'accountsList' }), h('div', { id: 'accountsAdd', hidden: true }));
  choices();
  refresh();
  document.addEventListener('settings:refresh', refresh);
  // the settings modal closing: stop asking, cancel the flow, show the three buttons again
  $('settingsModal')?.addEventListener('close', () => choices());
}

mount();
document.addEventListener('settings:mount', mount);
