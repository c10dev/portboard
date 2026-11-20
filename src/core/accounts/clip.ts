// Accounts (docs/accounts.md): text that comes from outside (a login file or a usage answer) is cut before it is kept.

export const NAME_MAX = 40;
export const PLAN_MAX = 40;
export const EMAIL_MAX = 254;

/** Control characters out, cut at `max` with an ellipsis */
export function clip(v: string, max: number): string {
  const clean = v.replace(/[\u0000-\u001f\u007f]/g, '');
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/** clip for a value that may be missing: null when it is not a string or nothing is left */
export function clipOrNull(v: string | null, max: number): string | null {
  if (v === null) return null;
  return clip(v, max) || null;
}
