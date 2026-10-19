// Which Bash commands the port nudge reacts to (c10dev/portboard#42): hard-coded dev-server ports and kill-by-port,
// and none of the look-alikes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lex, mayMentionPort, parsePortCommands, peel, segments } from '../src/core/portcmd.ts';

const hits = (cmd: string) => parsePortCommands(cmd).map((c) => `${c.kind} ${c.port}`);
const one = (cmd: string, kind: 'start' | 'kill', port: number) => assert.deepEqual(hits(cmd), [`${kind} ${port}`], cmd);
const none = (cmd: string) => assert.deepEqual(hits(cmd), [], cmd);

test('lexer: quotes, escapes, comments, substitutions, redirections, heredocs', () => {
  assert.deepEqual(lex(`echo 'a b' "c $(d e)" f\\ g # h`), [
    { t: 'w', v: 'echo' },
    { t: 'w', v: 'a b' },
    { t: 'w', v: 'c ' },
    { t: 'op', v: '(' },
    { t: 'w', v: 'd' },
    { t: 'w', v: 'e' },
    { t: 'op', v: ')' },
    { t: 'w', v: 'f g' },
  ]);
  assert.deepEqual(segments('a 2>&1 >log b && c <in | d &').map((s) => [s.words.join(' '), s.after]), [
    ['a b', null],
    ['c', '&&'],
    ['d', '|'],
  ]);
  assert.deepEqual(segments("cat <<'EOF' > f\nvite --port 3000\nEOF\nls").map((s) => s.words.join(' ')), ['cat', 'ls']);
  assert.deepEqual(segments('cat <<-X\n\tnpm run dev -- --port 1\n\tX\necho ok').map((s) => s.words.join(' ')), ['cat', 'echo ok']);
  assert.deepEqual(peel(['sudo', '-u', 'me', 'env', 'A=1', 'nohup', 'timeout', '5', 'vite']), { env: { A: '1' }, argv: ['vite'] });
});

test('start: frameworks with a port flag', () => {
  one('vite --port 5173', 'start', 5173);
  one('vite --port=5174 --host 127.0.0.1', 'start', 5174);
  one('npx vite --port 4000', 'start', 4000);
  one('./node_modules/.bin/vite --port 4001', 'start', 4001);
  one('next dev -p 3001', 'start', 3001);
  one('next start --port 3002', 'start', 3002);
  one('npx next dev -p3003', 'start', 3003);
  one('astro dev --port 4321', 'start', 4321);
  one('astro preview --port=4322', 'start', 4322);
  one('serve -l 3005 dist', 'start', 3005);
  one('serve -l tcp://127.0.0.1:3006', 'start', 3006);
  one('npx serve dist -p 3007', 'start', 3007);
  one('http-server -p 8081 .', 'start', 8081);
  one('pnpm exec vite --port 5175', 'start', 5175);
  one('pnpm vite --port 5176', 'start', 5176);
  one('bunx vite --port 5177', 'start', 5177);
  one('python3 -m http.server 8001', 'start', 8001);
});

test('start: package scripts with --port or PORT=', () => {
  one('npm run dev -- --port 5173', 'start', 5173);
  one('npm run dev --port 5178', 'start', 5178);
  one('pnpm dev --port 5179', 'start', 5179);
  one('pnpm run dev -p 3010', 'start', 3010);
  one('pnpm -C web dev --port 5180', 'start', 5180);
  one('pnpm --filter web run dev -- --port 5181', 'start', 5181);
  one('yarn start -p 3011', 'start', 3011);
  one('bun run dev --port 3012', 'start', 3012);
  one('PORT=3013 npm start', 'start', 3013);
  one('PORT=3014 npm run dev', 'start', 3014);
  one('PORT=3015 node server.js', 'start', 3015);
  one('env PORT=3016 pnpm start', 'start', 3016);
  one('cd web && PORT=3017 npm run start', 'start', 3017);
  one('nohup npm run dev -- --port 3018 > /tmp/dev.log 2>&1 &', 'start', 3018);
  one('(cd app && npm run dev -- --port 3019) &', 'start', 3019);
  one('timeout 20 npm run preview -- --port 4173', 'start', 4173);
  one('bash -c "npm run dev -- --port 3020"', 'start', 3020);
  one('systemd-run --user --unit x -p WorkingDirectory=/a npm run dev -- --port 3021', 'start', 3021);
  assert.deepEqual(parsePortCommands('npm run dev -- --port 5173')[0], { kind: 'start', port: 5173, tool: 'npm run dev' });
});

test('start: no hard-coded port, no hit', () => {
  none('npm run dev');
  none('vite');
  none('pnpm dev');
  none('next dev');
  none('npm run build -- --port 3000');
  none('npm test -- -p 3');
  none('npm run lint');
  none('vite build');
  none('node -p "1+1"');
  none('node script.js -p 3000');
  none('PORT=abc npm start');
  none('vite --port 0');
  none('vite --port 70000');
});

test('kill by port', () => {
  one('kill $(lsof -t -i:3000)', 'kill', 3000);
  one('kill -9 $(lsof -ti:3001)', 'kill', 3001);
  one('kill "$(lsof -t -i :3002)"', 'kill', 3002);
  one('lsof -ti tcp:3003 | xargs kill', 'kill', 3003);
  one('lsof -t -iTCP:3004 -sTCP:LISTEN | xargs -r kill -9', 'kill', 3004);
  one('fuser -k 3005/tcp', 'kill', 3005);
  one('fuser -km 3006/tcp', 'kill', 3006);
  one('sudo fuser -k -n tcp 3007', 'kill', 3007);
  one("kill $(ss -ltnp 'sport = :3008' | grep -o 'pid=[0-9]*' | cut -d= -f2)", 'kill', 3008);
  one("ss -ltnp | grep :3009 | grep -oP 'pid=\\K\\d+' | xargs kill", 'kill', 3009);
  one('kill `lsof -t -i:3010`', 'kill', 3010);
  one('npx kill-port 3011', 'kill', 3011);
  one('PID=$(lsof -t -i:3012); kill $PID', 'kill', 3012);
  assert.deepEqual(hits('npx kill-port 3013 3014'), ['kill 3013', 'kill 3014']);
  assert.deepEqual(hits('fuser -k 3015/tcp; npm run dev -- --port 3015'), ['kill 3015', 'start 3015']);
});

test('false positives: ssh, docker, psql and other -p users', () => {
  none('ssh -p 22 user@host');
  none('ssh -p 2222 devbox "ls"');
  none('scp -P 2222 a b:');
  none('docker run -p 8080:80 nginx');
  none('docker compose up -d');
  none('psql -h localhost -p 5432 -U postgres');
  none('redis-cli -p 6379 ping');
  none('mysql -P 3306 -u root');
  none('nc -l -p 4000');
  none('curl -s http://127.0.0.1:3000/health');
  none('mkdir -p 3000');
  none('git log -p -3');
  none('ping -c 3 host');
  none('tailscale serve --bg 3000');
});

test('false positives: looking without killing, killing without a port', () => {
  none('lsof -i:3000');
  none('ss -ltnp | grep 3000');
  none('ss -ltn');
  none('fuser 3000/tcp');
  none('kill 12345');
  none('kill -9 12345');
  none('pkill -f vite');
  none('netstat -tlnp | grep :8080');
});

test('false positives: git, echo, grep, comments, heredocs', () => {
  none('git commit -m "use vite --port 5173 instead of npm run dev"');
  none("git commit -m 'fix: kill $(lsof -t -i:3000)'");
  none('git log --grep "PORT=3000"');
  none('echo "npm run dev -- --port 3000"');
  none('grep -rn "PORT=3000" src/');
  none('# vite --port 5173');
  none('ls # then npm run dev -- --port 3000');
  none("cat > notes.md <<'EOF'\nRun npm run dev -- --port 3000\nkill $(lsof -t -i:3000)\nEOF");
  none('cat <<EOF | tee x\nfuser -k 3000/tcp\nEOF');
  none('printf "%s" "vite --port 4000"');
  none('gh pr create --body "PORT=3000 npm start"');
});

test('mayMentionPort is a superset filter', () => {
  for (const c of ['vite --port 5173', 'PORT=3000 npm start', 'fuser -k 3000/tcp', 'kill $(lsof -t -i:3000)', 'serve -l 3005', 'python3 -m http.server 8001', 'next dev -p 3001']) {
    assert.equal(mayMentionPort(c), true, c);
    assert.ok(parsePortCommands(c).length, c);
  }
  assert.equal(mayMentionPort('ls -la'), false);
  assert.equal(mayMentionPort('git status'), false);
  assert.deepEqual(parsePortCommands('x'.repeat(30_000)), []);
});
