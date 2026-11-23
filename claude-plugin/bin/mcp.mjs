// @ts-check
// The plugin's stdio MCP server, run in this process so stdin/stdout stay the JSON-RPC channel. Nothing may be
// written to stdout here. Two modes, both from the Portboard checkout:
//   thin   the dashboard daemon answers (src/mcp/thin.mjs): this process stays small and loads no feature module.
//   local  Portboard's own src/mcp.ts runs here, as before.
// Thin is chosen when GET <PORTBOARD_URL>/api/mcp/ping answers 200 { ok: true } within 300 ms. Anything else (no
// daemon, a slow one, 403 for token mode or a read-only install, 404 from an older daemon) chooses local.
// PORTBOARD_MCP_MODE=local skips the question.
//
// Plain JavaScript on purpose (see src/mcp/thin.mjs): no TypeScript file is loaded in thin mode, so Node never loads
// its type stripper. That is why the checkout lookup of hooks/home.ts is repeated here instead of imported.

import { existsSync, readFileSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_URL = 'http://127.0.0.1:8790';
const PING_TIMEOUT_MS = 300;

/**
 * The version of a Portboard checkout (its package.json), or null when `dir` is not one.
 * @param {string} dir
 * @returns {string | null}
 */
function checkoutVersion(dir) {
  if (!existsSync(join(dir, 'src', 'mcp.ts'))) return null;
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    return pkg.name === 'portboard' || pkg.name === '@c10dev/portboard' ? String(pkg.version) : null;
  } catch {
    return null;
  }
}

/**
 * Where the Portboard checkout is, as in claude-plugin/hooks/home.ts: PORTBOARD_HOME, a parent of this plugin folder,
 * then ~/projects/portboard.
 * @returns {string | null}
 */
function portboardHome() {
  const env = process.env.PORTBOARD_HOME;
  if (env) return checkoutVersion(env) === null ? null : env;
  for (let dir = import.meta.dirname, i = 0; i < 6; i++, dir = dirname(dir)) {
    if (checkoutVersion(dir) !== null) return dir;
    if (dirname(dir) === dir) break;
  }
  const fallback = join(homedir(), 'projects', 'portboard');
  return checkoutVersion(fallback) === null ? null : fallback;
}

const home = portboardHome();
if (!home) {
  process.stderr.write('portboard plugin: Portboard checkout not found (set PORTBOARD_HOME to the repo that has src/mcp.ts)\n');
  process.exit(1);
}

/**
 * The daemon's answer to the ping, or null for anything but 200 { ok: true } within 300 ms. node:http, not fetch: fetch
 * loads undici, about 13 MB of resident memory that the thin client exists to save.
 * @returns {Promise<{ version?: unknown } | null>}
 */
async function ping() {
  const base = (process.env.PORTBOARD_URL || DEFAULT_URL).replace(/\/+$/, '');
  const get = base.startsWith('https:') ? (await import('node:https')).get : httpGet;
  return new Promise((resolve) => {
    let done = false;
    /** @type {import('node:http').ClientRequest | undefined} */
    let req;
    /** @param {{ version?: unknown } | null} v */
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req?.destroy();
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), PING_TIMEOUT_MS);
    try {
      req = get(`${base}/api/mcp/ping`, { agent: false }, (res) => {
        if (res.statusCode !== 200) return finish(null);
        /** @type {Buffer[]} */
        const chunks = [];
        let size = 0;
        res.on('data', (/** @type {Buffer} */ c) => {
          size += c.length;
          if (size <= 4096) chunks.push(c);
        });
        res.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            finish(body?.ok === true ? body : null);
          } catch {
            finish(null);
          }
        });
        res.on('error', () => finish(null));
      });
      req.on('error', () => finish(null));
    } catch {
      finish(null);
    }
  });
}

/** @type {'thin' | 'local'} */
let mode = 'local';
if (process.env.PORTBOARD_MCP_MODE !== 'local') {
  const answer = await ping();
  if (answer) {
    mode = 'thin';
    // A daemon that was not deployed with this checkout has its own tool list; say so, and still use it.
    const version = checkoutVersion(home);
    if (answer.version !== version) {
      process.stderr.write(`portboard plugin: the dashboard runs version ${String(answer.version).slice(0, 40)}, this checkout is ${version}; the tool list is the dashboard's\n`);
    }
  }
}
const localEntry = pathToFileURL(join(home, 'src', 'mcp.ts')).href;
if (mode === 'thin') {
  // A checkout without src/mcp/thin.mjs (an older one) or one that fails to load it: local mode, not a dead server.
  const thin = join(home, 'src', 'mcp', 'thin.mjs');
  try {
    if (!existsSync(thin)) throw new Error('not found');
    await import(pathToFileURL(thin).href);
  } catch (err) {
    process.stderr.write(`portboard plugin: cannot start ${thin} (${err instanceof Error ? err.message : String(err)}); running the server in this process\n`);
    await import(localEntry);
  }
} else await import(localEntry);
