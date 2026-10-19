// Sizes and ratios as short text.

/** "0 B", "512 B", "3.4 KB", "12 MB" (1024-based) */
export function bytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? (n / 1024 ** i < 10 ? 1 : 0) : 0)} ${u[i]}`;
}

/** Bytes as "512 MB", "1.5 GB", "12 GB"; null stays null */
export function gib(n) {
  return n == null ? null : n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(n >= 10 * 1024 ** 3 ? 0 : 1)} GB` : `${Math.round(n / 1024 ** 2)} MB`;
}

/** KiB as "300MB", "1.2GB"; '' for unknown (개발 tab sizes) */
export function kib(kb) {
  return kb == null ? '' : kb >= 1024 * 1024 ? `${(kb / 1024 / 1024).toFixed(1)}GB` : `${Math.round(kb / 1024)}MB`;
}

/** a of b as "42%", or null without both */
export function pct(a, b) {
  return a != null && b ? `${Math.round((a / b) * 100)}%` : null;
}
