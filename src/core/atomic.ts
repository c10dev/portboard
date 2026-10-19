// Private, atomic state writes (security review v1.0, L6). Every config/state file Portboard writes goes through
// here: the directory is created 0700, the file 0600, and a whole-file write lands through a temp file with an
// unpredictable name opened with O_EXCL ('wx'), so a planted file or symlink at a guessable temp path is never
// followed, then renamed over the target. The same pattern as remote.json (src/remote/store.ts).

import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** `path.<12 hex>.tmp`: a fresh random name per write */
export const tempName = (path: string): string => `${path}.${randomBytes(6).toString('hex')}.tmp`;

/**
 * Replace `path` with `data` (0600), atomically. `data` may be a function, called once the directory exists, for a
 * store whose in-memory state can still change while the write starts.
 */
export async function writePrivate(path: string, data: string | (() => string)): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = tempName(path);
  await writeFile(tmp, typeof data === 'function' ? data() : data, { mode: 0o600, flag: 'wx' });
  try {
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

/** Append one line to a log; a new file is created 0600. */
export async function appendPrivate(path: string, line: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await appendFile(path, line, { mode: 0o600 });
}
