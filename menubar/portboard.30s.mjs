#!/usr/bin/env node
// <xbar.title>portboard</xbar.title>
// <xbar.version>v1.0</xbar.version>
// <xbar.desc>Portboard at a glance: devices, services in use, pinned ports, local-only services.</xbar.desc>
// <xbar.dependencies>node</xbar.dependencies>
// <swiftbar.hideAbout>true</swiftbar.hideAbout>
// <swiftbar.hideRunInTerminal>true</swiftbar.hideRunInTerminal>
// <swiftbar.hideDisablePlugin>true</swiftbar.hideDisablePlugin>
// <swiftbar.environment>[PORTBOARD_URL:]</swiftbar.environment>
//
// SwiftBar plugin. The Mac's node runs it every 30 s (the `30s` in the file name). It reads Portboard over the tailnet
// (GET only). The one write is the "tailnet 공개" item, which SwiftBar runs as a curl POST when clicked.
// scripts/mac-menubar-setup.sh installs it and rewrites line 1 to an absolute node path (SwiftBar has no nvm PATH).
import { DEFAULT_BASE, errorLines, menuLines } from "./format.mjs";

const BASE = (process.env.PORTBOARD_URL || DEFAULT_BASE).replace(/\/+$/, "");
const TIMEOUT_MS = 8000;

const get = async (path) => {
  // The User-Agent lets the dashboard's 설정 체크리스트 see that the menu bar is installed.
  const res = await fetch(`${BASE}${path}`, { headers: { "user-agent": "portboard-menubar/1" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${path} HTTP ${res.status}`);
  return res.json();
};
const reason = (r) => {
  const e = r.reason;
  if (e?.name === "TimeoutError") return `${TIMEOUT_MS / 1000}초 안에 응답 없음`;
  return String(e?.cause?.code ?? e?.cause?.message ?? e?.message ?? e);
};

try {
  const [ports, usage, devices] = await Promise.allSettled([get("/api/ports"), get("/api/usage"), get("/api/devices")]);
  // /api/ports is required; usage and devices only add detail (their failure is shown as a ⚠ line).
  if (ports.status === "rejected") {
    console.log(errorLines({ base: BASE, error: reason(ports) }).join("\n"));
  } else {
    const errors = {};
    if (usage.status === "rejected") errors.usage = reason(usage);
    if (devices.status === "rejected") errors.devices = reason(devices);
    console.log(menuLines({
      ports: ports.value,
      usage: usage.status === "fulfilled" ? usage.value : null,
      devices: devices.status === "fulfilled" ? devices.value : null,
      errors,
      base: BASE,
    }).join("\n"));
  }
} catch (err) {
  // A formatting bug must not show SwiftBar's raw error: keep the title short and say what broke.
  console.log(errorLines({ base: BASE, error: err }).join("\n"));
}
