// SwiftBar menu bar plugin (menubar/): pure formatting, against fixtures captured from the live API
// (menubar/fixtures/*.json, hardware ids and command lines stripped).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  errorLines, esc, exposeLine, inUse, line, localOnlyOf, menuLines, titleOf, warningsOf,
} from '../menubar/format.mjs';

const BASE = 'https://devbox.example.ts.net';
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../menubar/fixtures/${name}.json`, import.meta.url), 'utf8'));
const live = () => ({ ports: fixture('ports'), usage: fixture('usage'), devices: fixture('devices') });
const menu = (docs = live(), errors = {}) => menuLines({ ...docs, errors, base: BASE }) as string[];

test('live fixtures: ⇄ 3 in use, no ⚠ (the Mac being agent-busy is normal)', () => {
  const docs = live();
  assert.equal(titleOf(docs), '⇄ 3');
  assert.deepEqual(warningsOf(docs), []);
  const used = inUse(docs);
  assert.deepEqual(used.map((s: any) => s.port), [7721, 8790, 22000]);
  // short service names from usage, not the long page titles
  assert.deepEqual(used.map((s: any) => s.name), ['compute-pool monitor', 'Portboard', 'Syncthing']);
  const m = menu(docs);
  assert.equal(m[0], '⇄ 3');
  assert.ok(m.includes('🟡 dev-mac · pool 사용 중 · load 5.3/10 · 서비스 2'));
});

test('기기: pool hosts show CPU and memory, offline is gray, submenu lists the services the device uses', () => {
  const m = menu();
  assert.ok(m.includes('🟢 devbox (이 서버) · pool 정상 · CPU 5% · 메모리 53%'));
  assert.ok(m.includes('🟢 desktop-pc · pool 정상 · CPU 0% · 메모리 9% · 서비스 1'));
  assert.ok(m.includes('⚪ docker-vm · 오프라인 | color=#8E8E93'));
  const i = m.indexOf('🟢 nas · 온라인 · 서비스 1');
  assert.equal(m[i + 1], '--Syncthing :22000'); // tcp:// is not clickable
  assert.equal(m[i + 2], '-----');
  assert.equal(m[i + 3], `--기기 탭에서 보기 | href=${BASE}/devices.html#nas`);
  assert.ok(m.includes(`--Portboard :8790 ×2 | href=${BASE}/`));
});

test('사용 중 서비스: one row each; served/direct http URL is the href, tcp:// gets none', () => {
  const m = menu();
  assert.ok(m.includes('사용 중 서비스 3 | size=12 color=#8E8E93'));
  assert.ok(m.includes(`Portboard :8790 · tailscale serve · 기기 미확인 ×2 | href=${BASE}/`));
  assert.ok(m.includes('Syncthing :22000 · nas'));
  assert.ok(m.includes('compute-pool monitor :7721 · dev-mac'));
});

test('compute-pool host down: red ⚠ title and a warning line that opens the 기기 tab', () => {
  const docs = live();
  docs.usage.cards.find((c: any) => c.id === 'desktop-pc').pool.state = 'host-down';
  assert.equal(titleOf(docs), '⇄ 3 ⚠ | color=#FF3B30');
  const m = menu(docs);
  assert.equal(m[2], `⚠ compute-pool desktop-pc (pool desktop): 응답 없음 | color=#FF3B30 href=${BASE}/devices.html#desktop-pc`);
  assert.ok(m.some((l) => l.startsWith('🔴 desktop-pc · pool 응답 없음') && l.endsWith('| color=#FF3B30')));
  for (const state of ['wsl-down', 'auth', 'degraded']) {
    docs.usage.cards.find((c: any) => c.id === 'desktop-pc').pool.state = state;
    assert.match(titleOf(docs), /⚠/, state);
  }
  for (const state of ['ok', 'agent-busy', 'agent-away', 'unknown']) {
    docs.usage.cards.find((c: any) => c.id === 'desktop-pc').pool.state = state;
    assert.doesNotMatch(titleOf(docs), /⚠/, state);
  }
});

test('고정한 포트: listening pin opens its URL; a pin that is not listening warns', () => {
  const docs = live();
  const p8790 = docs.ports.ports.find((p: any) => p.port === 8790);
  p8790.pinned = true;
  docs.ports.ports.push({ port: 3001, listening: false, pinned: true, visible: true, name: '실험 | 서버', urls: { direct: null, served: null } });
  const m = menu(docs);
  assert.ok(m.includes('고정한 포트 2 | size=12 color=#8E8E93'));
  assert.ok(m.some((l) => l.startsWith('📌 Portboard') && l.endsWith(`:8790 · tailnet HTTPS | href=${BASE}/`)));
  assert.ok(m.includes(`📌 실험 ¦ 서버 :3001 · 리스닝 없음 | color=#FF3B30 href=${BASE}/`));
  assert.ok(m.includes(`⚠ 고정한 포트 :3001 실험 ¦ 서버 리스닝 없음 | color=#FF3B30 href=${BASE}/`));
  assert.equal(m[0], '⇄ 3 ⚠ | color=#FF3B30');
  assert.ok(!menu().some((l) => l.startsWith('📌')));
  assert.ok(menu().includes('고정한 포트 없음 (대시보드에서 고정) | color=#8E8E93'));
});

test('local only: visible loopback ports not served; tailnet 공개 is a curl POST with X-Portboard, then refresh', () => {
  const docs = live();
  assert.deepEqual(localOnlyOf(docs.ports).map((p: any) => p.port), [3080, 5281, 7720, 8080, 8384, 18080]);
  assert.equal(
    exposeLine(BASE, 3080),
    `----tailnet 공개 | bash=/usr/bin/curl param1=-fsS param2=-m param3=20 param4=-X param5=POST param6=-H param7=X-Portboard:1 param8=${BASE}/api/ports/3080/expose terminal=false refresh=true`,
  );
  const m = menu(docs);
  assert.ok(m.includes('local only 서비스 6'));
  const i = m.indexOf('--ShopSim :5281');
  assert.equal(m[i + 1], exposeLine(BASE, 5281));
  assert.equal(m[i + 2], '----ssh -N -L 5281:127.0.0.1:5281 dev@devbox | color=#8E8E93 font=Menlo size=11');
  // a loopback port the server will not expose shows why instead of the action
  docs.ports.ports.find((p: any) => p.port === 5281).canExpose = false;
  docs.ports.ports.find((p: any) => p.port === 5281).exposeBlocker = 'not an HTTP server';
  const m2 = menu(docs);
  assert.equal(m2[m2.indexOf('--ShopSim :5281') + 1], '----공개 불가: not an HTTP server | color=#8E8E93');
});

test('escaping: `|` in Korean text, newlines, a leading dash, long text; submenu markers survive', () => {
  assert.equal(esc('MCC 대기 | merge\n두 줄'), 'MCC 대기 ¦ merge 두 줄');
  assert.equal(esc('- 맨 앞 하이픈'), '– 맨 앞 하이픈');
  assert.equal(esc('가'.repeat(300)).length, 110);
  assert.equal(line('-x', {}, 1), '--–x');
  assert.equal(line('한글 | 이름', { href: 'https://a.b/c d|e' }), '한글 ¦ 이름 | href=https://a.b/c%20d%7Ce');
  const docs = live();
  docs.ports.ports.find((p: any) => p.port === 8790).label = '포트보드 | 대시보드';
  const row = menu(docs).find((l) => l.startsWith('포트보드'))!;
  assert.equal(row, `포트보드 ¦ 대시보드 :8790 · tailscale serve · 기기 미확인 ×2 | href=${BASE}/`);
  assert.equal(row.split(' | ').length, 2);
});

test('partial failure: /api/usage down → ⇄ ? ⚠, devices from /api/devices, the error is one line', () => {
  const docs = { ...live(), usage: null };
  const m = menu(docs, { usage: 'ECONNRESET' });
  assert.equal(m[0], '⇄ ? ⚠ | color=#FF3B30');
  assert.equal(m[2], `⚠ /api/usage 읽기 실패: ECONNRESET | color=#FF3B30 href=${BASE}/`);
  assert.ok(m.includes('기기 8 | size=12 color=#8E8E93'));
  assert.ok(m.some((l) => l.startsWith('🟢 devbox (이 서버) · pool 정상')));
  assert.ok(m.includes('사용 중 서비스 ? | size=12 color=#8E8E93'));
});

test('missing and extra fields never throw', () => {
  const odd = [
    { ports: {}, usage: {}, devices: {} },
    { ports: null, usage: null, devices: null },
    { ports: { ports: [{ port: 1 }, null, { port: 'x' }] }, usage: { byPort: { 1: [{ name: 'a', connections: 2 }] }, cards: [{ id: 'z', uses: [{ port: 1 }], pool: { state: 'new-state', newField: 1 } }] }, devices: { devices: 'nope' } },
    { ports: { ports: [{ port: 9, pinned: true, listening: true, futureFlag: { alert: true } }] }, usage: { cards: null, byPort: null }, devices: null },
  ];
  for (const docs of odd) {
    const m = menu(docs as any);
    assert.ok(m[0].startsWith('⇄'), JSON.stringify(docs));
    assert.ok(m.includes('새로고침 | refresh=true'));
  }
  assert.equal(menu(odd[2] as any)[0], '⇄ 1');
});

test('unreachable: portboard ⚠ and the error, no stack, links still there', () => {
  const m = errorLines({ base: BASE, error: new Error('8초 안에 응답 없음') }) as string[];
  assert.equal(m[0], 'portboard ⚠ | color=#FF3B30');
  assert.equal(m[2], 'portboard 연결 안 됨: 8초 안에 응답 없음 | color=#FF3B30');
  assert.ok(!m.some((l) => /\bat \S+:\d+/.test(l)));
  assert.deepEqual(m.slice(-3), [`대시보드 열기 | href=${BASE}/`, `기기 탭 | href=${BASE}/devices.html`, '새로고침 | refresh=true']);
  assert.equal((errorLines({ error: 'ENOTFOUND' }) as string[])[2], 'portboard 연결 안 됨: ENOTFOUND | color=#FF3B30');
});

test('links: 대시보드 열기 and 기기 탭 at the end', () => {
  assert.deepEqual(menu().slice(-4), ['---', `대시보드 열기 | href=${BASE}/`, `기기 탭 | href=${BASE}/devices.html`, '새로고침 | refresh=true']);
});
