// 새 기기 on the 기기 tab (src/features/known.ts): the list of devices seen for the first time with 이름 붙이기 and
// 확인 each (plus 모두 확인), the alert settings, and the block at the top of a new device's detail.
//
// ctx: { data (the last /api/usage), showDetail(id), nameDevice(card-like), refresh(fresh) }

import { postOrThrow } from '../lib/api.js';
import { $, el } from '../lib/dom.js';
import { agoMonths as ago } from '../lib/time.js';
import { toast } from '../lib/toast.js';

const say = (text, error = false) => toast(text, error, { ms: 3500 });

/** "Apple, Inc." → "Apple" */
export const short = (v) => v.replace(/[,.]?\s+(Co\.?,?\s*)?(Ltd|Inc|Corp|GmbH|LLC|INTL)\b.*$/i, '');

const nd = (data) => data.newDevices ?? { settings: { connections: true, neighbors: false }, pending: [], alertsOn: true };

function newWhat(p) {
  return p.scope === 'neighbor' ? 'LAN에 처음 보임' : p.service ? `${p.service.name} :${p.service.port}에 처음 접속` : '처음 접속';
}

function ackButton(key, ctx, title) {
  const ok = el('button', 'nd-ack', '확인');
  ok.dataset.write = '1';
  ok.type = 'button';
  if (title) ok.title = title;
  ok.addEventListener('click', () => acknowledge(key, ctx));
  return ok;
}

function nameButton(target, ctx) {
  const b = el('button', 'name-btn', '이름 붙이기');
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
  h.append(el('strong', null, `새 기기 ${list.length}`), el('span', 'nd-sub', '이 서버에서 처음 본 기기예요. 아는 기기면 이름을 붙이거나 확인을 눌러 주세요.'));
  if (list.length > 1) {
    const all = el('button', 'nd-ack', '모두 확인');
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
      who.title = '기기 보기';
      who.addEventListener('click', () => ctx.showDetail(card.id));
    }
    const sub = [p.kind === 'tailnet' ? 'Tailscale' : `LAN${p.ip ? ` ${p.ip}` : ''}`, p.vendor ? short(p.vendor) : null, newWhat(p), ago(p.since)].filter(Boolean).join(' · ');
    who.append(el('span', 'badge new', '새 기기'), el('span', 'nd-name', card?.name ?? p.name), el('span', 'nd-meta', sub));
    li.append(who);
    const acts = el('span', 'nd-acts');
    if (p.nameKey) {
      acts.append(nameButton({ nameKey: p.nameKey, addresses: p.ip ? [p.ip] : [], id: p.cardId ?? p.key, vendor: p.vendor, nameSource: card?.nameSource ?? 'ip', name: card?.name ?? p.name }, ctx));
    }
    acts.append(ackButton(p.key, ctx, '아는 기기예요: 새 기기 표시를 지워요'));
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
    const t = el('span');
    t.append(el('span', null, label), el('span', 'nd-help', help));
    l.append(cb, t);
    return l;
  };
  box.replaceChildren(
    row('connections', '이 서버의 서비스에 처음 접속한 기기', '기본 켜짐. tailnet 기기나 LAN 기기가 처음 연결하면 한 번 알려요.'),
    row('neighbors', 'LAN에 처음 보인 기기 (ARP/이웃 테이블)', '기본 꺼짐. 이 서버와 패킷을 주고받은 모든 기기가 잡혀서 시끄러울 수 있어요.'),
    el('p', 'muted small', nd(ctx.data).alertsOn
      ? '다운 알림과 같은 채널(ntfy)로 보내요. 여러 대가 한꺼번에 보이면 10분에 한 번으로 묶어요. 알림에는 이름·제조사·서비스만 담고 주소는 넣지 않아요.'
      : 'PORTBOARD_ALERTS=off: 알림은 보내지 않고 새 기기 표시만 해요.'),
  );
}

async function acknowledge(key, ctx) {
  try {
    await postOrThrow('/api/known-devices/ack', { key });
    say(key === 'all' ? '모두 확인했어요' : '확인했어요');
    await ctx.refresh(true);
  } catch (err) {
    say(`확인 실패: ${err.message}`, true);
  }
}

async function saveSettings(patch, ctx) {
  try {
    await postOrThrow('/api/known-devices/settings', patch);
    say('새 기기 알림 설정을 저장했어요');
    await ctx.refresh(true);
  } catch (err) {
    say(`저장 실패: ${err.message}`, true);
  }
}

/** 새 기기 at the top of the detail: what was seen first, and the two ways to clear it */
export function newBlock(c, ctx) {
  const p = nd(ctx.data).pending.find((x) => x.key === c.newDevice.key);
  const box = el('div', 'nd-detail');
  box.append(el('strong', null, '새 기기'), el('p', null, `${p ? newWhat(p) : '처음 봄'} · ${ago(c.newDevice.since)} (${new Date(c.newDevice.since).toLocaleString()})${p?.notified ? ' · 알림 보냄' : ''}`));
  const acts = el('div', 'nd-acts');
  if (c.nameKey) acts.append(nameButton(c, ctx));
  acts.append(ackButton(c.newDevice.key, ctx));
  box.append(acts);
  return box;
}
