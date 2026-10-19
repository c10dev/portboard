// `npm run test:en`: the test suite with PORTBOARD_LOCALE=en, so the English text the server writes is checked by
// more than test/i18n.test.ts (#6). `npm test` runs everything in Korean, the project's first language.
//
// Tests that check wording pick the expected text with test/fixtures/locale.ts (L(ko, en)). The files below assert
// Korean wording throughout (digests, the setup checklist, access-denied reasons, the UI's own strings, MCP prompts):
// they stay ko-only and run under `npm test`, nothing is skipped there. A file is listed here only because of its
// wording; move it out once its assertions use L().
//
//   node scripts/test-en.ts            every test file but KO_ONLY, in English
//   node scripts/test-en.ts --list     print the files it would run

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const KO_ONLY = [
  'access',
  'claude',
  'digest',
  'mcp-resources',
  'memory',
  'nettree',
  'newports',
  'onboarding',
  'remote-health',
  'security-access',
  'security-misc',
  'settings',
  'suggest',
  'ui-keys',
  'ui-lib',
  'ui-nettree',
  'ui-palette',
  'ui-portrules',
  'ui-shell',
  'ui-toast',
  'usage',
  'worktrees-scan',
].map((n) => `${n}.test.ts`);

const TEST_DIR = fileURLToPath(new URL('../test/', import.meta.url));

/** Test files to run in English; throws when KO_ONLY names a file that no longer exists (a stale list). */
export function englishFiles(all = readdirSync(TEST_DIR)): string[] {
  const tests = all.filter((f) => f.endsWith('.test.ts')).sort();
  const stale = KO_ONLY.filter((f) => !tests.includes(f));
  if (stale.length) throw new Error(`scripts/test-en.ts: KO_ONLY names missing files: ${stale.join(', ')}`);
  return tests.filter((f) => !KO_ONLY.includes(f));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = englishFiles().map((f) => `test/${f}`);
  if (process.argv.includes('--list')) {
    console.log(files.join('\n'));
  } else {
    const r = spawnSync(process.execPath, ['--test', ...files], {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      stdio: 'inherit',
      env: { ...process.env, PORTBOARD_LOCALE: 'en' },
    });
    process.exit(r.status ?? 1);
  }
}
