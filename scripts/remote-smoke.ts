// End-to-end check of the remote MCP server, run on the server itself (it makes its own approval code):
// discovery → registration → consent with the approval code → PKCE token → initialize → tools/list → every tool,
// every resource and prompt → a refused write tool, local-only resources and prompt → refresh rotation. Prints status
// lines only; tokens stay in memory and are revoked at the end (only this run's client).
//
//   node scripts/remote-smoke.ts [base URL, default http://127.0.0.1:8794]
//   PORTBOARD_SMOKE_INSPECTOR=1 node scripts/remote-smoke.ts   # also run `mcp-inspector --cli` with the token

import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Store } from '../src/remote/store.ts';

const base = (process.argv[2] ?? 'http://127.0.0.1:8794').replace(/\/+$/, '');
const redirect = 'http://127.0.0.1:33418/callback';
const store = new Store();
let failed = 0;
const check = (ok: boolean, what: string, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? ` — ${detail}` : ''}`);
};

const unauth = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' });
const challenge = unauth.headers.get('www-authenticate') ?? '';
check(unauth.status === 401 && challenge.includes('resource_metadata='), 'unauthenticated /mcp → 401 with resource_metadata');

const prmUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1] ?? `${base}/.well-known/oauth-protected-resource/mcp`;
const prm = await (await fetch(prmUrl)).json();
check(prm.resource === `${base}/mcp`, 'protected resource metadata', prm.resource);
const as = await (await fetch(`${prm.authorization_servers[0]}/.well-known/oauth-authorization-server`)).json();
check(as.issuer === prm.authorization_servers[0] && as.code_challenge_methods_supported?.includes('S256'), 'authorization server metadata', as.issuer);

const reg = await (await fetch(as.registration_endpoint, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ client_name: 'portboard smoke test', redirect_uris: [redirect] }),
})).json();
check(typeof reg.client_id === 'string', 'dynamic client registration');

const verifier = randomBytes(32).toString('base64url');
const params = new URLSearchParams({
  response_type: 'code',
  client_id: reg.client_id,
  redirect_uri: redirect,
  code_challenge: createHash('sha256').update(verifier).digest('base64url'),
  code_challenge_method: 'S256',
  state: 'smoke',
  resource: prm.resource,
});
const page = await fetch(`${as.authorization_endpoint}?${params}`);
check(page.status === 200 && (await page.text()).includes('portboard smoke test'), 'consent page');

const { code: approval } = await store.newApprovalCode(60_000);
const approved = await fetch(as.authorization_endpoint, {
  method: 'POST',
  redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams([...params, ['approval_code', approval], ['decision', 'approve']]),
});
const loc = new URL(approved.headers.get('location') ?? 'about:blank');
check(approved.status === 302 && loc.searchParams.get('iss') === as.issuer && loc.searchParams.get('state') === 'smoke', 'approval → redirect with code, state, iss');

const tokenRes = await fetch(as.token_endpoint, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'authorization_code', code: loc.searchParams.get('code') ?? '', code_verifier: verifier, client_id: reg.client_id, redirect_uri: redirect, resource: prm.resource }),
});
const tokens = await tokenRes.json();
check(tokenRes.status === 200 && tokens.token_type === 'Bearer', 'token exchange (PKCE S256)', `expires_in=${tokens.expires_in}`);

let id = 0;
const rpc = async (method: string, params?: unknown, token = tokens.access_token) => {
  const r = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
  });
  return { status: r.status, body: r.status === 200 ? await r.json() : null };
};

const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } });
check(init.body?.result?.serverInfo?.name === 'portboard-remote', 'initialize', init.body?.result?.protocolVersion);
const list = await rpc('tools/list');
const names: string[] = list.body?.result?.tools?.map((t: any) => t.name) ?? [];
check(names.length > 0 && list.body.result.tools.every((t: any) => t.annotations?.readOnlyHint === true), 'tools/list (all readOnlyHint)', names.join(', '));
const LEAK = /\b\d{1,3}(?:\.\d{1,3}){3}\b|\b[0-9a-f]{2}(?::[0-9a-f]{2}){5}\b|\/home\/|ssh -N|\bpid\b|fd7a:/i;
for (const name of names) {
  const r = await rpc('tools/call', { name, arguments: {} });
  const text: string = r.body?.result?.content?.[0]?.text ?? '';
  check(r.status === 200 && !r.body?.result?.isError && !LEAK.test(text), `tools/call ${name}`, `${text.length} chars${LEAK.test(text) ? `, leak: ${text.match(LEAK)?.[0]}` : ''}`);
}
const write = await rpc('tools/call', { name: 'stop_service', arguments: { port: 8790 } });
check(write.body?.error?.code === -32602, 'tools/call stop_service refused', write.body?.error?.message);

const caps = init.body?.result?.capabilities ?? {};
check(!!caps.resources && !!caps.prompts, 'initialize advertises resources and prompts', JSON.stringify(caps));
const resources = await rpc('resources/list');
const uris: string[] = resources.body?.result?.resources?.map((r: any) => r.uri) ?? [];
check(uris.length > 0, 'resources/list', uris.join(', '));
for (const uri of uris) {
  const r = await rpc('resources/read', { uri });
  const text: string = r.body?.result?.contents?.[0]?.text ?? '';
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {}
  check(r.status === 200 && !!parsed && !LEAK.test(text), `resources/read ${uri}`, `${text.length} chars${LEAK.test(text) ? `, leak: ${text.match(LEAK)?.[0]}` : ''}${parsed?.unavailable?.length ? `, unavailable: ${parsed.unavailable}` : ''}`);
}
const templates = await rpc('resources/templates/list');
check(templates.body?.result?.resourceTemplates?.length === 0, 'resources/templates/list is empty');
for (const uri of ['portboard://port/8790', 'portboard://device/desktop-pc']) {
  const r = await rpc('resources/read', { uri });
  check(r.body?.error?.code === -32002, `resources/read ${uri} refused (local only)`, r.body?.error?.message);
}
const prompts = await rpc('prompts/list');
const promptNames: string[] = prompts.body?.result?.prompts?.map((p: any) => p.name) ?? [];
check(promptNames.length > 0, 'prompts/list', prompts.body?.result?.prompts?.map((p: any) => `${p.name} (${p.title})`).join(', '));
for (const name of promptNames) {
  const r = await rpc('prompts/get', { name, arguments: {} });
  const text: string = r.body?.result?.messages?.[0]?.content?.text ?? '';
  check(r.status === 200 && text.length > 0 && !/stop_service|expose_port|tail_logs|restart_service/.test(text), `prompts/get ${name}`, `${text.length} chars`);
}
const localPrompt = await rpc('prompts/get', { name: 'why_not_open', arguments: { port: '8790' } });
check(localPrompt.body?.error?.code === -32602, 'prompts/get why_not_open refused (local only)', localPrompt.body?.error?.message);

if (process.env.PORTBOARD_SMOKE_INSPECTOR) {
  // The token goes in through the environment of a direct binary call, so npx can't echo it.
  const which = spawnSync('bash', ['-c', 'ls -d ~/.npm/_npx/*/node_modules/.bin/mcp-inspector 2>/dev/null | head -1'], { encoding: 'utf8' }).stdout.trim();
  if (!which) console.log('skip mcp-inspector (run `npx @modelcontextprotocol/inspector --cli --help` once to install it)');
  for (const method of which ? ['tools/list', 'tools/call'] : []) {
    const args = ['--cli', `${base}/mcp`, '--transport', 'http', '--header', `Authorization: Bearer ${tokens.access_token}`, '--method', method];
    if (method === 'tools/call') args.push('--tool-name', 'free_port', '--tool-arg', 'count=2');
    const r = spawnSync(which, args, { encoding: 'utf8', timeout: 60_000 });
    const out = r.stdout.replaceAll(tokens.access_token, '…');
    let summary = out.slice(0, 200);
    try {
      const j = JSON.parse(out);
      summary = j.tools ? j.tools.map((t: any) => t.name).join(', ') : j.content?.[0]?.text;
    } catch {}
    check(r.status === 0, `mcp-inspector --cli ${method}`, summary);
  }
}

const refreshed = await fetch(as.token_endpoint, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: reg.client_id }),
});
const reuse = await fetch(as.token_endpoint, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: reg.client_id }),
});
check(refreshed.status === 200 && reuse.status === 400, 'refresh rotation (old refresh token refused)');

const n = await store.revoke(reg.client_id);
check((await rpc('ping')).status === 401, `revoked this run's ${n} tokens`);
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
