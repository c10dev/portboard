#!/usr/bin/env node
// Scans a tree for what must not be published: patterns from a denylist (real names, addresses, keys), credential
// shapes, private keys and e-mail addresses outside the example domains. Used by scripts/public-tree.sh.
//
//   node scripts/public-scan.mjs <dir> [--denylist FILE]
//
// Prints one line per finding (file:line: rule: excerpt) and exits 1 when there is any. Images can't be read as text:
// they are listed and must sit under an allowed folder (public/, mac-app/Resources/, docs/images/).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const args = process.argv.slice(2);
const dir = args[0];
const denyAt = args.indexOf('--denylist');
const denyFile = denyAt >= 0 ? args[denyAt + 1] : null;
if (!dir) {
  console.error('usage: node scripts/public-scan.mjs <dir> [--denylist FILE]');
  process.exit(2);
}

const deny = denyFile
  ? readFileSync(denyFile, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((p) => ({ rule: `denylist ${p}`, re: new RegExp(p, 'iu') }))
  : [];

const SHAPES = [
  { rule: 'private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { rule: 'GitHub token', re: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}/ },
  { rule: 'API key', re: /\bsk-(ant-)?[A-Za-z0-9_-]{20,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|\bAKIA[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{30,}/ },
  { rule: 'token in a URL', re: /[?&](token|access_token|key|secret|code)=[A-Za-z0-9_-]{24,}/ },
  { rule: 'Proxmox token secret', re: /PVEAPIToken=[^\s"'`]+=[0-9a-f]{8}-[0-9a-f]{4}-/ },
  { rule: 'key fingerprint', re: /\b(SHA256:[A-Za-z0-9+/]{43}|MD5(:[0-9a-f]{2}){16})/ },
  { rule: 'ntfy topic', re: /(?<![\w.])ntfy\.sh\/(?!app\b|docs\b)[A-Za-z0-9_-]{6,}/ },
];
// e-mail addresses are fine only at example domains, GitHub's noreply and git@github.com; systemd's user@<uid>.service
// and the test client p@claude.ai are not addresses of anyone
const EMAIL = /\b[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+\.)+[A-Za-z]{2,}\b/g;
const EMAIL_OK = /@((?:[\w-]+\.)*example\.(com|org|net|ts\.net)|users\.noreply\.github\.com|github\.com|\d+\.service|claude\.ai|t|x|h)$/i;
const PLACEHOLDER = /SECRET|EXAMPLE|FAKE|DUMMY|x{8}|0{8}/i;
const IMAGE = /\.(png|jpe?g|gif|webp|ico|icns|pdf)$/i;
const IMAGE_OK = /^(public\/|mac-app\/Resources\/|docs\/images\/)/;

const findings = [];
const images = [];

function walk(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.isFile()) scan(p);
  }
}

function scan(path) {
  const rel = relative(dir, path);
  if (IMAGE.test(rel)) {
    images.push(rel);
    if (!IMAGE_OK.test(rel)) findings.push(`${rel}: image outside public/, mac-app/Resources/ and docs/images/ (can't be scanned, check it)`);
    return;
  }
  if (statSync(path).size > 5_000_000) {
    findings.push(`${rel}: over 5 MB, not scanned`);
    return;
  }
  const buf = readFileSync(path);
  if (buf.includes(0)) {
    findings.push(`${rel}: binary, not scanned`);
    return;
  }
  // the path itself counts too (fixture folders were named after real projects)
  for (const { rule, re } of deny) if (re.test(rel)) findings.push(`${rel}: path: ${rule}`);
  const lines = buf.toString('utf8').split('\n');
  lines.forEach((line, i) => {
    const at = `${rel}:${i + 1}`;
    for (const { rule, re } of deny) {
      const m = line.match(re);
      if (m) findings.push(`${at}: ${rule}: ${excerpt(line, m.index ?? 0)}`);
    }
    // credential shapes, except test values that say what they are (sk-ant-oat01-SECRETSECRET, …EXAMPLE…)
    for (const { rule, re } of SHAPES) {
      const m = line.match(re);
      if (m && !PLACEHOLDER.test(m[0])) findings.push(`${at}: ${rule}: ${excerpt(line, m.index ?? 0)}`);
    }
    for (const m of line.matchAll(EMAIL)) if (!EMAIL_OK.test(m[0])) findings.push(`${at}: e-mail address: ${m[0]}`);
  });
}

const excerpt = (line, at) => line.slice(Math.max(0, at - 40), at + 60).trim();

walk(dir);
for (const f of findings) console.log(f);
console.error(`public-scan: ${findings.length} finding(s); ${images.length} image(s): ${images.join(', ') || 'none'}${denyFile ? '' : ' (no denylist given: only generic checks ran)'}`);
process.exit(findings.length ? 1 : 0);
