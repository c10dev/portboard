// The static demo's stand-in for the server (scripts/demo.ts inlines it first in every page's <head>, #13).
//
// - GET /api/… is answered from the JSON files next to the pages (api/…json, the path apiFile() maps to), with every
//   timestamp moved forward by the time since the example data was captured, so "5 min ago" stays 5 min ago.
// - Anything else to /api/ (every write) never leaves the browser: it answers 403 with "read-only demo", which the
//   page shows as its own error toast; when the page shows nothing, a toast of the shim's says it. There is no server
//   behind the demo at all; this only keeps the pages from trying.
// - A banner says it is a demo with example data, with links to the landing page and the repo (× hides it for the
//   tab; it steps aside while the page shows a toast, which sits in the same corner on a phone).
//
// Its text is in both languages here rather than in public/i18n: it is not part of the dashboard. scripts/demo.ts
// fills in the two placeholders below (demoShim).

(() => {
  const apiFile = __API_FILE__;
  const CAPTURED = __CAPTURED_AT__;
  const REPO = 'https://github.com/c10dev/portboard';
  const TEXT = {
    en: {
      banner: 'Demo with example data',
      sub: 'Read-only · none of these machines exist',
      about: 'About',
      get: 'Get Portboard',
      hide: 'Hide',
      readonly: 'This is a read-only demo: nothing was changed.',
      missing: 'Not part of the demo',
    },
    ko: {
      banner: '예시 데이터로 보는 데모',
      sub: '읽기 전용 · 실제로 있는 기기가 아닙니다',
      about: '소개',
      get: 'Portboard 받기',
      hide: '숨기기',
      readonly: '읽기 전용 데모라 아무것도 바뀌지 않았습니다.',
      missing: '데모에는 없는 데이터입니다',
    },
  };
  const text = () => TEXT[document.documentElement.lang === 'ko' ? 'ko' : 'en'];

  // the pages sit together in one folder (app/); their /api calls are absolute, wherever the site is hosted
  const BASE = new URL('./', location.href);
  const realFetch = window.fetch.bind(window);

  /** "/api/…?…" when a request is for the API, else null */
  function apiPath(input) {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
    if (!raw) return null;
    const u = new URL(raw, location.href);
    if (u.origin !== location.origin) return null;
    let p = u.pathname;
    if (p.startsWith(`${BASE.pathname}api/`)) p = p.slice(BASE.pathname.length - 1);
    return p.startsWith('/api/') ? p + u.search : null;
  }

  // Timestamps in the data: ISO strings and epoch milliseconds from up to a year before the capture
  const shift = Math.max(0, Date.now() - CAPTURED);
  const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
  const LOW = CAPTURED - 400 * 86_400_000;
  const HIGH = CAPTURED + 400 * 86_400_000;
  function fresh(v) {
    if (typeof v === 'string') return ISO.test(v) ? new Date(Date.parse(v) + shift).toISOString() : v;
    if (typeof v === 'number') return Number.isInteger(v) && v > LOW && v < HIGH ? v + shift : v;
    if (Array.isArray(v)) return v.map(fresh);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fresh(x)]));
    return v;
  }

  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

  window.fetch = async (input, init) => {
    const path = apiPath(input);
    if (!path) return realFetch(input, init);
    const method = String(init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      const msg = text().readonly;
      // the page's toast stack (lib/toast.js) usually shows the error; say it only when it didn't
      setTimeout(() => {
        if (![...document.querySelectorAll('.toast-stack')].some((el) => el.textContent.includes(msg))) toast(msg);
      }, 400);
      return json(403, { error: msg, demo: true });
    }
    const file = apiFile(path);
    const res = file ? await realFetch(new URL(file, BASE), { cache: 'no-cache' }).catch(() => null) : null;
    if (!res?.ok) return json(404, { error: text().missing });
    return json(200, fresh(await res.json()));
  };
  if (navigator.sendBeacon) {
    const beacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = (url, data) => (apiPath(url) ? false : beacon(url, data));
  }

  const STYLE = `
.demo-banner{position:fixed;left:50%;bottom:12px;transform:translateX(-50%);z-index:2147483000;display:flex;align-items:center;gap:10px;
  max-width:calc(100vw - 32px);box-sizing:border-box;padding:6px 8px 6px 14px;border-radius:999px;font:13px/1.3 system-ui,-apple-system,sans-serif;
  background:#1f2937;color:#f9fafb;box-shadow:0 4px 16px rgba(0,0,0,.25);white-space:nowrap}
.demo-banner b{font-weight:600}
.demo-banner .demo-sub{color:#cbd5e1;overflow:hidden;text-overflow:ellipsis}
.demo-banner a{color:#f9fafb;text-decoration:none;padding:4px 10px;border-radius:999px;background:rgba(255,255,255,.12)}
.demo-banner a:hover{background:rgba(255,255,255,.22)}
.demo-banner a.demo-get{background:#2f6feb}
.demo-banner button{all:unset;cursor:pointer;padding:2px 8px;border-radius:999px;color:#cbd5e1;font-size:16px;line-height:1}
.demo-banner button:hover,.demo-banner button:focus-visible{color:#fff;background:rgba(255,255,255,.12)}
.demo-toast{position:fixed;left:50%;bottom:60px;transform:translateX(-50%);z-index:2147483001;max-width:calc(100vw - 32px);box-sizing:border-box;
  padding:10px 14px;border-radius:10px;font:14px/1.4 system-ui,-apple-system,sans-serif;background:#111827;color:#f9fafb;
  box-shadow:0 6px 20px rgba(0,0,0,.3);transition:opacity .3s}
.demo-banner{transition:opacity .2s}
body:has(.toast-stack .toast) .demo-banner{opacity:0;pointer-events:none}
@media (max-width:640px){.demo-banner .demo-sub{display:none}.demo-banner{bottom:8px}}
@media print{.demo-banner,.demo-toast{display:none}}`;

  let styled = false;
  function style() {
    if (styled) return;
    styled = true;
    const el = document.createElement('style');
    el.textContent = STYLE;
    document.head.append(el);
  }

  let toastEl = null;
  let toastTimer = 0;
  function toast(msg) {
    if (!document.body) return;
    style();
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'demo-toast';
      toastEl.setAttribute('role', 'status');
      document.body.append(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.style.opacity = '0'; }, 3500);
  }

  const HIDDEN = 'pb.demo.bannerHidden';
  function banner() {
    try {
      if (sessionStorage.getItem(HIDDEN)) return;
    } catch {}
    const t = text();
    style();
    const bar = document.createElement('div');
    bar.className = 'demo-banner';
    bar.setAttribute('role', 'note');
    const title = document.createElement('b');
    title.textContent = t.banner;
    const sub = document.createElement('span');
    sub.className = 'demo-sub';
    sub.textContent = t.sub;
    const about = document.createElement('a');
    about.href = new URL('../', BASE).href;
    about.textContent = t.about;
    const get = document.createElement('a');
    get.className = 'demo-get';
    get.href = REPO;
    get.textContent = t.get;
    const hide = document.createElement('button');
    hide.type = 'button';
    hide.textContent = '×';
    hide.title = t.hide;
    hide.setAttribute('aria-label', t.hide);
    hide.addEventListener('click', () => {
      bar.remove();
      try { sessionStorage.setItem(HIDDEN, '1'); } catch {}
    });
    bar.append(title, sub, about, get, hide);
    document.body.append(bar);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', banner, { once: true });
  else banner();
})();
