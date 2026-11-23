// `node --import ./record-loads.ts <script>`: appends the URL of every module the process loads to the file named by
// PB_LOADS_FILE, one per line. test/mcp-local.test.ts uses it to show which files a mode loads (the thin client must
// not load src/features/). Sync hooks, so a line is written before the module runs, even if the process exits early.

import { registerHooks } from 'node:module';
import { appendFileSync } from 'node:fs';

const file = process.env.PB_LOADS_FILE;
if (file) {
  registerHooks({
    load(url, context, nextLoad) {
      appendFileSync(file, `${url}\n`);
      return nextLoad(url, context);
    },
  });
}
