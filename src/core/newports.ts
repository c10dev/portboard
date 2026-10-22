// New dev-server notices (REA proposal #5, after VS Code's onAutoForward): when a port starts listening, its onNew
// (src/core/portrules.ts: the port's own entry, the port rules, otherPorts, else `notify` for a well-known dev server
// and `silent` for the rest) decides what happens:
//
//   notify            an event for the open dashboard (a toast with 열기 · tailnet 공개) and one ntfy/webhook message
//                     through the down-alert channel (src/core/alerts.ts) with the same two actions
//   openBrowserOnce   an event only: the dashboard toasts it with 열기, the Mac app may open it once
//   silent / ignore   nothing (ignore also hides the port)
//
// Not new: anything listening at Portboard's first look after it starts (so its own restarts never notify), its own
// ports (portboard*.service, this process), ports in a quiet window (quiet.json: Portboard just restarted or stopped
// them), and a port + command already noticed within DEBOUNCE_MS (a dev server restarting on file changes).
// A look whose snapshot has no listening port at all (`ss` failed) changes nothing.
//
// Events live in memory (the last MAX_EVENTS, at most KEEP_MS old). Ids grow by one per event and start at the
// server's start time in ms, so they keep growing across restarts and a client's `since` stays meaningful:
//
//   GET /api/new-ports            → { latest, events: [] }       (the cursor to start from)
//   GET /api/new-ports?since=<id> → { latest, events: [...] }    (events with id > since, oldest first)
//
// Event shape (docs/api.md#new-ports; the Mac app reads it):
//   { id, at, port, name, action: 'notify' | 'openBrowserOnce', command, project, rule, open, canExpose }

import type { Message, NtfyAction } from './alerts.ts';
import type { OnNew } from './prefs.ts';
import { t } from './i18n.ts';
import { isPortboardProcess } from './selfunit.ts';

export const DEBOUNCE_MS = 10 * 60_000;
export const MAX_EVENTS = 50;
export const KEEP_MS = 60 * 60_000;
/** How often the server looks (src/features/newports.ts) */
export const LOOK_MS = 15_000;

/** The slice of a snapshot port entry the tracker needs */
export interface NewPortView {
  port: number;
  listening: boolean;
  name: string;
  onNew: OnNew;
  rules: { from: { onNew: string } };
  processes: { pid: number; cmdline: string; project: string | null; unit: string | null }[];
  container: string | null;
  urls: { direct: string | null; served: string | null };
  canExpose: boolean;
}

export type NoticeAction = Extract<OnNew, 'notify' | 'openBrowserOnce'>;

export interface NewPortEvent {
  /** Grows by one per event; starts at the server's start time (ms) */
  id: number;
  at: string;
  port: number;
  name: string;
  action: NoticeAction;
  /** The owning process's command line (cut at 300 characters), or `docker: <container>` */
  command: string | null;
  project: string | null;
  /** Where onNew came from: `port`, `rule:<key>`, `otherPorts` or `default` */
  rule: string;
  /** A URL a tailnet device can open (tailscale serve, else http on a tailnet/all bind); null when loopback only */
  open: string | null;
  /** tailscale serve can publish it (POST /api/ports/:port/expose) */
  canExpose: boolean;
}

export interface NewPortsFeed {
  latest: number;
  events: NewPortEvent[];
}

export function isSelf(p: Pick<NewPortView, 'processes'>, selfPid = process.pid): boolean {
  return isPortboardProcess(p.processes, selfPid);
}

export function commandOf(p: Pick<NewPortView, 'processes' | 'container'>): string | null {
  const cmd = p.processes.find((x) => x.cmdline)?.cmdline.replace(/\s+/g, ' ').trim();
  return cmd || (p.container ? `docker: ${p.container}` : null);
}

export const openUrlOf = (p: Pick<NewPortView, 'urls'>): string | null => p.urls.served ?? (p.urls.direct?.startsWith('http') ? p.urls.direct : null);

export interface TrackerOptions {
  now?: () => number;
  debounceMs?: number;
  selfPid?: number;
}

export function createNewPorts(opts: TrackerOptions = {}) {
  const now = opts.now ?? Date.now;
  const debounceMs = opts.debounceMs ?? DEBOUNCE_MS;
  let seen: Set<number> | null = null;
  let nextId = now();
  /** `${port} ${command}` → when it was last noticed (ms) */
  const noticed = new Map<string, number>();
  let events: NewPortEvent[] = [];

  return {
    /**
     * One look at the ports. Returns the events it added (notify and openBrowserOnce only).
     * quiet: quiet.json (port → until ms), ports Portboard itself just restarted or stopped.
     */
    observe(ports: NewPortView[], quiet: Record<string, number> = {}): NewPortEvent[] {
      const t = now();
      const listening = ports.filter((p) => p.listening);
      if (!listening.length) return []; // `ss` failed: Portboard itself always listens
      const before = seen;
      seen = new Set(listening.map((p) => p.port));
      if (!before) return []; // the first look seeds
      for (const [k, at] of noticed) if (t - at >= debounceMs) noticed.delete(k);
      const added: NewPortEvent[] = [];
      for (const p of listening) {
        if (before.has(p.port) || isSelf(p, opts.selfPid)) continue;
        if ((quiet[p.port] ?? 0) > t) continue;
        if (p.onNew !== 'notify' && p.onNew !== 'openBrowserOnce') continue;
        const command = commandOf(p);
        const key = `${p.port} ${command ?? ''}`;
        if (noticed.has(key)) continue;
        noticed.set(key, t);
        added.push({
          id: nextId++,
          at: new Date(t).toISOString(),
          port: p.port,
          name: p.name,
          action: p.onNew,
          command: command && command.length > 300 ? `${command.slice(0, 300)}…` : command,
          project: p.processes.find((x) => x.project)?.project ?? null,
          rule: p.rules.from.onNew,
          open: openUrlOf(p),
          canExpose: p.canExpose,
        });
      }
      events = [...events, ...added].filter((e) => t - Date.parse(e.at) < KEEP_MS).slice(-MAX_EVENTS);
      return added;
    },

    /** Events after `since` (an id); without it, only the cursor to start from */
    feed(since?: number): NewPortsFeed {
      const latest = events.length ? events[events.length - 1].id : nextId - 1;
      return { latest, events: since === undefined ? [] : events.filter((e) => e.id > since) };
    },
  };
}

export type NewPorts = ReturnType<typeof createNewPorts>;

/**
 * The ntfy/webhook message for the `notify` events of one look: one message, with 열기 (when a tailnet URL exists)
 * and tailnet 공개 (an HTTP action posting to the dashboard, when the port can be published) for a single port.
 * Names, ports and projects only; never a command line or an address.
 */
export function newPortText(list: NewPortEvent[], dashboard: string | null): Message {
  const base = dashboard?.replace(/\/+$/, '') ?? null;
  const one = list.length === 1 ? list[0] : null;
  const title = one ? t('newportsMsg.title.one', { port: one.port, name: one.name }) : t('newportsMsg.title.many', { n: list.length });
  const lines = list.slice(0, 8).map((e) => `:${e.port} ${e.name}${e.project ? ` (${e.project})` : ''}`);
  if (list.length > 8) lines.push(t('newportsMsg.more', { n: list.length - 8 }));
  const actions: NtfyAction[] = [];
  if (one?.open) actions.push({ action: 'view', label: t('newportsMsg.open'), url: one.open });
  if (one && !one.open && one.canExpose && base) {
    actions.push({ action: 'http', label: t('newportsMsg.expose'), url: `${base}/api/ports/${one.port}/expose`, method: 'POST', headers: { 'X-Portboard': '1' }, clear: true });
  }
  const click = base ? `${base}/${one ? `#${one.port}` : ''}` : undefined;
  return { key: one ? `new-port:${one.port}` : 'new-port', kind: 'new-port', title, body: lines.join('\n'), high: false, ...(click ? { click } : {}), ...(actions.length ? { actions } : {}) };
}
