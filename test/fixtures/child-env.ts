// The environment for a child process that a test spawns (AGENTS.md, "Tests and evidence"): not the parent's, so the
// child never reads or writes the real config and state dirs, and no PORTBOARD_* path override (src/core/paths.ts)
// leaks in. HOME is a new temp dir. PATH and PORTBOARD_LOCALE (the suite's language, fixtures/locale.ts) are kept.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A clean env with HOME in a new temp dir; done() removes the dir. */
export async function childEnv(): Promise<{ env: Record<string, string>; done: () => Promise<void> }> {
  const home = await mkdtemp(join(tmpdir(), 'pb-child-home-'));
  const env: Record<string, string> = { HOME: home, PATH: process.env.PATH ?? '' };
  if (process.env.PORTBOARD_LOCALE !== undefined) env.PORTBOARD_LOCALE = process.env.PORTBOARD_LOCALE;
  return { env, done: () => rm(home, { recursive: true, force: true }) };
}
