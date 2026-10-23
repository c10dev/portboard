// Port actions (src/features/control.ts, ports.ts expose), shared by the 서비스 rows (app.js) and service.html: what
// controls a port, its open / copy / tailnet 공개 buttons, the restart and stop questions, the POST with its toast,
// and the logs dialog (#logs in both pages). The server decides what restart/stop act on; clients only send a port.

import { errorText, post, readJSON } from '../lib/api.js';
import { $, button, extLink } from '../lib/dom.js';
import { t } from '../lib/i18n.js';
import { copy, toast } from '../lib/toast.js';

/** "systemd: x.service", "docker: name", "프로세스: pid 1, 2" */
export function controlText(c) {
  if (!c) return null;
  if (c.type === 'systemd') return `systemd: ${c.unit}`;
  if (c.type === 'docker') return `docker: ${c.container}`;
  return t('control.process', { pids: c.pids.join(', ') });
}

/** The address 열기 ↗ opens: the tailnet HTTPS one, else a direct http(s) one; null when there is none */
export const openUrlOf = (p) => p.urls.served ?? (p.urls.direct?.startsWith('http') ? p.urls.direct : null);

/** 열기 ↗ (or 주소 복사), tailnet 공개 / 공개 해제, SSH 복사 for a listening port. act(kind) runs expose/unexpose. */
export function reachButtons(p, { busy, act }) {
  const out = [];
  const openUrl = openUrlOf(p);
  if (openUrl) {
    out.push(extLink(t('control.open'), openUrl, 'btn primary'));
  } else if (p.urls.direct) {
    out.push(button(t('control.copyAddress'), () => copy(p.urls.direct.replace(/^tcp:\/\//, ''))));
  }
  if (p.served) {
    if (p.canUnexpose !== false) out.push(button(t('control.unexpose'), () => act('unexpose'), { disabled: busy, write: true }));
  } else if (p.canExpose) out.push(button(t('control.expose'), () => act('expose'), { disabled: busy, write: true, title: `tailscale serve --https=${p.port} → 127.0.0.1:${p.port}` }));
  if (p.listening && p.scope === 'loopback' && !p.served && p.urls.ssh) out.push(button(t('control.copySsh'), () => copy(p.urls.ssh)));
  return out;
}

export const restartQuestion = (p) => `${p.port} ${p.name}\n${t('control.restartQuestion', { what: controlText(p.control) })}`;

export function stopQuestion(p) {
  const what = p.control?.type === 'process' ? t('control.stopQuestion.process') : t('control.stopQuestion.stop');
  return `${p.port} ${p.name}\n${controlText(p.control)}\n${what}`;
}

/**
 * POST /api/ports/:port/<kind> (expose, unexpose, restart, stop) and say how it went in the toast.
 * watched(): whether the port has 🔔, read after the answer (restart/stop from Portboard pause its alerts 2 minutes).
 */
export async function portAction(port, kind, watched) {
  try {
    const r = await post(`/api/ports/${port}/${kind}`);
    const quiet = r.ok && (kind === 'restart' || kind === 'stop') && watched();
    if (r.body.enableUrl) toast(t('control.serveOff'), true, { link: r.body.enableUrl });
    else toast(`${r.body.message ?? errorText(r)}${quiet ? ` · ${t('control.quiet')}` : ''}`, !r.ok);
  } catch (err) {
    toast(err.message, true);
  }
}

/** GET /api/ports/:port/logs: { source, text } for the logs dialog and the inspector's tail; never throws */
export async function fetchLogs(port, lines) {
  try {
    const r = await readJSON(`/api/ports/${port}/logs?lines=${lines}`);
    return { source: r.source ?? '', text: r.lines?.length ? r.lines.join('\n') : (r.message ?? t('control.logs.none')) };
  } catch (err) {
    return { source: '', text: t('services.loadFailed', { error: err.message }) };
  }
}

/** The page's #logs dialog: show({ port, name }) opens it on that port; ↻ and the line count reload it. */
export function logsDialog() {
  const logs = $('logs');
  let port = null;

  async function load() {
    if (port === null) return;
    const body = $('logsBody');
    const r = await fetchLogs(port, $('logsLines').value);
    if (r.source) $('logsSource').textContent = r.source;
    body.textContent = r.text;
    body.scrollTop = body.scrollHeight;
  }

  $('logsRefresh').addEventListener('click', load);
  $('logsLines').addEventListener('change', load);
  $('logsClose').addEventListener('click', () => logs.close());
  logs.addEventListener('close', () => (port = null));

  return {
    get open() { return logs.open; },
    show(p) {
      port = p.port;
      $('logsTitle').textContent = `${p.port} · ${p.name}`;
      $('logsSource').textContent = '';
      $('logsBody').textContent = t('common.loading');
      if (!logs.open) logs.showModal();
      load();
    },
  };
}
