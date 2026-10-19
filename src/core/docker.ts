// Map host ports published by Docker to container names (docker-proxy runs as root, so ss can't see it).

import { run } from './exec.ts';

export async function dockerPorts(): Promise<Map<number, string>> {
  return (await dockerPs()).ports;
}

/** Host port → container, and container → docker compose project (for grouping supabase_* and friends). */
export async function dockerPs(): Promise<{ ports: Map<number, string>; projects: Map<string, string> }> {
  const r = await run('docker', ['ps', '--format', '{{.Names}}\t{{.Ports}}\t{{.Label "com.docker.compose.project"}}'], 5_000);
  return r.ok ? { ports: parseDockerPs(r.stdout), projects: parseComposeProjects(r.stdout) } : { ports: new Map(), projects: new Map() };
}

/** Third column of the `docker ps` format above; empty for containers not started by compose. */
export function parseComposeProjects(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split('\n')) {
    const [name, , project = ''] = line.split('\t');
    if (name && project.trim()) map.set(name, project.trim());
  }
  return map;
}

export function parseDockerPs(text: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const line of text.split('\n')) {
    const [name, ports = ''] = line.split('\t');
    if (!name) continue;
    // "0.0.0.0:54321->8000/tcp" or ranges "0.0.0.0:8000-8001->8000-8001/tcp"
    for (const m of ports.matchAll(/:(\d+)(?:-(\d+))?->/g)) {
      const from = Number(m[1]);
      const to = m[2] ? Number(m[2]) : from;
      for (let p = from; p <= to; p++) map.set(p, name);
    }
  }
  return map;
}
