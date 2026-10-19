// Where the Portboard checkout is: the plugin is installed on its own (a copy under ~/.claude/plugins/cache), but its
// MCP server and the port parser run from the repo. First of:
//   PORTBOARD_HOME                          set it when the checkout lives elsewhere
//   a parent of this plugin folder          the marketplace added from a local checkout, or --plugin-dir claude-plugin
//   ~/projects/portboard                    the usual checkout on the server
// that has src/mcp.ts.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const isCheckout = (dir: string) => {
  if (!existsSync(join(dir, 'src', 'mcp.ts'))) return false;
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name === 'portboard';
  } catch {
    return false;
  }
};

export function portboardHome(env: Record<string, string | undefined> = process.env, from: string = import.meta.dirname): string | null {
  if (env.PORTBOARD_HOME) return isCheckout(env.PORTBOARD_HOME) ? env.PORTBOARD_HOME : null;
  for (let dir = from, i = 0; i < 6; i++, dir = dirname(dir)) {
    if (isCheckout(dir)) return dir;
    if (dirname(dir) === dir) break;
  }
  const fallback = join(homedir(), 'projects', 'portboard');
  return isCheckout(fallback) ? fallback : null;
}
