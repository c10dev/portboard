// 설정 tab · 계정 (GET /api/accounts, src/features/accounts.ts): the plan, expiry and remaining limits of the Claude
// Code and Codex logins on this machine, and of the accounts added here. Off by default (portboard.json
// accounts.enabled) and the owner's only. Never a token: the server sends only the allowlisted fields.
//
// Adding an account (POST /api/accounts/login/*): Claude shows a sign-in link and takes the code the page shows;
// ChatGPT/Codex and GitHub Copilot show a device code and ask the server once per interval. Closing the settings
// modal stops the asking and cancels the flow. The pasted code goes to the server in the request body only: it is not
// kept, logged or put in a URL here.
//
// An added Claude or Codex account has two more buttons (POST /api/accounts/use and /remove): "use this account" makes
// the account's own CLI folder and shows the command that starts the CLI in it (with a copy button); "remove" asks first.
//
// Below the list, the account pool proxy (report.proxy): its state and port, "copy command" (asks POST
// /api/accounts/proxy/key and puts ANTHROPIC_BASE_URL=… ANTHROPIC_AUTH_TOKEN=<key> claude on the clipboard: the key is
// never drawn on the page), "change key" (asks first), the accounts that rest, and the last switches.

import { getInit, post, postOrThrow } from '../lib/api.js';
import { modal } from '../lib/dialog.js';
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
  [/^accounts file not written$/, () => t('accounts.login.error.notWritten')],
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
  [/^account not found$/, () => t('accounts.error.notFound')],
  [/^local login cannot be removed$/, () => t('accounts.error.local')],
  [/^account cannot be used by the CLI$/, () => t('accounts.error.noCli')],
  [/^account needs sign-in again$/, () => t('accounts.error.needsSignIn')],
  [/^account home not written$/, () => t('accounts.error.home')],
  [/^account home not removed$/, () => t('accounts.error.homeNotRemoved')],
  [/^local login cannot be used here$/, () => t('accounts.error.localUse')],
  [/^accounts proxy disabled$/, () => t('accounts.proxy.error.disabled')],
  [/^proxy key unusable$/, () => t('accounts.proxy.error.key')],
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

const CONFIRM = `
<dialog id="accountsConfirm" class="acc-confirm">
  <p id="accountsConfirmText"></p>
  <div class="set-row">
    <button type="button" id="accountsConfirmNo">${t('accounts.add.cancel')}</button>
    <button type="button" class="danger" id="accountsConfirmYes">${t('accounts.remove')}</button>
  </div>
</dialog>`;

/** The confirm dialog: true when the owner chose the yes button ("remove" unless `yes` says another label) */
function confirmRemove(text, yes = t('accounts.remove')) {
  const d = modal('accountsConfirm', CONFIRM);
  $('accountsConfirmText').textContent = text;
  $('accountsConfirmYes').textContent = yes;
  return new Promise((resolve) => {
    d.addEventListener('close', () => resolve(d.returnValue === 'yes'), { once: true });
    $('accountsConfirmYes').onclick = () => d.close('yes');
    $('accountsConfirmNo').onclick = () => d.close('no');
    d.returnValue = 'no';
    d.showModal();
  });
}

/** "Use this account" and "Remove" of an added Claude or Codex account (Copilot has no CLI: only "remove"); `say` shows an error next to them */
function actions(a, say) {
  const name = a.alias || a.email || (ADDED[a.provider] ?? a.provider);
  const use = a.provider === 'copilot' ? null : button(t('accounts.use'), async () => {
    say('');
    use.disabled = true;
    try {
      await postOrThrow('api/accounts/use', { id: a.id });
    } catch (err) {
      use.disabled = false;
      return say(errorText(reason(err)));
    }
    refresh();
  }, { write: true });
  const remove = button(t('accounts.remove'), async () => {
    say('');
    if (!(await confirmRemove(t('accounts.remove.confirm', { name })))) return;
    remove.disabled = true;
    let failure = '';
    try {
      await postOrThrow('api/accounts/remove', { id: a.id });
    } catch (err) {
      remove.disabled = false;
      failure = errorText(reason(err));
      say(failure);
    }
    // the list is drawn again: on a failure the account is still listed (nothing is removed), and the message shows on its new row
    await refresh();
    if (failure) {
      const li = [...document.querySelectorAll('#accountsList li')].find((x) => x.dataset.account === a.id);
      const note = li?.querySelector('[role="alert"]');
      if (note) note.textContent = failure;
    }
  }, { write: true, danger: true });
  return h('div', { class: 'set-row acc-line' }, use, remove);
}

/** The command that starts the CLI as this account, with a copy button */
function commandRow(command) {
  const copy = button(t('accounts.add.copy'), async () => {
    try {
      await navigator.clipboard.writeText(command);
      copy.textContent = t('accounts.add.copied');
    } catch {
      // clipboard blocked: the command is on screen to select
    }
  });
  return h('div', { class: 'set-row acc-line' }, h('span', null, t('accounts.command.lead')), h('code', { class: 'set-cmd' }, command), copy);
}

function row(a, proxy) {
  const resting = proxy?.resting?.find((x) => x.id === a.id);
  const tone = a.needsReauth && a.status === 'ok' ? 'warn' : TONE[a.status] ?? 'warn';
  const who = [a.plan, a.tier, a.email].filter(Boolean).join(' · ');
  const exp = when(a.expiresAt);
  const q = a.quota;
  const added = a.source === 'added';
  // an added account with a folder (a.command) is refreshed by the CLI: running it once clears the expiry, like a CLI login.
  // One without a folder is refreshed by Portboard when it can; this text is for when it could not.
  const err = added && a.error === 'access token expired' && !a.command ? t('accounts.error.expiredAdded') : a.error ? errorText(a.error) : null;
  const note = h('span', { class: 'set-state warn acc-line', role: 'alert' });
  const say = (text) => { note.textContent = text; };
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
      a.active ? h('span', { class: 'set-state ok' }, t('accounts.active')) : null,
      proxy?.current?.claude === a.id ? h('span', { class: 'set-state ok' }, t('accounts.proxy.using')) : null,
      resting ? h('span', { class: 'set-state warn' }, t('accounts.proxy.resting', { at: when(resting.until) ?? '' })) : null,
      exp ? h('span', null, t(Date.parse(a.expiresAt) < Date.now() ? 'accounts.expiredAt' : 'accounts.expires', { date: exp })) : null,
      a.needsReauth ? h('span', { class: 'set-state warn' }, t('accounts.reauth')) : null,
      added && a.provider === 'copilot' ? h('span', null, t('accounts.copilot.noLimits')) : null,
      q ? q.windows.map(windowRow) : null,
      q?.stale ? h('span', { class: 'set-state warn' }, t('accounts.stale', { at: when(q.fetchedAt) ?? '' })) : null,
      err ? h('span', { class: 'set-state warn' }, err) : null,
    ),
    a.command ? commandRow(a.command) : null,
    added ? actions(a, say) : null,
    note,
  );
}

const KIND = {
  switch: t('accounts.proxy.kind.switch'),
  rest: t('accounts.proxy.kind.rest'),
  'token expired': t('accounts.proxy.kind.tokenExpired'),
  'no usable account': t('accounts.proxy.kind.noAccount'),
};

/** The proxy block under the list: state, the two buttons, and the last switches. `say` shows an error next to the buttons. */
function proxyBlock(report) {
  const p = report.proxy;
  if (!p) return null;
  const title = h('strong', null, t('accounts.proxy.title'));
  if (!p.enabled) return h('div', { class: 'acc-proxy' }, title, h('p', { class: 'set-note' }, t('accounts.proxy.off')));
  // on in the settings, but this process never opened or closed it: no state to show, and no buttons
  if (p.state === 'unknown') return h('div', { class: 'acc-proxy' }, title, h('p', { class: 'set-note' }, t('accounts.proxy.state.unknown')));
  const names = new Map(report.accounts.map((a) => [a.id, a.alias || a.email || (ADDED[a.provider] ?? a.provider)]));
  const who = (id) => (id ? (names.get(id) ?? t('accounts.proxy.unknown')) : '–');
  const listening = p.state === 'listening';
  const stateText = listening
    ? t('accounts.proxy.state.listening', { port: p.port })
    : p.state === 'port in use'
      ? t('accounts.proxy.state.portInUse', { port: p.port })
      : t('accounts.proxy.state.error');
  const note = h('span', { class: 'set-state warn acc-line', role: 'alert' });
  const say = (text) => { note.textContent = text; };
  const copy = button(t('accounts.proxy.copy'), async () => {
    say('');
    let command;
    try {
      const { key } = await postOrThrow('api/accounts/proxy/key', {});
      command = `ANTHROPIC_BASE_URL=${p.url} ANTHROPIC_AUTH_TOKEN=${key} claude`;
    } catch (err) {
      return say(errorText(reason(err)));
    }
    try {
      await navigator.clipboard.writeText(command);
      copy.textContent = t('accounts.add.copied');
    } catch {
      // clipboard blocked: the key is not on the page, so there is nothing to select
      say(t('accounts.proxy.error.clipboard'));
    }
  }, { write: true, disabled: !listening });
  const rotate = button(t('accounts.proxy.rotate'), async () => {
    say('');
    if (!(await confirmRemove(t('accounts.proxy.rotate.confirm'), t('accounts.proxy.rotate.yes')))) return;
    try {
      await postOrThrow('api/accounts/proxy/key', { rotate: true });
      copy.textContent = t('accounts.proxy.copy');
      say(t('accounts.proxy.rotated'));
    } catch (err) {
      say(errorText(reason(err)));
    }
  }, { write: true, disabled: !listening });
  const lines = (p.events ?? []).map((e) => {
    const move = e.kind === 'switch' ? `${who(e.from)} → ${who(e.to)}` : who(e.from ?? e.to);
    return h('p', { class: 'set-note' }, [when(e.at), KIND[e.kind] ?? e.kind, move, e.status ?? null].filter((x) => x !== null).join(' · '));
  });
  return h(
    'div',
    { class: 'acc-proxy' },
    title,
    h('div', { class: 'set-row acc-line' }, h('span', { class: `set-state ${listening ? 'ok' : 'warn'}` }, stateText), h('span', null, t('accounts.proxy.counts', { requests: p.counts.requests, switches: p.counts.switches }))),
    listening ? h('p', { class: 'set-note' }, t('accounts.proxy.lead')) : null,
    h('div', { class: 'set-row acc-line' }, copy, rotate),
    note,
    h('p', { class: 'set-note' }, t('accounts.proxy.events')),
    lines.length ? lines : h('p', { class: 'set-note' }, t('accounts.proxy.noEvents')),
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
  body.replaceChildren(h('ul', { class: 'set-list' }, report.accounts.map((a) => row(a, report.proxy))), proxyBlock(report));
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

/** Stop the timers first, then forget the flow; cancel on the server when it may still be open there */
function endFlow(cancel) {
  gen += 1;
  if (!flow) return;
  const f = flow;
  clearTimeout(f.pollTimer);
  clearInterval(f.tick);
  flow = null;
  if (cancel) post('api/accounts/login/cancel', { flowId: f.id }).catch(() => {});
}

/** null, undefined and false are dropped: replaceChildren(null) would make a "null" text node */
const place = (...nodes) => $('accountsAdd')?.replaceChildren(...nodes.filter((n) => n !== null && n !== undefined && n !== false));
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
      // the request failed (the network, a 403, a big body) and the server may not have used the flow up: cancel it (cancel is idempotent)
      if (gen === mine) {
        endFlow(true);
        choices(failure(reason(err)));
      }
      return;
    }
    if (gen !== mine) return;
    endFlow(false);
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
  const code = h('code', { class: 'set-cmd acc-code', id: 'accountsUserCode' }, r.userCode);
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
      // the request failed: the flow may still be open on the server, so it is cancelled
      if (gen === mine) {
        endFlow(true);
        choices(failure(reason(err)));
      }
      return;
    }
    if (gen !== mine) return;
    if (out.state === 'pending') return schedule(out.interval ?? r.interval ?? 5);
    // the server drops the flow on any other answer: nothing to cancel
    endFlow(false);
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
