// Parse `ss -ltnpH` output into listening sockets.

export type BindScope = 'all' | 'loopback' | 'tailnet' | 'other';

export interface Listener {
  address: string;
  port: number;
  scope: BindScope;
  processes: { name: string; pid: number }[];
}

const LINE = /^\S+\s+\d+\s+\d+\s+(\S+)\s+\S+\s*(.*)$/;
const USER = /\("((?:[^"\\]|\\.)*)",pid=(\d+),fd=\d+\)/g;

export function parseSs(text: string): Listener[] {
  const out: Listener[] = [];
  for (const line of text.split('\n')) {
    const m = LINE.exec(line.trim());
    if (!m) continue;
    const local = m[1];
    const idx = local.lastIndexOf(':');
    if (idx < 0) continue;
    const port = Number(local.slice(idx + 1));
    if (!Number.isInteger(port)) continue;
    const address = local.slice(0, idx).replace(/%[^\]]*$/, '').replace(/^\[|\]$/g, '');
    const processes = [...m[2].matchAll(USER)].map((u) => ({ name: u[1], pid: Number(u[2]) }));
    out.push({ address, port, scope: classify(address), processes });
  }
  return out;
}

export function classify(address: string): BindScope {
  if (address === '0.0.0.0' || address === '::' || address === '*') return 'all';
  if (address.startsWith('127.') || address === '::1') return 'loopback';
  if (address.toLowerCase().startsWith('fd7a:115c:a1e0:')) return 'tailnet';
  const p = address.split('.').map(Number);
  // Tailscale CGNAT range 100.64.0.0/10
  if (p.length === 4 && p[0] === 100 && p[1] >= 64 && p[1] <= 127) return 'tailnet';
  return 'other';
}
