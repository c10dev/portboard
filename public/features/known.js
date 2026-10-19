// 새 기기 on the 기기 tab (src/features/known.ts): the list of devices seen for the first time with 이름 붙이기 and
// 확인 each (plus 모두 확인), the alert settings, and the block at the top of a new device's detail.
//
// ctx: { data (the last /api/usage), showDetail(id), nameDevice(card-like), refresh(fresh) }

import { postOrThrow } from '../lib/api.js';
import { $, el } from '../lib/dom.js';
import { locale, t } from '../lib/i18n.js';
import { agoMonths as ago } from '../lib/time.js';
import { toast } from '../lib/toast.js';

const say = (text, error = false) => toast(text, error, { ms: 3500 });

/** "Apple, Inc." → "Apple" */
export const short = (v) => v.replace(/[,.]?\s+(Co\.?,?\s*)?(Ltd|Inc|Corp|GmbH|LLC|INTL)\b.*$/i, '');

const nd = (data) => data.newDevices ?? { settings: { connections: true, neighbors: false }, pending: [], alertsOn: true };

function newWhat(p) {
  return p.scope === 'neighbor' ? t('known.what.lan') : p.service ? t('known.what.service', { service: p.service.name, port: p.service.port }) : t('known.what.connect');
}

function ackButton(key, ctx, title) {
  const ok = el('button', 'nd-ack', t('known.ack'));
  ok.dataset.write = '1';
  ok.type = 'button';
  if (title) ok.title = title;
  ok.addEventListener('click', () => acknowledge(key, ctx));
  return ok;
}

function nameButton(target, ctx) {
  const b = el('button', 'name-btn', t('devices.nameIt'));
  b.dataset.write = '1';
  b.type = 'button';
  b.addEventListener('click', () => ctx.nameDevice(target));
  return b;
}

/** Pending new devices: a one-tap 이름 붙이기 (LAN) and 확인 each, plus 모두 확인. */
export function renderNewDevices(ctx) {
  const { data } = ctx;
  const list = nd(data).pending;
  const box = $('newDevs');
  box.hidden = !list.length;
  if (!list.length) return box.replaceChildren();
  const h = el('div', 'nd-h');
  h.append(el('strong', null, t('known.head', { n: list.length })), el('span', 'nd-sub', t('known.sub')));
  if (list.length > 1) {
    const all = el('button', 'nd-ack', t('known.ackAll'));
    all.dataset.write = '1';
    all.type = 'button';
    all.addEventListener('click', () => acknowledge('all', ctx));
    h.append(all);
  }
  const ul = el('ul', 'nd-list');
  for (const p of list) {
    const li = el('li', 'nd-item');
    const card = p.cardId ? data.cards.find((c) => c.id === p.cardId) : null;
    const who = el(card ? 'button' : 'div', 'nd-who');
    if (card) {
      who.type = 'button';
      who.title = t('known.view');
      who.addEventListener('click', () => ctx.showDetail(card.id));
    }
    const sub = [p.kind === 'tailnet' ? 'Tailscale' : `LAN${p.ip ? ` ${p.ip}` : ''}`, p.vendor ? short(p.vendor) : null, newWhat(p), ago(p.since)].filter(Boolean).join(' · ');
    who.append(el('span', 'badge new', t('known.badge')), el('span', 'nd-name', card?.name ?? p.name), el('span', 'nd-meta', sub));
    li.append(who);
    const acts = el('span', 'nd-acts');
    if (p.nameKey) {
      acts.append(nameButton({ nameKey: p.nameKey, addresses: p.ip ? [p.ip] : [], id: p.cardId ?? p.key, vendor: p.vendor, nameSource: card?.nameSource ?? 'ip', name: card?.name ?? p.name }, ctx));
    }
    acts.append(ackButton(p.key, ctx, t('known.ack.title')));
    li.append(acts);
    ul.append(li);
  }
  box.replaceChildren(h, ul);
}

/** The two alert switches: first connection to a service here (on by default), first seen on the LAN (off) */
export function renderSettings(ctx) {
  const s = nd(ctx.data).settings;
  const box = $('ndSettings');
  const row = (key, label, help) => {
    const l = el('label', 'nd-opt');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = !!s[key];
    cb.addEventListener('change', () => saveSettings({ [key]: cb.checked }, ctx));
    const text = el('span');
    text.append(el('span', null, label), el('span', 'nd-help', help));
    l.append(cb, text);
    return l;
  };
  box.replaceChildren(
    row('connections', t('known.opt.connections'), t('known.opt.connections.help')),
    row('neighbors', t('known.opt.neighbors'), t('known.opt.neighbors.help')),
    el('p', 'muted small', nd(ctx.data).alertsOn
      ? t('known.alertsOn')
      : t('known.alertsOff')),
  );
}

async function acknowledge(key, ctx) {
  try {
    await postOrThrow('/api/known-devices/ack', { key });
    say(key === 'all' ? t('known.ackedAll') : t('known.acked'));
    await ctx.refresh(true);
  } catch (err) {
    say(t('known.ackFailed', { error: err.message }), true);
  }
}

async function saveSettings(patch, ctx) {
  try {
    await postOrThrow('/api/known-devices/settings', patch);
    say(t('known.saved'));
    await ctx.refresh(true);
  } catch (err) {
    say(t('devices.saveFailed', { error: err.message }), true);
  }
}

/** 새 기기 at the top of the detail: what was seen first, and the two ways to clear it */
export function newBlock(c, ctx) {
  const p = nd(ctx.data).pending.find((x) => x.key === c.newDevice.key);
  const box = el('div', 'nd-detail');
  box.append(el('strong', null, t('known.title')), el('p', null, `${p ? newWhat(p) : t('known.what.seen')} · ${ago(c.newDevice.since)} (${new Date(c.newDevice.since).toLocaleString(locale())})${p?.notified ? ` · ${t('known.notified')}` : ''}`));
  const acts = el('div', 'nd-acts');
  if (c.nameKey) acts.append(nameButton(c, ctx));
  acts.append(ackButton(c.newDevice.key, ctx));
  box.append(acts);
  return box;
}
