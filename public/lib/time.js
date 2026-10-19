// Relative times and durations, in the page's language (lib/i18n.js time.*). The pages grew slightly different
// wordings (rounded vs floored, with or without 전 / ago); each variant is kept as it was so the text on screen
// doesn't change, and they live here side by side.

import { locale, t } from './i18n.js';

const minutesAgo = (iso) => Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));

const min = (n) => t('time.min', { n });
const hours = (n) => t('time.hour', { n });
const days = (n) => t('time.day', { n });
const months = (n) => t('time.month', { n });
const before = (text) => t('time.ago', { t: text });

/** True for what ago() and agoMonths() call 방금 (just now): under a minute */
export const isJustNow = (iso) => minutesAgo(iso) < 1;

/**
 * "방금", "5분", "3시간", "2일" (서비스 rows). suffix: "5분 전" (5m ago), on everything but 방금.
 * floor: whole hours/days rounded down (self-watch) instead of to the nearest.
 */
export function ago(iso, { suffix = false, floor = false } = {}) {
  const m = minutesAgo(iso);
  const r = floor ? Math.floor : Math.round;
  if (m < 1) return t('time.justNow');
  const text = m < 60 ? min(m) : m < 48 * 60 ? hours(r(m / 60)) : days(r(m / 1440));
  return suffix ? before(text) : text;
}

/** "방금", "5분 전", "3시간 전" (under a day), "4일 전" (under 60 days), "2개월 전"; floored; null for no time (기기 tab) */
export function agoMonths(iso) {
  if (!iso) return null;
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return t('time.justNow');
  if (s < 3600) return before(min(Math.floor(s / 60)));
  if (s < 86400) return before(hours(Math.floor(s / 3600)));
  if (s < 86400 * 60) return before(days(Math.floor(s / 86400)));
  return before(months(Math.floor(s / 86400 / 30)));
}

/** "오늘", "3일 전", "2개월 전"; '' for no time (개발 tab: last commit) */
export function agoDays(iso) {
  if (!iso) return '';
  const d = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 86_400_000));
  return d < 1 ? t('time.today') : d < 30 ? before(days(d)) : before(months(Math.round(d / 30)));
}

/** How long something has been going on: "5분째", "2시간 3분째"; under a minute is `zero` */
export function lasting(iso, zero = t('time.justNow')) {
  const m = minutesAgo(iso);
  if (m < 1) return zero;
  return t('time.lasting', { t: m < 60 ? min(m) : t('time.hourMin', { h: Math.floor(m / 60), m: m % 60 }) });
}

/** "방금 확인", "3분 전에 확인", "2시간 전에 확인" for a time in ms (other machines' port lists) */
export function checkedAgo(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return t('time.checkedJustNow');
  if (s < 3600) return t('time.checkedAgo', { t: min(Math.floor(s / 60)) });
  return t('time.checkedAgo', { t: hours(Math.floor(s / 3600)) });
}

/** A span in ms: "5분" (at least 1), "3시간", "2일" */
export function span(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return min(Math.max(1, m));
  if (m < 48 * 60) return hours(Math.round(m / 60));
  return days(Math.round(m / 1440));
}

/** Minutes of use, short: "1분 미만", "20분", "1.5시간", "12시간" (기기 tab) */
export function usageMinutes(m) {
  if (m < 1) return t('time.underMin');
  if (m < 60) return min(Math.round(m));
  const h = m / 60;
  return hours(h < 10 ? h.toFixed(1).replace(/\.0$/, '') : Math.round(h));
}

/** Minutes, exact: "—" for none, "5분", "3시간 20분", "4일" (service page) */
export function hoursMinutes(m) {
  if (!m) return '—';
  if (m < 60) return min(Math.max(1, Math.round(m)));
  const h = Math.floor(m / 60);
  return h < 48 ? (Math.round(m % 60) ? t('time.hourMin', { h, m: Math.round(m % 60) }) : hours(h)) : days(Math.round(m / 1440));
}

/** "10. 18. 오후 03:04"-style local month/day/time */
export const when = (iso) => new Date(iso).toLocaleString(locale(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
