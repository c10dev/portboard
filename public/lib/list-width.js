// @ts-check
// 목록 너비 (설정 › 화면, after the Claude app's 대화 기록 너비): how wide the list column may get on this device —
// 좁게 · 보통 · 넓게. Kept in this browser only (localStorage pb.listWidth) and applied as the shell's --col-max (the
// 서비스 list, shell.css) and --col-wide (개발) on <html>. lib/shell-boot.js applies the same values before the first
// paint (test/ui-settings.test.ts keeps the two copies equal); 보통 is the stylesheet's own width, so it sets nothing.

import { t } from './i18n.js';

export const LIST_WIDTH_KEY = 'pb.listWidth';

/** id → [--col-max, --col-wide] in CSS px */
export const LIST_WIDTHS = { narrow: [680, 808], normal: [808, 960], wide: [1080, 1280] };

export const LIST_WIDTH_LABELS = { narrow: t('listWidth.narrow'), normal: t('listWidth.normal'), wide: t('listWidth.wide') };

/** The remembered width: 'narrow' | 'normal' | 'wide' (anything else, a missing or blocked storage: normal) */
export function loadListWidth(storage = globalThis.localStorage) {
  try {
    const v = storage?.getItem(LIST_WIDTH_KEY);
    return v && Object.hasOwn(LIST_WIDTHS, v) ? v : 'normal';
  } catch {
    return 'normal';
  }
}

export function saveListWidth(v, storage = globalThis.localStorage) {
  if (!Object.hasOwn(LIST_WIDTHS, v)) return;
  try {
    if (v === 'normal') storage?.removeItem(LIST_WIDTH_KEY);
    else storage?.setItem(LIST_WIDTH_KEY, v);
  } catch {}
}

/** Put it on <html>: data-list-width and the two column widths (보통: the stylesheet's, nothing inline) */
export function applyListWidth(v, root = globalThis.document?.documentElement) {
  if (!root) return;
  const w = Object.hasOwn(LIST_WIDTHS, v) ? v : 'normal';
  if (w === 'normal') {
    delete root.dataset.listWidth;
    root.style.removeProperty?.('--col-max');
    root.style.removeProperty?.('--col-wide');
    return;
  }
  root.dataset.listWidth = w;
  root.style.setProperty('--col-max', `${LIST_WIDTHS[w][0]}px`);
  root.style.setProperty('--col-wide', `${LIST_WIDTHS[w][1]}px`);
}
