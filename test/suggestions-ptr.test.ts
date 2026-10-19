// The PTR lookup behind 추천 이름 (src/features/suggestions.ts hostnames()), with a fake resolver and clock: only
// private LAN addresses are asked, only of the default gateway (never a public resolver), the first name wins, and
// an answer — or no answer — is kept for 10 minutes. suggest.test.ts covers what the names then suggest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostnames, suggestionsFeature, type PtrResolver } from '../src/features/suggestions.ts';
import type { Core } from '../src/mcp/kit.ts';

const MIN = 60_000;

/** A resolver that answers from a table (missing = ENOTFOUND), recording which servers it was made for and what it was asked. */
function fake(answers: Record<string, string[] | Error>) {
  const made: string[][] = [];
  const asked: string[] = [];
  const resolverFor = (servers: string[]): PtrResolver => {
    made.push(servers);
    return {
      reverse: async (ip) => {
        asked.push(ip);
        const a = answers[ip];
        if (!a || a instanceof Error) throw a ?? Object.assign(new Error(`getHostByAddr ENOTFOUND ${ip}`), { code: 'ENOTFOUND' });
        return a;
      },
    };
  };
  return { resolverFor, made, asked };
}

test('PTR: only RFC 1918 addresses are asked, of the gateway; the first name of each answer is used', async () => {
  const f = fake({ '192.168.1.31': ['diskstation.lan.', 'nas.lan.'], '10.0.0.7': ['printer.home.'], '172.20.1.2': ['vm.lan.'] });
  const ips = ['192.168.1.31', '10.0.0.7', '172.20.1.2', '172.32.0.1', '172.15.0.1', '100.64.0.9', '8.8.8.8', 'fd7a:115c:a1e0::1', '192.169.0.1'];
  const names = await hostnames(ips, ['192.168.1.1'], f.resolverFor, () => 1_000);
  assert.deepEqual(Object.fromEntries(names), { '192.168.1.31': 'diskstation.lan.', '10.0.0.7': 'printer.home.', '172.20.1.2': 'vm.lan.' });
  assert.deepEqual(f.made, [['192.168.1.1']], 'one resolver, pointed at the gateway only');
  assert.deepEqual(f.asked.sort(), ['10.0.0.7', '172.20.1.2', '192.168.1.31']);
});

test('PTR: no gateway or nothing private to ask makes no resolver at all', async () => {
  const f = fake({});
  assert.equal((await hostnames(['192.168.1.40'], [], f.resolverFor)).size, 0);
  assert.equal((await hostnames(['100.64.0.9', '8.8.4.4'], ['192.168.1.1'], f.resolverFor)).size, 0);
  assert.equal((await hostnames([], ['192.168.1.1'], f.resolverFor)).size, 0);
  assert.deepEqual(f.made, []);
});

test('PTR: a name and a failure are both kept for 10 minutes, then asked again', async () => {
  let t = 50_000_000;
  const answers: Record<string, string[] | Error> = { '192.168.7.10': ['tv.lan.'], '192.168.7.11': new Error('ETIMEOUT') };
  const f = fake(answers);
  const ask = () => hostnames(['192.168.7.10', '192.168.7.11'], ['192.168.7.1'], f.resolverFor, () => t);
  assert.deepEqual(Object.fromEntries(await ask()), { '192.168.7.10': 'tv.lan.' });
  answers['192.168.7.11'] = ['phone.lan.'];
  t += 10 * MIN - 1;
  assert.deepEqual(Object.fromEntries(await ask()), { '192.168.7.10': 'tv.lan.' }, 'cached: the failure too');
  assert.equal(f.asked.length, 2);
  t += 1;
  assert.deepEqual(Object.fromEntries(await ask()), { '192.168.7.10': 'tv.lan.', '192.168.7.11': 'phone.lan.' });
  assert.equal(f.asked.length, 4);
});

test('PTR: an empty answer is no name', async () => {
  const f = fake({ '10.9.9.9': [] });
  assert.equal((await hostnames(['10.9.9.9'], ['10.9.9.1'], f.resolverFor, () => 7)).size, 0);
});

test('list_suggestions: says so where the core has no suggestions (the remote server), else returns the report', async () => {
  const tool = suggestionsFeature.tools!.find((x) => x.def.name === 'list_suggestions')!;
  assert.equal(tool.def.annotations.readOnlyHint, true);
  const none = await tool.call({}, {} as Core);
  assert.deepEqual(none, { content: [{ type: 'text', text: 'list_suggestions is not available here' }], isError: true });
  const report = { at: 1, suggestions: [], dismissed: 2 };
  const r = await tool.call({}, { suggestions: async () => report } as unknown as Core);
  assert.deepEqual(JSON.parse(r.content[0].text), report);
  assert.equal(r.isError, undefined);
});
