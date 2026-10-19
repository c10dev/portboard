// A small DOM for render smoke tests in node (no packages): elements with attributes, classes, dataset, children and
// listeners, text nodes, and querySelector for one compound selector (tag, #id, .class, [attr], [attr="v"]), which is
// all lib/shell.js and the inspector use. Not a browser: layout, CSS and events are only what a test drives.

type Listener = (e: any) => void;

class FakeNode {
  parentNode: FakeElement | null = null;
  remove() {
    if (!this.parentNode) return;
    const kids = this.parentNode.childNodes;
    kids.splice(kids.indexOf(this), 1);
    this.parentNode = null;
  }
  after(...nodes: (FakeNode | string)[]) {
    const p = this.parentNode!;
    let i = p.childNodes.indexOf(this) + 1;
    for (const n of nodes.map(toNode)) { n.remove(); n.parentNode = p; p.childNodes.splice(i++, 0, n); }
  }
}

export class FakeText extends FakeNode {
  data: string;
  constructor(data: string) { super(); this.data = data; }
  get textContent() { return this.data; }
}

const toNode = (n: FakeNode | string) => (typeof n === 'string' ? new FakeText(n) : n);
const kebab = (k: string) => k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

export class FakeElement extends FakeNode {
  childNodes: FakeNode[] = [];
  attrs = new Map<string, string>();
  listeners = new Map<string, Listener[]>();
  style: Record<string, any> = { setProperty(k: string, v: string) { (this as any)[k] = v; } };
  disabled = false;
  open = false;
  checked = false;
  value = '';
  type = '';
  innerHTML = '';
  scrollTop = 0;
  dataset: Record<string, string>;
  tagName: string;
  ownerDocument: FakeDocument;
  constructor(tagName: string, ownerDocument: FakeDocument) {
    super();
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.dataset = new Proxy({} as Record<string, string>, {
      get: (_t, k: string) => this.attrs.get(`data-${kebab(k)}`),
      set: (_t, k: string, v) => { this.attrs.set(`data-${kebab(k)}`, String(v)); return true; },
      has: (_t, k: string) => this.attrs.has(`data-${kebab(k)}`),
      deleteProperty: (_t, k: string) => { this.attrs.delete(`data-${kebab(k)}`); return true; },
      ownKeys: () => [...this.attrs.keys()].filter((a) => a.startsWith('data-')).map((a) => a.slice(5).replace(/-([a-z])/g, (_m, c) => c.toUpperCase())),
      getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
    });
  }
  get id() { return this.attrs.get('id') ?? ''; }
  set id(v: string) { this.attrs.set('id', v); }
  get className() { return this.attrs.get('class') ?? ''; }
  set className(v: string) { this.attrs.set('class', v); }
  get hidden() { return this.attrs.has('hidden'); }
  set hidden(v: boolean) { if (v) this.attrs.set('hidden', ''); else this.attrs.delete('hidden'); }
  get title() { return this.attrs.get('title') ?? ''; }
  set title(v: string) { this.attrs.set('title', v); }
  set href(v: string) { this.attrs.set('href', v); }
  get href() { return this.attrs.get('href') ?? ''; }
  get classList() {
    const get = () => this.className.split(/\s+/).filter(Boolean);
    const set = (c: string[]) => { this.className = c.join(' '); };
    return {
      contains: (c: string) => get().includes(c),
      add: (...c: string[]) => set([...new Set([...get(), ...c])]),
      remove: (...c: string[]) => set(get().filter((x) => !c.includes(x))),
      toggle: (c: string, on?: boolean) => { const has = get().includes(c); const want = on ?? !has; if (want && !has) set([...get(), c]); if (!want && has) set(get().filter((x) => x !== c)); return want; },
    };
  }
  setAttribute(k: string, v: string) { this.attrs.set(k, String(v)); }
  getAttribute(k: string) { return this.attrs.get(k) ?? null; }
  hasAttribute(k: string) { return this.attrs.has(k); }
  removeAttribute(k: string) { this.attrs.delete(k); }
  get children() { return this.childNodes.filter((n): n is FakeElement => n instanceof FakeElement); }
  get firstChild() { return this.childNodes[0] ?? null; }
  get firstElementChild() { return this.children[0] ?? null; }
  get lastElementChild() { return this.children.at(-1) ?? null; }
  get nextSibling() { const k = this.parentNode?.childNodes; return k ? k[k.indexOf(this) + 1] ?? null : null; }
  get parentElement() { return this.parentNode; }
  get textContent(): string { return this.childNodes.map((n) => (n as any).textContent).join(''); }
  set textContent(v: string) { this.replaceChildren(String(v ?? '')); }
  append(...nodes: (FakeNode | string)[]) { for (const n of nodes.map(toNode)) { n.remove(); n.parentNode = this; this.childNodes.push(n); } }
  appendChild(n: FakeNode) { this.append(n); return n; }
  prepend(...nodes: (FakeNode | string)[]) { const ns = nodes.map(toNode); for (const n of ns) n.remove(); for (const n of ns) n.parentNode = this; this.childNodes.unshift(...ns); }
  insertBefore(n: FakeNode, ref: FakeNode | null) {
    if (!ref) return this.append(n);
    n.remove();
    n.parentNode = this;
    this.childNodes.splice(this.childNodes.indexOf(ref), 0, n);
  }
  replaceChildren(...nodes: (FakeNode | string)[]) { for (const n of [...this.childNodes]) n.remove(); this.append(...nodes); }
  contains(n: FakeNode | null): boolean { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
  addEventListener(t: string, fn: Listener) { this.listeners.set(t, [...(this.listeners.get(t) ?? []), fn]); }
  dispatch(t: string, e: any = {}) { for (const fn of this.listeners.get(t) ?? []) fn({ target: this, preventDefault() {}, ...e }); }
  click() { this.dispatch('click'); }
  /** an Event (new Event('change')) to this element's own listeners, as dispatchEvent does without bubbling */
  dispatchEvent(e: { type: string }) { for (const fn of this.listeners.get(e.type) ?? []) fn(e); return true; }
  focus() { this.ownerDocument.activeElement = this; }
  /** markup is not parsed: kept as text in innerHTML (icons) */
  insertAdjacentHTML(_where: string, html: string) { this.innerHTML += html; }
  toggleAttribute(k: string, on?: boolean) { const v = on ?? !this.attrs.has(k); if (v) this.attrs.set(k, ''); else this.attrs.delete(k); return v; }
  matches(sel: string) { return matches(this, sel); }
  closest(sel: string): FakeElement | null {
    for (let x: FakeElement | null = this; x; x = x.parentNode) if (sel.split(',').some((s) => matches(x!, s.trim()))) return x;
    return null;
  }
  descendants(): FakeElement[] { return this.children.flatMap((c) => [c, ...c.descendants()]); }
  querySelectorAll(sel: string) { const parts = sel.split(',').map((s) => s.trim()); return this.descendants().filter((e) => parts.some((s) => matches(e, s))); }
  querySelector(sel: string) { return this.querySelectorAll(sel)[0] ?? null; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0 }; }
  scrollIntoView() {}
}

/** One compound selector: tag, #id, .class, [attr], [attr="v"] (no combinators) */
function matches(e: FakeElement, sel: string): boolean {
  if (sel.includes(' ')) throw new Error(`fake DOM: no combinators (${sel})`);
  const m = sel.match(/^([a-z0-9]*)((?:[#.][\w-]+|\[[^\]]+\])*)$/i);
  if (!m) throw new Error(`fake DOM: selector ${sel}`);
  if (m[1] && e.tagName !== m[1].toUpperCase()) return false;
  for (const part of m[2].match(/[#.][\w-]+|\[[^\]]+\]/g) ?? []) {
    if (part[0] === '#' && e.id !== part.slice(1)) return false;
    if (part[0] === '.' && !e.classList.contains(part.slice(1))) return false;
    if (part[0] === '[') {
      const [, k, v] = part.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/)!;
      if (k === 'open' ? !e.open : !e.attrs.has(k)) return false;
      if (v !== undefined && e.attrs.get(k) !== v) return false;
    }
  }
  return true;
}

export class FakeDocument {
  listeners = new Map<string, Listener[]>();
  documentElement: FakeElement;
  body: FakeElement;
  hidden = false;
  activeElement: FakeElement;
  constructor() {
    this.documentElement = new FakeElement('html', this);
    this.body = new FakeElement('body', this);
    this.documentElement.append(this.body);
    this.activeElement = this.body;
  }
  createElement(tag: string) { return new FakeElement(tag, this); }
  createTextNode(t: string) { return new FakeText(t); }
  getElementById(id: string) { return this.documentElement.querySelector(`#${id}`); }
  querySelector(sel: string) { return this.documentElement.querySelector(sel); }
  querySelectorAll(sel: string) { return this.documentElement.querySelectorAll(sel); }
  addEventListener(t: string, fn: Listener) { this.listeners.set(t, [...(this.listeners.get(t) ?? []), fn]); }
  dispatchEvent(e: { type: string }) { for (const fn of this.listeners.get(e.type) ?? []) fn(e); return true; }
  key(key: string, mods: Record<string, boolean> = {}, target: any = this.body) {
    let prevented = false;
    for (const fn of this.listeners.get('keydown') ?? []) fn({ key, target, ...mods, preventDefault() { prevented = true; } });
    return prevented;
  }
}

/** el(tag, { class, id, dataset, … }, children): build markup for a page fixture */
export function make(doc: FakeDocument, tag: string, attrs: Record<string, string> = {}, ...kids: (FakeNode | string)[]) {
  const e = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.append(...kids);
  return e;
}

/** A window for mountShell: a width for matchMedia, storage, history, no Navigation API */
export function fakeWindow(width: number, storage: Map<string, string> = new Map(), session: Map<string, string> = new Map()) {
  const mq = (q: string) => {
    const max = Number(q.match(/max-width: ([\d.]+)px/)?.[1] ?? Infinity);
    return { matches: width <= max, addEventListener() {} };
  };
  const calls: string[] = [];
  const listeners = new Map<string, ((e: any) => void)[]>();
  return {
    calls,
    innerWidth: width,
    /** fire('resize') after changing innerWidth: what a window resize does */
    fire(type: string) { for (const fn of listeners.get(type) ?? []) fn({ type }); },
    location: { pathname: '/', search: '', hash: '' },
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, v); } },
    sessionStorage: { getItem: (k: string) => session.get(k) ?? null, setItem: (k: string, v: string) => { session.set(k, v); } },
    matchMedia: mq,
    history: { back: () => calls.push('back'), forward: () => calls.push('forward') },
    setTimeout: (fn: () => void) => { fn(); return 0; },
    addEventListener(t: string, fn: (e: any) => void) { listeners.set(t, [...(listeners.get(t) ?? []), fn]); },
    CustomEvent: class { type: string; constructor(type: string) { this.type = type; } },
  };
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style']);
const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' };
const decode = (s: string) => s.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_m, e) => ENT[e]);

/**
 * Parse a served page into doc: <html>/<body> attributes, then the body's tree (comments dropped, script and style
 * kept as elements with their text). Enough for the pages in public/ as the server sends them, not general HTML.
 */
export function loadPage(doc: FakeDocument, html: string) {
  const bodyAt = html.search(/<body\b/);
  const head = html.slice(0, bodyAt);
  for (const [, k, v] of (head.match(/<html\b([^>]*)>/)?.[1] ?? '').matchAll(/([\w-]+)(?:="([^"]*)")?/g)) doc.documentElement.setAttribute(k, v ?? '');
  const src = html.slice(bodyAt);
  const stack: FakeElement[] = [];
  let i = 0;
  while (i < src.length) {
    if (src.startsWith('<!--', i)) { i = src.indexOf('-->', i) + 3; continue; }
    if (src[i] === '<' && src[i + 1] === '/') {
      const end = src.indexOf('>', i);
      const name = src.slice(i + 2, end).trim().toLowerCase();
      while (stack.length && stack.at(-1)!.tagName.toLowerCase() !== name) stack.pop();
      stack.pop();
      i = end + 1;
      continue;
    }
    if (src[i] === '<' && /[a-zA-Z]/.test(src[i + 1])) {
      const m = src.slice(i).match(/^<([a-zA-Z][\w-]*)((?:\s+[\w:-]+(?:="[^"]*"|='[^']*'|=[^\s>]+)?)*)\s*(\/?)>/);
      if (!m) throw new Error(`fake DOM: can't parse tag at ${src.slice(i, i + 40)}`);
      const name = m[1].toLowerCase();
      const isBody = name === 'body';
      const e = isBody ? doc.body : doc.createElement(name);
      for (const [, k, v1, v2, v3] of m[2].matchAll(/([\w:-]+)(?:="([^"]*)"|='([^']*)'|=([^\s>]+))?/g)) e.setAttribute(k, decode(v1 ?? v2 ?? v3 ?? ''));
      if (!isBody) (stack.at(-1) ?? doc.body).append(e);
      i += m[0].length;
      if (RAW.has(name)) {
        const end = src.indexOf(`</${name}>`, i);
        e.append(src.slice(i, end));
        i = end + name.length + 3;
      } else if (!VOID.has(name) && !m[3]) stack.push(e);
      continue;
    }
    const next = src.indexOf('<', i + 1);
    const text = src.slice(i, next < 0 ? undefined : next);
    if (text.trim()) (stack.at(-1) ?? doc.body).append(decode(text));
    i = next < 0 ? src.length : next;
  }
  // inputs' checked/value and buttons' disabled follow their attributes, as in a browser
  for (const e of doc.body.descendants()) {
    if (e.hasAttribute('value')) e.value = e.getAttribute('value')!;
    if (e.hasAttribute('type')) e.type = e.getAttribute('type')!;
    if (e.hasAttribute('disabled')) e.disabled = true;
  }
  return doc;
}

/** Run lib/shell-boot.js (a classic script) against this document and window, as the inlined <script> does */
export function runBoot(src: string, doc: FakeDocument, win: any, userAgent = 'node') {
  new Function('window', 'document', 'navigator', src)(win, doc, { userAgent });
  return win.PortboardBoot;
}
