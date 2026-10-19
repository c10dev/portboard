// The plugin's stdio MCP server: Portboard's own src/mcp.ts from the checkout (hooks/home.ts), run in this process so
// stdin/stdout stay the JSON-RPC channel. Nothing may be written to stdout here.

import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { portboardHome } from '../hooks/home.ts';

const home = portboardHome();
if (!home) {
  process.stderr.write('portboard plugin: Portboard checkout not found (set PORTBOARD_HOME to the repo that has src/mcp.ts)\n');
  process.exit(1);
}
await import(pathToFileURL(join(home, 'src', 'mcp.ts')).href);
