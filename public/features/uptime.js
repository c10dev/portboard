// Uptime bars (Uptime Kuma style) for watched ports: the 서비스 rows (recent checks) and service.html (24 h, 30 days).
// Data: /api/alerts watching[].uptime and /api/ports/:port/detail uptime (src/core/uptime.ts).

import { locale, t } from '../lib/i18n.js';
import { span } from '../lib/time.js';

const STATE = { u: 'up', d: 'down', q: 'quiet', '-': null };
const WORD = { up: t('uptime.up'), down: t('uptime.down'), quiet: t('uptime.quiet'), null: t('uptime.none') };

/** "99.95%", "100%", or "—" when nothing in the window was checked */
export function pctText(pct) {
  if (pct === null || pct === undefined) return '—';
  return `${pct === 100 ? '100' : pct.toFixed(pct >= 99 ? 2 : 1)}%`;
}

/** slots: [{state: 'up'|'down'|'quiet'|null, title}] → a row of pills */
export function bar(slots, cls = '') {
  const el = document.createElement('span');
  el.className = `ubar ${cls}`;
  el.setAttribute('role', 'img');
  for (const s of slots) {
    const i = document.createElement('i');
    i.className = s.state ?? 'none';
    if (s.title) i.title = s.title;
    el.append(i);
  }
  const counts = slots.reduce((a, s) => ((a[s.state ?? 'none'] = (a[s.state ?? 'none'] ?? 0) + 1), a), {});
  el.setAttribute('aria-label', t('uptime.aria', { n: slots.length, up: counts.up ?? 0, down: counts.down ?? 0 }));
  return el;
}

/** The row's line: last 30 checks + "24시간 99.9% · 7일 100%". u: watching[].uptime */
export function uptimeLine(u) {
  const line = document.createElement('div');
  line.className = 'uptime-line';
  if (!u) {
    line.append(document.createTextNode(t('uptime.noData')));
    line.classList.add('muted');
    return line;
  }
  const n = u.checks.length;
  const slots = [...u.checks].map((c, i) => ({ state: STATE[c], title: t('uptime.slot', { s: (n - i) * 30, state: WORD[STATE[c]] }) }));
  const short = (covered, full) => (covered < full * 0.95 ? ` (${t('uptime.measured', { span: span(covered) })})` : '');
  const text = document.createElement('span');
  text.className = 'uptime-pct';
  text.textContent = t('uptime.line', { pct24h: pctText(u.pct24h), short24h: short(u.covered24hMs, 864e5), pct7d: pctText(u.pct7d), short7d: short(u.covered7dMs, 7 * 864e5) });
  line.append(bar(slots), text);
  line.title = t('uptime.title', { time: new Date(u.lastCheck).toLocaleTimeString(locale()) });
  return line;
}

/** Bigger bars for service.html: slots from the detail endpoint ({from, state, pct}), label formats each slot's time */
export function slotBar(slots, label, cls = '') {
  return bar(slots.map((s) => ({ state: s.state, title: `${label(new Date(s.from))} · ${s.state ? `${pctText(s.pct)}${s.state === 'quiet' ? ` (${t('uptime.quietShort')})` : ''}` : t('uptime.none')}` })), cls);
}
