// Overview: the MCP resources and prompts that summarize across features. portboard://status (devices, pool,
// services in use, watched ports down, 새 기기, collection health), portboard://port/{port} (service_detail) and
// portboard://device/{id}; the ready-made prompts. The remote server gets the status resource only, redacted, and
// prompt texts that name only the tools it has.
//
// The data shaping stays in src/mcp/resources.ts, status.ts and prompts.ts; this module says what is offered where.

import { listResources, readResource, RESOURCE_TEMPLATES, STATUS_RESOURCE, STATUS_URI } from '../mcp/resources.ts';
import { PROMPTS, type PromptDef } from '../mcp/prompts.ts';
import { redactStatus, type RedactPolicy } from '../remote/redact.ts';
import type { RemoteCore } from '../remote/core.ts';
import type { FeatureModule } from './types.ts';
import { SITE } from '../core/site.ts';

const REMOTE_RESOURCES = [
  {
    ...STATUS_RESOURCE,
    description:
      `Portboard 서버(${SITE.host}) 상태를 한눈에: devices online, compute-pool health, services in use (누가 무엇을), ` +
      'watched (🔔) ports that are down, how many 새 기기 are not acknowledged yet, and memory pressure (available %, swap %, PSI). ' +
      'Read-only; addresses are left out.',
  },
];

const STATUS_SUMMARY = PROMPTS.find((p) => p.name === 'server_status_summary')!;
const PORT_CLEANUP = PROMPTS.find((p) => p.name === 'port_cleanup')!;

// Same names and titles as the local server; the text only names what this connection has.
const REMOTE_PROMPTS: PromptDef[] = [
  {
    ...STATUS_SUMMARY,
    text: () =>
      [
        `Portboard 서버(${SITE.host}) 상태를 한국어로 짧게 요약해 줘.`,
        '',
        '읽을 것: resource `portboard://status`를 읽을 수 있으면 그것 하나로 충분하고, 아니면 list_devices, list_ports, who_uses_what tool로.',
        '',
        '형식:',
        '1. 첫 줄에 결론 하나: "문제 없음" 또는 "확인 필요: …".',
        '2. 기기: online n / 전체 n. 꺼져 있으면 안 되는 것(compute-pool host, 이 서버)만 짚기. 휴대폰이 꺼진 건 넘어가.',
        '3. compute-pool: state가 ok·agent-busy·agent-away가 아닌 host와 그 state.',
        '4. 사용 중: 서비스별로 누가 쓰는지 한 줄씩.',
        '5. 🔔 down: port, 이름, 언제부터 (status resource에만 있음).',
        '6. 새 기기: 확인 안 한 기기가 몇 대인지. 없으면 생략.',
        '',
        '이 연결은 읽기 전용이라 아무것도 바꿀 수 없어. 문제가 있으면 무엇을 확인하면 좋을지만 제안해 줘.',
      ].join('\n'),
  },
  {
    ...PORT_CLEANUP,
    description: '안 쓰는 dev server와 중복 port를 찾아 정리 후보를 표로 제안 (읽기 전용)',
    arguments: [],
    text: () =>
      [
        '이 서버에서 정리할 만한 port 후보를 찾아 줘. 이 연결은 읽기 전용이라 제안만 하고, 실제 정리는 내가 대시보드나 서버의 Claude Code에서 할게.',
        '',
        '1. list_ports와 who_uses_what로 각 port의 owner(control)와 지금 쓰는 기기를 본다.',
        '2. 후보: 지금 아무도 안 쓰는 dev server · 같은 이름이나 project의 port가 여러 개 · http가 null이나 5xx인 app.',
        '3. 제외: portboard 자신, pinned port, system port.',
        '',
        '결과는 표로: port · 이름 · control · 근거 · 제안(멈추기 / tailnet 공개 해제 / 그대로 두기).',
        '마지막 사용 이력은 이 연결에서 보이지 않으니, 확신이 없는 후보는 그렇다고 적어 줘.',
      ].join('\n'),
  },
];

const settled = <T>(fn: (() => Promise<T>) | undefined): Promise<T | null> =>
  fn ? Promise.resolve().then(fn).catch(() => null) : Promise.resolve(null);

/** Remote portboard://status: the same summary from RemoteCore, redacted (addresses, processes, LAN names). */
async function remoteStatus(core: RemoteCore, policy: RedactPolicy) {
  const [snap, devices, usage, extras] = await Promise.all([
    settled(() => core.snapshot()),
    settled(() => core.devices()),
    settled(() => core.usage()),
    settled(core.statusExtras && (() => core.statusExtras!())),
  ]);
  const status = redactStatus({ at: new Date().toISOString(), snap, devices, usage, extras }, policy);
  return { contents: [{ uri: STATUS_URI, mimeType: 'application/json', text: JSON.stringify(status) }] };
}

export const overviewFeature: FeatureModule = {
  name: 'overview',
  resources: {
    templates: RESOURCE_TEMPLATES,
    list: async (core) => (await listResources(core)).resources,
    // portboard://status, portboard://port/<x>, portboard://device/<x>: resources.ts answers (and says what's wrong)
    claims: (uri) => uri === STATUS_URI || /^portboard:\/\/(port|device)\/[^/?#]+$/.test(uri),
    read: (uri, core) => readResource(uri, core),
  },
  remoteResources: { resources: REMOTE_RESOURCES, read: (_uri, core, policy) => remoteStatus(core, policy) },
  prompts: PROMPTS,
  remotePrompts: REMOTE_PROMPTS,
};
