// @ts-check
// 테마 (설정 › 화면): 시스템 · 라이트 · 다크 on this device. Kept in this browser only (localStorage pb.theme, nothing
// for 시스템) and put on <html data-theme="light|dark">; the stylesheets read it next to prefers-color-scheme
// (style.css, settings.css, devices.css: the dark tokens apply under :root[data-theme="dark"], and under the media
// query unless data-theme is light). lib/shell-boot.js applies the same before the first paint. In the Mac app the page
// also tells the app (the `portboard` message handler, {type: 'theme'}), which sets its own appearance to match.

export const THEME_KEY = 'pb.theme';
export const THEMES = ['system', 'light', 'dark'];

/** The remembered theme: 'system' | 'light' | 'dark' (anything else, a missing or blocked storage: system) */
export function loadTheme(storage = globalThis.localStorage) {
  try {
    const v = storage?.getItem(THEME_KEY);
    return v && THEMES.includes(v) ? v : 'system';
  } catch {
    return 'system';
  }
}

export function saveTheme(v, storage = globalThis.localStorage) {
  if (!THEMES.includes(v)) return;
  try {
    if (v === 'system') storage?.removeItem(THEME_KEY);
    else storage?.setItem(THEME_KEY, v);
  } catch {}
}

/**
 * Put it on <html>: data-theme (none for 시스템). Transitions are off for the frame the colours change in, so buttons
 * and rows don't fade between the two palettes (html[data-theme-switching] in style.css).
 * @param {string} v
 * @param {HTMLElement} [root]
 * @param {any} [win] the window; WKWebView adds webkit.messageHandlers.portboard in the Mac app
 */
export function applyTheme(v, root = globalThis.document?.documentElement, win = globalThis.window) {
  if (!root) return;
  const theme = THEMES.includes(v) ? v : 'system';
  root.dataset.themeSwitching = '';
  if (theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = theme;
  const done = () => { delete root.dataset.themeSwitching; };
  if (typeof win?.requestAnimationFrame === 'function') win.requestAnimationFrame(() => win.requestAnimationFrame(done));
  else done();
  win?.webkit?.messageHandlers?.portboard?.postMessage({ type: 'theme', theme });
}
