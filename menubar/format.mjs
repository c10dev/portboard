// Pure formatting for the macOS menu bar (SwiftBar). Input: the JSON of GET /api/ports, /api/usage and /api/devices.
// Output: SwiftBar lines. No I/O here; portboard.30s.mjs fetches and prints. Every field is read defensively:
// older or newer servers may lack fields or add new ones.

// A placeholder: mac-menubar-setup.sh writes your server's address here when it installs the plugin, and
// PORTBOARD_URL (SwiftBar's plugin environment) overrides it.
export const DEFAULT_BASE = "https://portboard.example.ts.net:8443";

const RED = "#FF3B30";
const GRAY = "#8E8E93";
const MAX_TEXT = 110;
const MAX_NAME = 42;
const MAX_ROWS = 25; // per section, so the menu stays on screen

// Same table as public/devices.js (POOL_STATE): label and tone. Only tone "bad" (and degraded) raises ⚠ in the title.
// agent-busy means the Mac is being used, which is normal, so it never warns.
export const POOL_STATE = {
  ok: ["정상", "ok"],
  degraded: ["일부 문제", "warn"],
  "wsl-down": ["WSL 꺼짐", "bad"],
  "host-down": ["응답 없음", "bad"],
  auth: ["SSH 인증 실패", "bad"],
  "agent-away": ["에이전트 끊김", "off"],
  "agent-busy": ["사용 중", "warn"],
  unknown: ["상태 모름", "off"],
};
const POOL_WARN = new Set(["degraded", "wsl-down", "host-down", "auth"]);
const DOT = { ok: "🟢", warn: "🟡", bad: "🔴", off: "⚪" };

// One SwiftBar line is `text | key=value …`. `|` in the text would start the parameters, so it becomes `¦`;
// newlines become spaces; a leading `-` would read as a submenu marker, so it becomes an en dash. Long text is cut.
export function esc(text) {
  let t = String(text ?? "").replace(/\s+/g, " ").trim().replace(/\|/g, "¦");
  if (t.length > MAX_TEXT) t = `${t.slice(0, MAX_TEXT - 1)}…`;
  return t.replace(/^-/, "–");
}

// Parameter values cannot hold spaces or `|`.
const val = (v) => String(v).replace(/\s/g, "%20").replace(/\|/g, "%7C");

// depth 1 = submenu (`--`), 2 = sub-submenu (`----`). esc() runs before the prefix so the marker survives.
export function line(text, params = {}, depth = 0) {
  const p = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => `${k}=${val(v)}`).join(" ");
  return `${"--".repeat(depth)}${esc(text)}${p ? ` | ${p}` : ""}`;
}

export const hrefOf = (base, path = "") => `${String(base).replace(/\/+$/, "")}/${String(path).replace(/^\/+/, "")}`;
// Only http(s) URLs are clickable; tcp:// (SSH, Syncthing sync) would do nothing in a browser.
const webUrl = (u) => (typeof u === "string" && /^https?:\/\//.test(u) ? u : undefined);
const shortName = (s) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > MAX_NAME ? `${t.slice(0, MAX_NAME - 1)}…` : t;
};
const arr = (v) => (Array.isArray(v) ? v : []);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

export const portsOf = (doc) => arr(doc?.ports).filter((p) => p && Number.isInteger(p.port));
const portUrl = (p) => webUrl(p?.urls?.served) ?? webUrl(p?.urls?.direct);
const portName = (p) => shortName(p?.label || p?.name || p?.detectedName || `:${p?.port}`);

// Services in use: ports shown in the dashboard's default view (`visible`: pinned, or an app that is not hidden)
// that someone is connected to right now (usage.byPort). System ports (SSH) and ephemeral ports are left out of the
// count, like the dashboard's default list.
export function inUse({ ports, usage }) {
  const byPort = usage?.byPort && typeof usage.byPort === "object" ? usage.byPort : {};
  // usage has the short service name ("Syncthing"); the port's name is often a long page title. A label wins.
  const service = new Map([...arr(usage?.cards).flatMap((c) => arr(c?.uses)), ...arr(usage?.local?.uses)].filter((u) => u?.service).map((u) => [u.port, u.service]));
  return portsOf(ports)
    .filter((p) => p.visible !== false && p.listening !== false)
    .map((p) => {
      const users = arr(byPort[p.port]).filter((u) => u && (num(u.connections) ?? 0) > 0);
      const name = p.label ? portName(p) : shortName(service.get(p.port) ?? portName(p));
      return { port: p.port, name, url: portUrl(p), users, connections: users.reduce((a, u) => a + u.connections, 0) };
    })
    .filter((s) => s.users.length);
}

export const poolWarns = (pool) => !!pool && POOL_WARN.has(pool.state);
export const poolLabel = (pool) => POOL_STATE[pool?.state]?.[0] ?? String(pool?.state ?? "상태 모름");

// Pinned ports: what the API returns with pinned=true. A pinned port that stopped listening only shows up when the
// server lists it (today: a tailscale serve entry with nothing behind it), so the menu cannot see every stopped pin.
export const pinnedOf = (ports) => portsOf(ports).filter((p) => p.pinned);

// Device cards: /api/usage cards (with uses[]) when available, else /api/devices (no uses).
export function cardsOf({ usage, devices }) {
  if (Array.isArray(usage?.cards)) return usage.cards.filter((c) => c && (c.id || c.name));
  return arr(devices?.devices).filter((d) => d && (d.id || d.name)).map((d) => ({ ...d, kind: d.self ? "self" : "tailnet", uses: [] }));
}

// Problems for the title ⚠: compute-pool hosts in a bad state, pinned ports not listening, endpoints that failed.
export function warningsOf({ ports, usage, devices, errors = {} }) {
  const out = [];
  for (const c of cardsOf({ usage, devices })) {
    if (!poolWarns(c.pool)) continue;
    const who = c.pool.name && c.pool.name !== (c.name ?? c.id) ? `${c.name ?? c.id} (pool ${c.pool.name})` : (c.name ?? c.id);
    out.push({ text: `compute-pool ${who}: ${poolLabel(c.pool)}`, path: `devices.html#${encodeURIComponent(c.id ?? c.name)}` });
  }
  for (const p of pinnedOf(ports)) if (p.listening === false) out.push({ text: `고정한 포트 :${p.port} ${portName(p)} 리스닝 없음`, path: "" });
  for (const [what, err] of Object.entries(errors)) if (err) out.push({ text: `/api/${what} 읽기 실패: ${err}`, path: "" });
  return out;
}

export function titleOf({ ports, usage, devices, errors = {} }) {
  const n = usage && !errors.usage ? inUse({ ports, usage }).length : "?";
  const warn = warningsOf({ ports, usage, devices, errors }).length > 0;
  return line(`⇄ ${n}${warn ? " ⚠" : ""}`, warn ? { color: RED } : {});
}

function cpuMem(pool) {
  const bits = [];
  const cpu = num(pool?.cpuPct);
  const load = num(pool?.load1);
  const cores = num(pool?.cores);
  if (cpu !== null) bits.push(`CPU ${Math.round(cpu)}%`);
  else if (load !== null && cores) bits.push(`load ${load.toFixed(1)}/${cores}`);
  const total = num(pool?.memTotalMb);
  const avail = num(pool?.memAvailMb);
  if (total && avail !== null) bits.push(`메모리 ${Math.round((1 - avail / total) * 100)}%`);
  return bits;
}

export function deviceTone(c) {
  if (c?.pool) return POOL_STATE[c.pool.state]?.[1] ?? "off";
  return c?.online ? "ok" : "off";
}

// One device: `🟢 name · status [· CPU · 메모리] [· 서비스 n]`, with a submenu of what it is using.
export function deviceLines(c, base) {
  const uses = arr(c.uses).filter((u) => u && Number.isInteger(u.port));
  const bits = [c.kind === "self" || c.self ? `${c.name ?? c.id} (이 서버)` : (c.name ?? c.id)];
  bits.push(c.pool ? `pool ${poolLabel(c.pool)}` : c.online ? "온라인" : "오프라인");
  if (c.pool) bits.push(...cpuMem(c.pool));
  if (uses.length) bits.push(`서비스 ${uses.length}`);
  const out = [line(`${DOT[deviceTone(c)] ?? DOT.off} ${bits.join(" · ")}`, poolWarns(c.pool) ? { color: RED } : !c.online ? { color: GRAY } : {})];
  for (const u of uses) {
    const n = num(u.connections) ?? 0;
    out.push(line(`${shortName(u.service ?? u.fullName ?? "?")} :${u.port}${n > 1 ? ` ×${n}` : ""}`, { href: webUrl(u.url) }, 1));
  }
  if (c.pool?.detail && c.pool.detail !== "ok") out.push(line(c.pool.detail, { color: GRAY }, 1));
  if (uses.length || (c.pool?.detail && c.pool.detail !== "ok")) out.push("-----"); // separator inside the submenu
  out.push(line("기기 탭에서 보기", { href: hrefOf(base, `devices.html#${encodeURIComponent(c.id ?? c.name)}`) }, 1));
  return out;
}

// Local-only: listening on loopback only and not served, in the default view. "tailnet 공개" POSTs expose via curl.
export function localOnlyOf(ports) {
  return portsOf(ports).filter((p) => p.listening !== false && p.scope === "loopback" && !p.served && p.visible !== false);
}

export function exposeLine(base, port, depth = 2) {
  return line("tailnet 공개", {
    bash: "/usr/bin/curl",
    param1: "-fsS",
    param2: "-m",
    param3: "20",
    param4: "-X",
    param5: "POST",
    param6: "-H",
    param7: "X-Portboard:1", // no space, so no SwiftBar quoting; the server reads the header value as "1"
    param8: hrefOf(base, `api/ports/${port}/expose`),
    terminal: "false",
    refresh: "true",
  }, depth);
}

const linkLines = (base) => [
  line("대시보드 열기", { href: hrefOf(base, "") }),
  line("기기 탭", { href: hrefOf(base, "devices.html") }),
  line("새로고침", { refresh: "true" }),
];

const capped = (rows, render, more) => [...rows.slice(0, MAX_ROWS).flatMap(render), ...(rows.length > MAX_ROWS ? [more(rows.length - MAX_ROWS)] : [])];

export function menuLines({ ports, usage, devices, errors = {}, base = DEFAULT_BASE }) {
  const out = [titleOf({ ports, usage, devices, errors }), "---"];

  const warnings = warningsOf({ ports, usage, devices, errors });
  if (warnings.length) {
    for (const w of warnings) out.push(line(`⚠ ${w.text}`, { color: RED, href: hrefOf(base, w.path) }));
    out.push("---");
  }

  const cards = cardsOf({ usage, devices });
  out.push(line(`기기 ${cards.length}`, { size: 12, color: GRAY }));
  if (!cards.length) out.push(line("기기 정보 없음", { color: GRAY }));
  out.push(...capped(cards, (c) => deviceLines(c, base), (n) => line(`외 ${n}대 — 기기 탭에서 보기`, { href: hrefOf(base, "devices.html") })));
  out.push("---");

  const used = inUse({ ports, usage });
  out.push(line(`사용 중 서비스 ${usage ? used.length : "?"}`, { size: 12, color: GRAY }));
  if (usage && !used.length) out.push(line("지금 쓰는 서비스 없음", { color: GRAY }));
  out.push(...capped(used, (s) => {
    const who = s.users.map((u) => `${u.name ?? u.id}${u.connections > 1 ? ` ×${u.connections}` : ""}`).join(", ");
    return [line(`${s.name} :${s.port} · ${who}`, { href: s.url })];
  }, (n) => line(`외 ${n}개 — 대시보드에서 보기`, { href: hrefOf(base, "") })));
  out.push("---");

  const pinned = pinnedOf(ports);
  out.push(line(`고정한 포트 ${pinned.length}`, { size: 12, color: GRAY }));
  if (!pinned.length) out.push(line("고정한 포트 없음 (대시보드에서 고정)", { color: GRAY }));
  for (const p of pinned) {
    const up = p.listening !== false;
    out.push(line(`📌 ${portName(p)} :${p.port} · ${up ? (p.served ? "tailnet HTTPS" : p.scope === "loopback" ? "local only" : "리스닝") : "리스닝 없음"}`, up ? { href: portUrl(p) } : { color: RED, href: hrefOf(base, "") }));
  }

  const local = localOnlyOf(ports);
  if (local.length) {
    out.push(line(`local only 서비스 ${local.length}`));
    for (const p of local) {
      out.push(line(`${portName(p)} :${p.port}`, {}, 1));
      if (p.canExpose) out.push(exposeLine(base, p.port, 2));
      else out.push(line(`공개 불가: ${p.exposeBlocker ?? "?"}`, { color: GRAY }, 2));
      if (p.urls?.ssh) out.push(line(p.urls.ssh, { color: GRAY, font: "Menlo", size: 11 }, 2));
    }
  }
  out.push("---", ...linkLines(base));
  return out;
}

// Server unreachable (timeout, offline, bad JSON, or a crash while formatting): one title and the error, never a stack.
export function errorLines({ base = DEFAULT_BASE, error } = {}) {
  const msg = error instanceof Error ? error.message : String(error ?? "알 수 없는 오류");
  return [
    line("portboard ⚠", { color: RED }),
    "---",
    line(`portboard 연결 안 됨: ${msg}`, { color: RED }),
    line(`Tailscale 연결과 ${hrefOf(base, "")} 를 확인하세요`, { color: GRAY }),
    "---",
    ...linkLines(base),
  ];
}
