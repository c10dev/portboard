// Relative times and durations in Korean. The pages grew slightly different wordings (rounded vs floored, with or
// without 전); each variant is kept as it was so the text on screen doesn't change, and they live here side by side.

const minutesAgo = (iso) => Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));

/**
 * "방금", "5분", "3시간", "2일" (서비스 rows). suffix (" 전") goes after everything but 방금.
 * floor: whole hours/days rounded down (self-watch) instead of to the nearest.
 */
export function ago(iso, { suffix = '', floor = false } = {}) {
  const min = minutesAgo(iso);
  const r = floor ? Math.floor : Math.round;
  if (min < 1) return '방금';
  if (min < 60) return `${min}분${suffix}`;
  if (min < 48 * 60) return `${r(min / 60)}시간${suffix}`;
  return `${r(min / 1440)}일${suffix}`;
}

/** "방금", "5분 전", "3시간 전" (under a day), "4일 전" (under 60 days), "2개월 전"; floored; null for no time (기기 tab) */
export function agoMonths(iso) {
  if (!iso) return null;
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return '방금';
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  if (s < 86400 * 60) return `${Math.floor(s / 86400)}일 전`;
  return `${Math.floor(s / 86400 / 30)}개월 전`;
}

/** "오늘", "3일 전", "2개월 전"; '' for no time (개발 tab: last commit) */
export function agoDays(iso) {
  if (!iso) return '';
  const d = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 86_400_000));
  return d < 1 ? '오늘' : d < 30 ? `${d}일 전` : `${Math.round(d / 30)}개월 전`;
}

/** How long something has been going on: "5분째", "2시간 3분째"; under a minute is `zero` */
export function lasting(iso, zero = '방금') {
  const min = minutesAgo(iso);
  if (min < 1) return zero;
  if (min < 60) return `${min}분째`;
  return `${Math.floor(min / 60)}시간 ${min % 60}분째`;
}

/** "방금 확인", "3분 전에 확인", "2시간 전에 확인" for a time in ms (other machines' port lists) */
export function checkedAgo(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return '방금 확인';
  if (s < 3600) return `${Math.floor(s / 60)}분 전에 확인`;
  return `${Math.floor(s / 3600)}시간 전에 확인`;
}

/** A span in ms: "5분" (at least 1), "3시간", "2일" */
export function span(ms) {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${Math.max(1, min)}분`;
  if (min < 48 * 60) return `${Math.round(min / 60)}시간`;
  return `${Math.round(min / 1440)}일`;
}

/** Minutes of use, short: "1분 미만", "20분", "1.5시간", "12시간" (기기 tab) */
export function usageMinutes(m) {
  if (m < 1) return '1분 미만';
  if (m < 60) return `${Math.round(m)}분`;
  const h = m / 60;
  return `${h < 10 ? h.toFixed(1).replace(/\.0$/, '') : Math.round(h)}시간`;
}

/** Minutes, exact: "—" for none, "5분", "3시간 20분", "4일" (service page) */
export function hoursMinutes(m) {
  if (!m) return '—';
  if (m < 60) return `${Math.max(1, Math.round(m))}분`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}시간${Math.round(m % 60) ? ` ${Math.round(m % 60)}분` : ''}` : `${Math.round(m / 1440)}일`;
}

/** "10. 18. 오후 03:04"-style local month/day/time */
export const when = (iso) => new Date(iso).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
