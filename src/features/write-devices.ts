// 쓰기 허용 기기 (security review v1.0, M1) from the 설정 tab: the owner's tailnet devices, which of them may write
// through tailscale serve, and saving that list to access.json (src/core/access.ts) instead of editing it by hand.
//
//   GET  /api/settings/write-devices   {path, list, env, error, devices[{name, os, listed, current}], others[], current}
//                                      devices: untagged nodes logged in as the owner (tailscale status), other than
//                                      this server; others: listed entries that match none of them (an ID, an old name)
//   POST /api/settings/write-devices   {writeDevices: [names]} → the new view. A guarded owner write (X-Portboard,
//                                      owner login, the current allowlist). Refused (409) when the list leaves out the
//                                      device the request comes from, so nobody locks themselves out; loopback stays
//                                      the owner whatever the list says. access.json is written 0600, atomically,
//                                      keeping its other keys.
//
// PORTBOARD_WRITE_DEVICES (env) is merged in by loadWriteDevices and shown, never written. A preview has its own
// access.json (paths.ts), so saving there never changes production.

import { homedir } from 'node:os';
import { checkWriteDevices, deviceAllowed, deviceLabel, loadWriteDevices, resolveCaller, saveWriteDevices, type Caller } from '../core/access.ts';
import { runShared } from '../core/exec.ts';
import { ownerDevicesFromStatus } from '../core/onboarding.ts';
import { ok, reply } from './router.ts';
import type { ServerContext } from './context.ts';
import type { FeatureModule } from './types.ts';
import { t } from '../core/i18n.ts';

type Req = Parameters<typeof resolveCaller>[0];

export interface WriteDevicesView {
  /** where this profile keeps it, ~ for the home directory */
  path: string;
  /** access.json's writeDevices, null when the file has none (then every owner device may write) */
  list: string[] | null;
  /** PORTBOARD_WRITE_DEVICES: merged in, read-only here */
  env: string[];
  /** access.json is there but unusable: serve writes are refused until it's fixed */
  error: string | null;
  /** null: tailscale didn't answer */
  devices: { name: string; os: string | null; listed: boolean; current: boolean }[] | null;
  /** listed entries that match no owner device */
  others: string[];
  /** the device this request came from; null for loopback (always the owner) */
  current: { name: string | null; id: string | null; label: string } | null;
  source: Caller['source'];
}

const tilde = (p: string, home = homedir()) => (p === home || p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p);
const matches = (entry: string, name: string) => entry.trim().replace(/\.$/, '').toLowerCase().split('.')[0] === name.toLowerCase();
const envList = (env: Record<string, string | undefined>) => [...new Set((env.PORTBOARD_WRITE_DEVICES ?? '').split(',').map((x) => x.trim()).filter(Boolean))];

export interface ViewDeps {
  /** `tailscale status --json`, null when it fails */
  tailscaleStatus?(): Promise<string | null>;
  env?: Record<string, string | undefined>;
}

export async function writeDevicesView(req: Req, ctx: Pick<ServerContext, 'paths' | 'owner' | 'device' | 'writeDevices'>, deps: ViewDeps = {}): Promise<WriteDevicesView> {
  const env = deps.env ?? process.env;
  const status =
    deps.tailscaleStatus ??
    (async () => {
      const r = await runShared('tailscale', ['status', '--json']);
      return r.ok ? r.stdout : null;
    });
  const [file, caller, json] = await Promise.all([loadWriteDevices(ctx.paths.access, {}), resolveCaller(req, ctx), status().catch(() => null)]);
  const list = file && !file.error ? file.list : null;
  const owners = ownerDevicesFromStatus(json, env.PORTBOARD_OWNER_LOGIN?.trim() || null);
  // only a serve caller can be locked out (direct is read-only, loopback always the owner)
  const cur = caller.device && caller.source === 'serve' ? caller.device : null;
  const devices = owners?.map((d) => ({ ...d, listed: !!list?.some((e) => matches(e, d.name)), current: !!cur?.name && cur.name.toLowerCase() === d.name.toLowerCase() })) ?? null;
  // The device in use, even when tailscale status didn't list it among the owner's (it can't be unchecked by accident).
  if (devices && cur?.name && !devices.some((d) => d.current)) devices.unshift({ name: cur.name, os: null, listed: !!list?.some((e) => matches(e, cur.name!)), current: true });
  const others = (list ?? []).filter((e) => !devices?.some((d) => matches(e, d.name)));
  return {
    path: tilde(ctx.paths.access),
    list,
    env: envList(env),
    error: file?.error ?? null,
    devices,
    others,
    current: caller.source === 'loopback' ? null : { name: cur?.name ?? null, id: cur?.id ?? null, label: deviceLabel(caller.device, caller.addr) },
    source: caller.source,
  };
}

/** Why saving `list` would lock the caller out, or null. Loopback (and the stdio MCP) are the owner whatever the list says. */
export function lockoutReason(caller: Caller, list: string[], env: string[]): string | null {
  if (caller.source !== 'serve') return null;
  if (!caller.device?.name && !caller.device?.id) return t('writeDevicesApi.unknownCaller', { device: deviceLabel(caller.device, caller.addr) });
  if (deviceAllowed(caller.device, [...list, ...env])) return null;
  return t('writeDevicesApi.notListed', { device: deviceLabel(caller.device, caller.addr) });
}

export const writeDevicesFeature: FeatureModule = {
  name: 'write-devices',
  order: 2800,
  routes: [
    { method: 'GET', path: '/api/settings/write-devices', handler: async ({ req }, ctx) => ok(await writeDevicesView(req, ctx)) },
    {
      method: 'POST',
      path: '/api/settings/write-devices',
      write: true,
      body: { limit: 8192 },
      async handler({ body, req }, ctx) {
        const list = checkWriteDevices((body as { writeDevices?: unknown } | null)?.writeDevices);
        if (typeof list === 'string') return reply(400, { error: list });
        const why = lockoutReason(await resolveCaller(req, ctx), list, envList(process.env));
        if (why) return reply(409, { error: why });
        try {
          await saveWriteDevices(ctx.paths.access, list);
        } catch (err) {
          // Our own reasons (the file isn't a JSON object…) go back; anything else is a 500 with only a request id.
          if (err instanceof Error && err.message.startsWith('access.json')) return reply(409, { error: err.message });
          throw err;
        }
        return ok({ ...(await writeDevicesView(req, ctx)), message: t('writeDevicesApi.saved', { n: list.length }) });
      },
    },
  ],
  ui: [{ pages: ['#settings'], script: 'features/write-devices.js' }],
};
