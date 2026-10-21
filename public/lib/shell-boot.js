// Inlined into every page's <head> by the server (src/core/shell.ts, the "boot" marker), so it runs before the
// first paint: no module, no imports. It defines window.PortboardBoot:
//   start({ inspector, locale, explicit, locales, strings })
//                         the page's language first: 설정 › 화면 › 언어 on this device (pb.locale, lib/i18n.js), else
//                         the server's locale when portboard.json or PORTBOARD_LOCALE sets it, else the browser's, else
//                         the server's; on <html lang> (lib/i18n.js loads that catalog) and in the pb_locale cookie (the
//                         server writes API text in it, src/core/i18n.ts). Then
//                         <html> attributes from what is remembered: the sidebar and inspector toggles and widths
//                         (pb.shell: --side-open / --insp-open and data-side-mode / data-insp-mode, the same arithmetic
//                         as lib/shell.js layoutFor), 설정 › 화면 › 목록 너비 (pb.listWidth: --col-max / --col-wide, as
//                         lib/list-width.js), 설정 › 화면 › 테마 (pb.theme: data-theme, as lib/theme.js), app mode (the Mac app's User-Agent, as lib/macapp.js), read-only (pb.ro,
//                         last /api/whoami)
//   relabel()             the markup the server filled in its own locale (data-t, data-t-<attr>; src/core/shell.ts
//                         fillStrings), in the page's language when that is another one: after the sidebar and at the end of the body
//   paintSide()           right after the sidebar's markup: the last view counts, 고정, 기기 (the network tree, its
//                         collapsed groups from pb.navFold) and footer chips (pb.nav, saved by features/nav.js), so a
//                         tab click shows the same sidebar at once
//   fill / counts / chips the sidebar painters lib/shell.js uses too (one copy)
// Everything is wrapped in try/catch: storage can be missing, full or blocked, and the page must still render.

(function () {
  var NAV_KEY = 'pb.nav';
  var root = document.documentElement;
  // lib/shell.js PANE and WIDTH (test/ui-shell.test.ts keeps them equal)
  var PANE = { side: { min: 200, max: 420, def: 288 }, insp: { min: 280, max: 480, def: 300 }, list: 324, gap: 8 };
  var SIDE_COLUMN = 704;
  // lib/list-width.js LIST_WIDTHS (test/ui-settings.test.ts keeps them equal): 보통 is the stylesheet's, nothing inline
  var LIST_WIDTHS = { narrow: [680, 808], wide: [1080, 1280] };
  var INSP_COLUMN = 1200;
  // lib/i18n.js LOCALE_KEY and LOCALE_COOKIE
  var LOCALE_KEY = 'pb.locale';
  var LOCALE_COOKIE = 'pb_locale';
  var I18N = { locale: 'en', page: 'en', strings: {} };

  /** A boot string (shell., page., boot., common. keys) in the page's language */
  function str(key) {
    var s = I18N.strings[I18N.page];
    return (s && s[key]) || key;
  }

  /** 'ko' | 'en': this device's choice, else the server's set locale, else the browser's, else the server's */
  function pickLocale(o) {
    var locales = o.locales || [o.locale];
    var has = function (l) { return locales.indexOf(l) >= 0; };
    try {
      var pref = window.localStorage.getItem(LOCALE_KEY);
      if (has(pref)) return pref;
    } catch (e) { /* 자동 */ }
    if (o.explicit) return o.locale;
    var langs = (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || '']);
    for (var i = 0; i < langs.length; i++) {
      var l = String(langs[i] || '').slice(0, 2).toLowerCase();
      if (has(l)) return l;
    }
    return o.locale;
  }

  /** Text and attributes the server wrote in its locale, in the page's (nothing to do when they are the same) */
  function relabel(scope) {
    if (I18N.page === I18N.locale) return;
    var s = I18N.strings[I18N.page] || {};
    var sels = ['[data-t]', '[data-th]', '[data-t-title]', '[data-t-aria-label]', '[data-t-placeholder]', '[data-t-label]'];
    var nodes = [];
    for (var j = 0; j < sels.length; j++) nodes.push.apply(nodes, (scope || document).querySelectorAll(sels[j]));
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var d = n.dataset;
      if (d.t && s[d.t] != null) n.textContent = s[d.t];
      if (d.th && s[d.th] != null) n.innerHTML = s[d.th];
      if (d.tTitle && s[d.tTitle] != null) n.setAttribute('title', s[d.tTitle]);
      if (d.tAriaLabel && s[d.tAriaLabel] != null) n.setAttribute('aria-label', s[d.tAriaLabel]);
      if (d.tPlaceholder && s[d.tPlaceholder] != null) n.setAttribute('placeholder', s[d.tPlaceholder]);
      if (d.tLabel && s[d.tLabel] != null) n.setAttribute('label', s[d.tLabel]);
    }
  }

  function clampWidth(pane, w) {
    var p = PANE[pane];
    var n = Number(w);
    if (w == null || w === '' || !isFinite(n)) return p.def;
    return Math.round(Math.max(p.min, Math.min(p.max, n)));
  }

  /** lib/shell.js layoutFor(), for the first paint: { side, insp } 'column' | 'overlay' */
  function modes(width, sideW, inspW, sideOpen) {
    var side = width < Math.max(SIDE_COLUMN, sideW + PANE.gap + PANE.list) ? 'overlay' : 'column';
    var shown = sideOpen && side === 'column' ? sideW : 0;
    return { side: side, insp: width < Math.max(INSP_COLUMN, shown + PANE.gap + PANE.list + inspW) ? 'overlay' : 'column' };
  }

  function read(storage, key) {
    try { return JSON.parse(storage.getItem(key) || 'null'); } catch (e) { return null; }
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  var FOLD_KEY = 'pb.navFold';

  /** The collapsed tree groups { key: 1 } (lib/nettree.js FOLD_KEY) */
  function folded() {
    var f = read(window.localStorage, FOLD_KEY);
    return f && typeof f === 'object' ? f : {};
  }

  /** Hide every row under a collapsed group; the fold buttons say which way they point */
  function applyFold(sec) {
    var f = folded();
    var lis = sec.querySelectorAll('li');
    for (var i = 0; i < lis.length; i++) {
      var li = lis[i];
      var up = li.dataset.up ? li.dataset.up.split(' ') : [];
      var hide = false;
      for (var j = 0; j < up.length; j++) if (f[decodeURIComponent(up[j])]) hide = true;
      li.hidden = hide;
      var b = li.querySelector('.si-fold');
      if (b && b.dataset.fold) b.setAttribute('aria-expanded', f[b.dataset.fold] ? 'false' : 'true');
    }
  }

  /** A fold button or a group row was clicked: flip that group, remember it, repaint the hiding */
  function onFold(ev, sec) {
    var t = ev.target;
    var b = t && t.closest ? t.closest('[data-fold]') : null;
    if (!b) return;
    ev.preventDefault();
    var f = folded();
    var key = b.dataset.fold;
    if (f[key]) delete f[key];
    else f[key] = 1;
    try { window.localStorage.setItem(FOLD_KEY, JSON.stringify(f)); } catch (e) { /* not remembered */ }
    applyFold(sec);
  }

  /**
   * A sidebar list (#sidePinned, #sideDevices): items [{ text, sub, tone, href, title, key, target, badges, depth, up,
   * fold }]; hidden when empty. depth indents a tree row, up names the groups above it (collapsed ones hide it), fold
   * gives it a ▸ button; a row without href is a group heading (a click folds it).
   */
  function fill(id, items) {
    var sec = document.getElementById(id);
    if (!sec) return;
    var ul = sec.querySelector('ul');
    var lis = [];
    var tree = false;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var isTree = it.depth != null;
      if (isTree) tree = true;
      var a = el(it.href ? 'a' : 'span', 'side-item' + (it.tone ? ' t-' + it.tone : '') + (it.href ? '' : ' si-group'));
      if (it.href) a.setAttribute('href', String(it.href));
      else if (it.fold) a.dataset.fold = String(it.key);
      if (it.title) a.setAttribute('title', String(it.title));
      if (it.key != null) a.dataset.key = String(it.key);
      if (it.target != null) a.dataset.target = String(it.target);
      if (it.tone) a.append(el('span', 'dot'));
      a.append(el('span', 'si-text', String(it.text)));
      var badges = it.badges || [];
      for (var k = 0; k < badges.length; k++) a.append(el('span', 'si-badge', String(badges[k])));
      if (it.sub) a.append(el('span', 'si-sub', String(it.sub)));
      var li = el('li', isTree ? 'si-row' : null);
      if (isTree) {
        li.style.setProperty('--d', String(Number(it.depth) || 0));
        var up = it.up || [];
        var enc = [];
        for (var u = 0; u < up.length; u++) enc.push(encodeURIComponent(String(up[u])));
        if (enc.length) li.dataset.up = enc.join(' ');
        if (it.fold) {
          var b = el('button', 'si-fold');
          b.setAttribute('type', 'button');
          b.dataset.fold = String(it.key);
          b.setAttribute('aria-label', str('boot.fold').replace('{name}', String(it.text)));
          b.setAttribute('aria-expanded', 'true');
          li.append(b);
        } else {
          li.append(el('span', 'si-fold-pad'));
        }
      }
      li.append(a);
      lis.push(li);
    }
    ul.replaceChildren.apply(ul, lis);
    sec.classList.toggle('side-tree', tree);
    if (tree) {
      if (!sec.dataset.foldWired) {
        sec.dataset.foldWired = '1';
        sec.addEventListener('click', function (ev) { onFold(ev, sec); });
      }
      applyFold(sec);
    }
    sec.hidden = items.length === 0;
  }

  /** The views' counts { services, devices, dev, settings }; null clears one, a missing key leaves it */
  function counts(c) {
    for (var k in c) {
      var n = document.getElementById('count-' + k);
      if (n) n.textContent = c[k] == null ? '' : String(c[k]);
    }
  }

  /** The footer chips as features/nav.js saw them: { ob: { hidden, warn, text, title }, sw: { hidden, tone, text } } */
  function chips(c) {
    var ob = document.getElementById('obChip');
    if (ob && c.ob) {
      ob.hidden = !!c.ob.hidden;
      ob.classList.toggle('warn', !!c.ob.warn);
      if (c.ob.title) ob.title = String(c.ob.title);
      var t = document.getElementById('obText');
      if (t) t.textContent = String(c.ob.text || '');
    }
    var sw = document.getElementById('swChip');
    if (sw && c.sw) {
      sw.hidden = !!c.sw.hidden;
      sw.classList.toggle('warn', c.sw.tone === 'warn');
      sw.classList.toggle('alarm', c.sw.tone === 'alarm');
      var s = document.getElementById('swText');
      if (s) s.textContent = String(c.sw.text || '');
    }
  }

  /** The 🔒 읽기 전용 line in the footer (lib/access.js keeps it current) */
  function readonlyNote(reason) {
    var foot = document.getElementById('shellFoot');
    if (!foot || foot.querySelector('.readonly-note')) return;
    var p = el('p', 'readonly-note', str('boot.readonly').replace('{reason}', reason || str('common.readonlyReason')));
    p.setAttribute('role', 'note');
    foot.append(p);
  }

  window.PortboardBoot = {
    NAV_KEY: NAV_KEY,
    fill: fill,
    counts: counts,
    chips: chips,
    readonlyNote: readonlyNote,
    modes: modes,
    relabel: relabel,
    pickLocale: pickLocale,
    start: function (opts) {
      try {
        if (opts && opts.locale) {
          I18N = { locale: opts.locale, page: pickLocale(opts), strings: opts.strings || {} };
          root.lang = I18N.page;
          // the "불러오는 중…" under a page that is still waiting (shell.css [data-wait]::before)
          root.style.setProperty('--t-loading', JSON.stringify(str('common.loading')));
          if (document.cookie.indexOf(LOCALE_COOKIE + '=' + I18N.page) < 0) {
            document.cookie = LOCALE_COOKIE + '=' + I18N.page + '; path=/; max-age=31536000; samesite=lax';
          }
        }
      } catch (e) { /* the server's locale, as rendered */ }
      var s = read(window.localStorage, 'pb.shell') || {};
      if (typeof s !== 'object') s = {};
      root.dataset.shell = '1';
      root.dataset.side = s.side === false ? 'closed' : 'open';
      root.dataset.insp = opts && opts.inspector && s.insp !== false ? 'open' : 'closed';
      var sideW = clampWidth('side', s.sideW);
      var inspW = clampWidth('insp', s.inspW);
      try {
        root.style.setProperty('--side-open', sideW + 'px');
        root.style.setProperty('--insp-open', inspW + 'px');
      } catch (e) { /* no style: the defaults in shell.css */ }
      var m = modes(window.innerWidth || root.clientWidth || INSP_COLUMN, sideW, inspW, s.side !== false);
      root.dataset.sideMode = m.side;
      root.dataset.inspMode = m.insp;
      try {
        var lw = window.localStorage.getItem('pb.listWidth');
        if (lw && Object.prototype.hasOwnProperty.call(LIST_WIDTHS, lw)) {
          root.dataset.listWidth = lw;
          root.style.setProperty('--col-max', LIST_WIDTHS[lw][0] + 'px');
          root.style.setProperty('--col-wide', LIST_WIDTHS[lw][1] + 'px');
        }
      } catch (e) { /* 보통: the stylesheet's widths */ }
      // 설정 › 화면 › 테마 (pb.theme, as lib/theme.js): light or dark on <html>, nothing for 시스템; the Mac app hears it
      var theme = 'system';
      try {
        var th = window.localStorage.getItem('pb.theme');
        if (th === 'light' || th === 'dark') theme = root.dataset.theme = th;
      } catch (e) { /* 시스템 */ }
      try { window.webkit.messageHandlers.portboard.postMessage({ type: 'theme', theme: theme }); } catch (e) { /* not the Mac app */ }
      if (/\bportboard-mac\//.test(navigator.userAgent)) root.dataset.app = 'mac';
      var ro = read(window.sessionStorage, 'pb.ro');
      if (ro && ro.readonly) root.dataset.readonly = '1';
    },
    paintSide: function () {
      try { relabel(); } catch (e) { /* the server's text stays */ }
      var nav = read(window.localStorage, NAV_KEY);
      // a cache written in another language would show its text until the live data repaints it
      if (nav && nav.locale && nav.locale !== I18N.page) nav = null;
      if (nav) {
        try {
          if (nav.counts) counts(nav.counts);
          if (nav.pinned) fill('sidePinned', nav.pinned);
          if (nav.devices) fill('sideDevices', nav.devices);
          if (nav.chips) chips(nav.chips);
        } catch (e) { /* a cache from another version: the live data repaints it */ }
      }
      var ro = read(window.sessionStorage, 'pb.ro');
      if (ro && ro.readonly) readonlyNote(ro.reason);
    },
  };
})();
