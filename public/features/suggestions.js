// Smart defaults (GET /api/suggestions, src/features/suggestions.ts): never applied by themselves.
//   서비스 page  "🔔 알림 켜기?" (in the inspector, and on a phone's row) for a pinned / systemd / long-lived docker port with no alert: 켜기 / 무시
//   기기 page    "추천 이름 …" on a LAN device's card: 적용 / 무시, and prefill() for 이름 붙이기 (devices.js imports it)
// Self-contained like owners.js: it decorates what the page renders and re-applies after every re-render.

import { post, postOrThrow, tryJSON } from '../lib/api.js';
import { $, el } from '../lib/dom.js';
import { t, tn } from '../lib/i18n.js';
import { toast } from '../lib/toast.js';

let doc = null;
const busy = new Set();
const say = (text, error = false) => toast(text, error, { ms: 3500 });

const nameFor = (key) => doc?.suggestions.find((s) => s.kind === 'name' && s.key === key) ?? null;

/** The name 이름 붙이기 pre-fills (src/core/suggest.ts prefillName): a user name stays, else the suggestion, else a Proxmox guest name */
export function prefill(c) {
  if (c.nameSource === 'user') return c.name;
  const s = c.nameKey ? nameFor(c.nameKey) : null;
  if (s) return s.name;
  return c.nameSource === 'proxmox' ? c.name : '';
}

/** "추천: dev-mac (Tailscale 기기가 이 주소에서…)" for the 이름 붙이기 prompt, or '' */
export function prefillHint(c) {
  const s = c.nameKey && c.nameSource !== 'user' ? nameFor(c.nameKey) : null;
  return s ? `\n${t('suggestions.hint', { name: s.name, text: s.text })}` : '';
}

function refreshPage() {
  $('refresh')?.click();
}

async function dismiss(s) {
  busy.add(s.id);
  decorate();
  try {
    await postOrThrow(`/api/suggestions/${encodeURIComponent(s.id)}/dismiss`);
    doc.suggestions = doc.suggestions.filter((x) => x.id !== s.id);
  } catch (err) {
    say(t('suggestions.dismissFailed', { error: err.message }), true);
  } finally {
    busy.delete(s.id);
    decorate();
  }
}

async function accept(s) {
  busy.add(s.id);
  decorate();
  try {
    if (s.kind === 'alert') {
      const r = await post(`/api/ports/${s.port}/prefs`, { alert: true });
      if (!r.ok) throw new Error(r.body.error ?? `HTTP ${r.status}`);
      say(t('suggestions.alertOn', { port: s.port }));
    } else {
      const body = await postOrThrow('/api/clients/name', { key: s.key, name: s.name });
      say(t('suggestions.named', { name: body.name }));
    }
    doc.suggestions = doc.suggestions.filter((x) => x.id !== s.id);
  } catch (err) {
    say(t('suggestions.saveFailed', { error: err.message }), true);
  } finally {
    busy.delete(s.id);
    decorate();
    refreshPage();
  }
}

function acts(s, yes) {
  const ok = el('button', 'sg-yes', yes);
  const no = el('button', 'sg-no', t('suggestions.dismiss'));
  ok.dataset.write = '1';
  no.dataset.write = '1';
  for (const b of [ok, no]) {
    b.type = 'button';
    b.disabled = busy.has(s.id);
  }
  ok.addEventListener('click', (ev) => { ev.stopPropagation(); accept(s); });
  no.addEventListener('click', (ev) => { ev.stopPropagation(); dismiss(s); });
  no.title = t('suggestions.dismiss.title');
  return [ok, no];
}

function alertChip(s) {
  const chip = el('span', 'badge sg-chip');
  chip.dataset.suggestion = s.id;
  chip.title = `${s.text}${s.also.length ? `\n${t('suggestions.alert.also', { ports: s.also.join(', '), n: s.also.length })}` : ''}\n${t('suggestions.alert.how')}`;
  chip.append(el('span', 'sg-text', t('suggestions.alert')), ...acts(s, t('suggestions.alert.yes')));
  return chip;
}

function nameLine(s) {
  const box = el('div', 'sg-name');
  box.dataset.suggestion = s.id;
  box.title = s.text;
  const label = el('span', 'sg-text');
  label.append(...tn('suggestions.name', { name: el('strong', null, s.name) }));
  box.append(label, ...acts(s, t('suggestions.name.apply')));
  return box;
}

function decorateRows() {
  const byPort = new Map(doc.suggestions.filter((s) => s.kind === 'alert').map((s) => [String(s.port), s]));
  // the rows, and the 서비스 inspector's head (features/port-inspector.js), which looks like a row to this
  for (const li of document.querySelectorAll('#list li.row, #inspBody .insp-port')) {
    const badges = li.querySelector('.badges');
    if (!badges) continue;
    badges.querySelectorAll('.sg-chip').forEach((b) => b.remove());
    const s = byPort.get(li.querySelector('.port')?.textContent?.trim() ?? '');
    if (s) badges.append(alertChip(s));
  }
}

function decorateCards() {
  const byDevice = new Map(doc.suggestions.filter((s) => s.kind === 'name' && s.device).map((s) => [s.device, s]));
  for (const card of document.querySelectorAll('#active article.card[data-id]')) {
    const who = card.querySelector('.who');
    if (!who) continue;
    who.querySelectorAll('.sg-name').forEach((b) => b.remove());
    const s = byDevice.get(card.dataset.id);
    if (s) who.append(nameLine(s));
  }
}

function decorate() {
  if (!doc) return;
  if ($('list')) decorateRows();
  if ($('active')) decorateCards();
}

async function load() {
  // the pages work without it
  doc = (await tryJSON('/api/suggestions')) ?? doc;
  decorate();
}

for (const id of ['list', 'inspBody', 'active']) {
  const box = $(id);
  if (box) new MutationObserver(() => decorate()).observe(box, { childList: true });
}
if ($('list') || $('active')) {
  load();
  setInterval(() => { if (!document.hidden) load(); }, 30_000);
}
