// @ts-check
// "Claude로 열기" on a service page: a claude://code/new link that opens Claude Code Desktop on a new SSH session to
// this server, in the service's project folder, with a prompt about the port filled in (sent only when the user
// presses Enter). Claude Code's docs suggest exactly this kind of link for dashboards and runbooks.
//
//   claude://code/new?ssh_host=<user>@<host>&ssh_folder=<~/projects/…>&q=<prompt>
//
// The SSH target comes from the row's own `ssh -N -L … user@host` command, the folder from the process's working
// directory. Only for a process inside a project folder (Portboard's `project`): a system service's cwd (/, ~) is no
// place to start a coding session.

const TARGET = /^[A-Za-z0-9._][A-Za-z0-9._-]*@[A-Za-z0-9._:-]+$/;
const FOLDER = /^(~|~\/[^\0\n]*|\/[^\0\n]*)$/;

/** The SSH target of `ssh -N -L p:127.0.0.1:p user@host`, or null
 * @param {unknown} ssh
 * @returns {string | null} */
export function sshTarget(ssh) {
  const last = typeof ssh === 'string' ? ssh.trim().split(/\s+/).pop() : '';
  return last && TARGET.test(last) && !last.startsWith('-') ? last : null;
}

/** The deep link for one service entry, or null when there is no SSH target or project folder.
 * @param {{ urls?: { ssh?: string }, processes?: { project: string | null, cwd: string | null }[] } | null | undefined} entry
 * @param {string} [prompt]
 * @returns {string | null} */
export function claudeLink(entry, prompt) {
  const cwd = entry?.processes?.find((p) => p.project && p.cwd)?.cwd;
  const target = sshTarget(entry?.urls?.ssh);
  if (!cwd || !target || !FOLDER.test(cwd) || cwd.length > 1024) return null;
  const q = new URLSearchParams({ ssh_host: target, ssh_folder: cwd });
  if (prompt) q.set('q', String(prompt).slice(0, 500));
  return `claude://code/new?${q.toString().replace(/\+/g, '%20')}`;
}
