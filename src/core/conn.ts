// Parse `ss -tnpiH state established` into connections.
// That mode drops the State column, so rows are `Recv-Q Send-Q Local Peer [users]`,
// each followed by an indented TCP-info line (bytes_sent, bytes_received, rtt…).

export interface Endpoint {
  address: string;
  port: number;
}

export interface Connection {
  local: Endpoint;
  peer: Endpoint;
  processes: { name: string; pid: number }[];
  /** From this host's side of the socket */
  bytesSent: number | null;
  bytesReceived: number | null;
  rttMs: number | null;
}

const ROW = /^\d+\s+\d+\s+(\S+)\s+(\S+)\s*(.*)$/;
const USER = /\("((?:[^"\\]|\\.)*)",pid=(\d+),fd=\d+\)/g;

export function parseEstablished(text: string): Connection[] {
  const out: Connection[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    if (/^\s/.test(line)) {
      const last = out.at(-1);
      if (!last) continue;
      last.bytesSent = num(/\bbytes_sent:(\d+)/.exec(line)?.[1]) ?? last.bytesSent;
      last.bytesReceived = num(/\bbytes_received:(\d+)/.exec(line)?.[1]) ?? last.bytesReceived;
      last.rttMs = num(/\brtt:([\d.]+)\//.exec(line)?.[1]) ?? last.rttMs;
      continue;
    }
    const m = ROW.exec(line.trim());
    if (!m) continue;
    const local = endpoint(m[1]);
    const peer = endpoint(m[2]);
    if (!local || !peer) continue;
    const processes = [...m[3].matchAll(USER)].map((u) => ({ name: u[1], pid: Number(u[2]) }));
    out.push({ local, peer, processes, bytesSent: null, bytesReceived: null, rttMs: null });
  }
  return out;
}

export function endpoint(s: string): Endpoint | null {
  const idx = s.lastIndexOf(':');
  if (idx < 0) return null;
  const port = Number(s.slice(idx + 1));
  if (!Number.isInteger(port)) return null;
  const address = s
    .slice(0, idx)
    .replace(/%[^\]]*$/, '')
    .replace(/^\[|\]$/g, '')
    .replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, '$1');
  return { address, port };
}

function num(s: string | undefined): number | null {
  return s === undefined ? null : Number(s);
}
