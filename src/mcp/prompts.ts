// MCP prompts: ready-made requests the user picks in the client (Claude Code: /mcp__portboard__<name>; Claude
// Desktop and claude.ai: the + / attach menu). prompts/get does no I/O: it returns Korean instructions that name
// the tools to call, so the text is the same in every client and needs nothing to redact. Names are ASCII
// because they become slash commands; titles are Korean.

import { RpcError } from './kit.ts';

export interface PromptArg {
  name: string;
  title?: string;
  description: string;
  required: boolean;
}

export interface PromptDef {
  name: string;
  title: string;
  description: string;
  arguments: PromptArg[];
  /** Arguments are already checked; values are trimmed and non-empty, or absent. */
  text(args: Record<string, string>): string;
}

export interface PromptResult {
  description: string;
  messages: { role: 'user'; content: { type: 'text'; text: string } }[];
}

export const PROMPTS: PromptDef[] = [
  {
    name: 'server_status_summary',
    title: '서버 상태 요약',
    description: '기기, compute-pool, 사용 중인 서비스, 꺼진 🔔 port, 새 기기를 한 번에 요약',
    arguments: [],
    text: () =>
      [
        'Portboard 서버 상태를 한국어로 짧게 요약해 줘.',
        '',
        '읽을 것 (resource를 읽을 수 있으면 `portboard://status` 하나로 충분하고, 아니면 tool로):',
        '- list_devices: 기기 online 여부, compute-pool host state',
        '- list_ports: listening port, alert=true인데 listening=false인 port (🔔 down)',
        '- who_uses: 지금 누가 어떤 서비스를 쓰는지',
        '- list_new_devices: 아직 확인 안 한 새 기기',
        '',
        '형식:',
        '1. 첫 줄에 결론 하나: "문제 없음" 또는 "확인 필요: …".',
        '2. 기기: online n / 전체 n. 꺼져 있으면 안 되는 것(compute-pool host, 이 서버)만 짚기. 휴대폰이 꺼진 건 넘어가.',
        '3. compute-pool: state가 ok·agent-busy·agent-away가 아닌 host와 그 state.',
        '4. 사용 중: 서비스별로 누가 쓰는지 한 줄씩.',
        '5. 🔔 down: port, 이름, 언제부터.',
        '6. 새 기기: 이름, 처음 쓴 서비스. 없으면 생략.',
        '',
        '문제가 있으면 다음에 할 일을 하나씩 제안만 하고, restart_service·stop_service·expose_port 같은 동작은 내가 말하기 전엔 하지 마.',
      ].join('\n'),
  },
  {
    name: 'port_cleanup',
    title: '포트 정리 제안',
    description: '안 쓰는 dev server와 중복 port를 찾아 정리 후보를 표로 제안 (실행은 안 함)',
    arguments: [
      { name: 'days', title: '며칠', description: '이 기간 동안 아무도 안 쓴 서비스를 후보로 (기본 7, 1–30)', required: false },
    ],
    text: (a) => {
      const days = a.days ?? '7';
      return [
        '이 서버에서 정리할 만한 port를 찾아서 제안해 줘. 아무것도 멈추거나 바꾸지 말고 제안만.',
        '',
        `1. list_ports(include_system: false)와 who_uses로 각 port의 owner(control), group, lastUsed, 지금 쓰는 기기를 본다.`,
        `2. 후보 기준: 지금 아무도 안 쓰고 lastUsed가 ${days}일보다 오래됐거나 기록이 없음 · 같은 project의 dev server가 여러 개 · http가 null이나 5xx인 app · tailscale serve(servedUrl)만 남고 아무도 안 여는 것.`,
        '3. 제외: portboard 자신, system port, pinned port, alert=true(🔔) port. group으로 묶인 port는 한 줄로 묶어서.',
        '',
        '결과는 표로: port · 이름 · control · 마지막 사용 · 근거 · 제안(stop_service / unexpose_port / 그대로 두기).',
        '애매하면 service_detail(port)로 사용 이력을 더 본다.',
        '내가 번호를 고르면 그때 하나씩 실행하고, plain process(control이 process: pid …)는 어디서 띄운 건지 먼저 알려줘.',
      ].join('\n');
    },
  },
  {
    name: 'new_dev_server',
    title: '새 개발 서버 띄우기',
    description: 'free_port로 빈 port를 받아 개발 서버를 띄우고, 다른 기기에서 여는 방법(tailnet URL)까지',
    arguments: [
      { name: 'project', title: '프로젝트', description: '띄울 프로젝트 폴더나 명령 (예: ~/projects/web, npm run dev)', required: false },
      { name: 'preferred', title: '선호 port', description: '이 port부터 찾기 (1024–65535, 기본 3000)', required: false },
    ],
    text: (a) =>
      [
        `새 개발 서버를 띄우려고 해${a.project ? `: ${a.project}` : ''}.`,
        '',
        `1. free_port(${a.preferred ? `preferred: ${a.preferred}` : ''})로 빈 port를 받는다. port를 짐작해서 고르지 마.`,
        '2. 그 port로 서버를 띄운다. framework별 flag를 쓰고(Vite `--port N`, Next.js `-p N`, Django `runserver 127.0.0.1:N`, 그 밖에는 `PORT=N`), bind는 기본 127.0.0.1.',
        '   오래 돌릴 거면 터미널에 묶이지 않게 띄우고(예: systemd --user 또는 nohup), 어떻게 띄웠는지 알려줘.',
        '3. list_ports(query: "N")로 listening인지, http 응답(status)이 오는지 확인. 안 뜨면 tail_logs(port: N)를 본다.',
        '4. 다른 기기(Mac, iPhone)에서 열기:',
        '   - scope가 loopback이고 canExpose=true면 expose_port(N) → servedUrl (https://<host>.ts.net:N, tailnet 기기에서만 열림).',
        '   - 결과에 enableUrl이 있으면 tailnet에 Serve가 아직 꺼져 있다는 뜻이니 그 링크를 나에게 전달.',
        '   - 이미 tailnet/all에 bind돼 있으면 expose 없이 directUrl을 쓴다.',
        '   - Funnel(인터넷 공개)은 하지 마.',
        '5. 마지막에 port, 띄운 방법, 열 URL, 끄는 방법을 정리해 줘.',
      ].join('\n'),
  },
  {
    name: 'why_not_open',
    title: '왜 안 열려?',
    description: '특정 port가 안 열릴 때 listening · bind scope · serve · HTTP · logs 순서로 원인 찾기',
    arguments: [
      { name: 'port', title: 'port', description: '안 열리는 port 번호', required: true },
      { name: 'from', title: '어디서', description: '열어 본 기기나 URL (예: iPhone, https://…ts.net:3000)', required: false },
    ],
    text: (a) =>
      [
        `port ${a.port}이(가) ${a.from ? `${a.from}에서 ` : ''}안 열려. 아래 순서대로 원인을 찾아 줘. 고치는 동작은 내가 확인한 다음에.`,
        '',
        `1. listening: list_ports(query: "${a.port}", include_system: true). 목록에 없거나 listening=false면 service_detail(port: ${a.port})로 🔔 상태와 마지막 사용을 보고, tail_logs(port: ${a.port})로 왜 멈췄는지 확인.`,
        '2. bind scope: loopback이면 이 서버 밖에서는 안 열린다. canExpose=true면 expose_port로 servedUrl을 만들자고 제안하고, 아니면 exposeBlocker를 설명하거나 0.0.0.0/tailnet bind를 제안.',
        '3. served: servedUrl이 있으면 그 https URL로 여는지, directUrl(http://…:port)과 헷갈리지 않았는지 확인.',
        '4. HTTP: http가 null이면 HTTP가 아니거나 응답이 없는 것, 4xx/5xx면 앱 문제 → tail_logs로 최근 오류.',
        `5. 접속하는 쪽: list_devices로 ${a.from ? `${a.from}이(가)` : '그 기기가'} tailnet에 online인지, who_uses(port: ${a.port})로 최근에 연결된 적 있는지.`,
        '',
        '마지막에 원인 한 줄 + 고치는 방법. restart_service, stop_service, expose_port는 실행 전에 물어봐.',
      ].join('\n'),
  },
];

// Numeric arguments by name, whichever prompt has them.
const RANGES: Record<string, { min: number; max: number }> = { port: { min: 1, max: 65535 }, preferred: { min: 1024, max: 65535 }, days: { min: 1, max: 30 } };

/** prompts/list entry: the definition without its text function. */
export const describe = (p: PromptDef) => ({ name: p.name, title: p.title, description: p.description, arguments: p.arguments });

/**
 * Checks arguments against a prompt's definition. Values must be strings (MCP sends them as strings); an empty
 * string counts as absent (some clients send "" for a field left blank). Throws RpcError -32602.
 */
export function checkArgs(p: PromptDef, raw: unknown): Record<string, string> {
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) throw new RpcError(-32602, 'arguments must be an object');
  const given = (raw ?? {}) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(given)) {
    const def = p.arguments.find((a) => a.name === k);
    if (!def) throw new RpcError(-32602, `unknown argument for ${p.name}: ${k.slice(0, 40)}`);
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string' && typeof v !== 'number') throw new RpcError(-32602, `${k} must be a string`);
    const s = String(v).trim();
    if (!s) continue;
    if (s.length > 200) throw new RpcError(-32602, `${k} is too long (max 200 characters)`);
    const range = RANGES[k];
    if (range && (!/^\d{1,5}$/.test(s) || Number(s) < range.min || Number(s) > range.max)) {
      throw new RpcError(-32602, `${k} must be an integer between ${range.min} and ${range.max} (got ${JSON.stringify(s.slice(0, 20))})`);
    }
    out[k] = range ? String(Number(s)) : s.replace(/\s+/g, ' ');
  }
  for (const a of p.arguments) if (a.required && !(a.name in out)) throw new RpcError(-32602, `missing required argument: ${a.name}`);
  return out;
}

export function getPrompt(name: unknown, args: unknown, prompts: PromptDef[] = PROMPTS): PromptResult {
  if (typeof name !== 'string') throw new RpcError(-32602, 'params.name must be a string');
  const p = prompts.find((x) => x.name === name);
  if (!p) throw new RpcError(-32602, `unknown prompt: ${name.slice(0, 64)}`);
  const text = p.text(checkArgs(p, args));
  return { description: p.title, messages: [{ role: 'user', content: { type: 'text', text } }] };
}
