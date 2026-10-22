// Portboard's own units and processes (src/core/selfunit.ts): what stop refuses and the new-port and idle checks skip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPortboardCommand, isPortboardProcess, isPortboardUnit, portboardScript } from '../src/core/selfunit.ts';

// Portboard checkouts in these tests; checkout.ts reads package.json for real ones
const CHECKOUTS = new Set([
  '/home/dev/projects/portboard',
  '/home/dev/projects/portboard/.claude/worktrees/feat-x',
  '~/projects/portboard',
  '/Users/dev/My Projects/portboard',
]);
const isCheckout = (dir: string) => CHECKOUTS.has(dir);

test('isPortboardUnit: portboard.service and the units install-service writes, nothing else', () => {
  for (const u of ['portboard.service', 'portboard-remote.service', 'portboard-agent.service']) assert.equal(isPortboardUnit(u), true, u);
  for (const u of ['portboard-x.timer', 'pb-dev-shop-web.service', 'my-portboard.service', 'portboard.service.bak', '', null, undefined]) {
    assert.equal(isPortboardUnit(u), false, String(u));
  }
});

test('portboardScript: the script is the first non-option argument after the runtime; later arguments never count', () => {
  assert.deepEqual(portboardScript('/home/dev/.nvm/versions/node/v24.19.0/bin/node --max-semi-space-size=16 /home/dev/projects/portboard/bin/portboard start'), { bin: true });
  assert.deepEqual(portboardScript('/usr/local/bin/portboard agent'), { bin: true }, 'run as the npm bin itself');
  assert.deepEqual(portboardScript('node /home/dev/.npm/_npx/3f2a/node_modules/.bin/portboard start'), { bin: true }, 'npx @c10dev/portboard start');
  assert.deepEqual(portboardScript('/usr/bin/nodejs /home/dev/app/node_modules/.bin/portboard mcp'), { bin: true });
  assert.deepEqual(
    portboardScript('/opt/homebrew/bin/node --max-semi-space-size=16 /Users/dev/My Projects/portboard/bin/portboard start'),
    { bin: false, root: '/Users/dev/My Projects/portboard' },
    'a path with spaces: the checkout must be checked',
  );
  assert.deepEqual(portboardScript('node /Users/dev/My Projects/portboard/src/remote.ts'), { bin: false, root: '/Users/dev/My Projects/portboard' });
  assert.deepEqual(portboardScript('node ./src/remote.ts'), { bin: false, root: '.' });
  assert.deepEqual(portboardScript('node src/server.ts'), { bin: false, root: '' });
  assert.deepEqual(portboardScript('node /home/dev/projects/portboard/src/mcp.ts'), { bin: false, root: '/home/dev/projects/portboard' });
  assert.equal(portboardScript('node /home/dev/mybin/portboard start'), null);
  assert.equal(portboardScript('node /home/dev/bin/portboard-helper'), null);
  assert.equal(portboardScript('node /home/dev/projects/acme/lib-src/server.ts'), null);
  assert.equal(portboardScript(''), null);
});

test('isPortboardCommand: bin/portboard, or an entry point of a Portboard checkout; a folder name is not enough', () => {
  assert.equal(isPortboardCommand('node /Users/dev/portboard/bin/portboard start', null, isCheckout), true);
  assert.equal(isPortboardCommand('node src/server.ts', '~/projects/portboard', isCheckout), true, 'deploy/*.service and npm start');
  assert.equal(isPortboardCommand('node src/server.ts', '/home/dev/projects/portboard/.claude/worktrees/feat-x', isCheckout), true, 'a preview in a worktree');
  assert.equal(isPortboardCommand('/usr/bin/node /home/dev/projects/portboard/src/mcp.ts', '/home/dev', isCheckout), true);
  assert.equal(isPortboardCommand('node ./src/remote.ts', '/home/dev/projects/portboard', isCheckout), true);
  // a folder that only looks like Portboard
  assert.equal(isPortboardCommand('node /home/dev/projects/portboard-landing/src/server.ts', null, isCheckout), false);
  assert.equal(isPortboardCommand('node src/server.ts', '/private/tmp/claude-501/-Users-dev-projects-portboard/abc/scratchpad', isCheckout), false);
  assert.equal(isPortboardCommand('node src/server.ts', '/home/dev/projects/worktrees/portboard-integration', isCheckout), false);
  assert.equal(isPortboardCommand('node src/server.ts', null, isCheckout), false, 'a relative path with no working directory');
  assert.equal(isPortboardCommand('node /home/dev/projects/portboard/scripts/x.ts', '/', isCheckout), false);
  // paths with spaces count only through their checkout; a later argument never makes a command Portboard's
  assert.equal(isPortboardCommand('/opt/homebrew/bin/node --max-semi-space-size=16 /Users/dev/My Projects/portboard/bin/portboard start', '/', isCheckout), true);
  assert.equal(isPortboardCommand('node /Users/dev/My Projects/portboard/src/server.ts', null, isCheckout), true);
  assert.equal(isPortboardCommand('node test/fake-api.js --cli /home/dev/projects/portboard/bin/portboard', '/home/dev/projects/portboard', isCheckout), false);
  assert.equal(isPortboardCommand('node app.js --config /home/dev/projects/portboard/src/server.ts', '/home/dev/projects/acme', isCheckout), false);
  assert.equal(isPortboardCommand('vite --port 5173', '/home/dev/projects/portboard', isCheckout), false);
  assert.equal(
    isPortboardCommand('node proxy.js --upstream ../../../portboard/src/server.ts', '/home/dev/projects/acme/x', isCheckout),
    false,
    'a later argument\'s .. does not climb into a Portboard checkout',
  );
});

test('isPortboardProcess: this process, a Portboard unit, or a Portboard process without one; an entry point needs isCheckout', () => {
  assert.equal(isPortboardProcess([{ pid: 4242, unit: null }], { selfPid: 4242 }), true);
  assert.equal(isPortboardProcess([{ pid: 1, unit: 'portboard-remote.service' }], { selfPid: 4242 }), true);
  assert.equal(isPortboardProcess([{ pid: 1, unit: 'shop-web.service' }, { pid: 2, unit: null }], { selfPid: 4242 }), false);
  assert.equal(isPortboardProcess([], { selfPid: 4242 }), false);
  // a launchd agent on a Mac: a plain process, no unit, and not this (stdio MCP) process
  const launchd = { pid: 900, unit: null, cmdline: 'node /Users/dev/portboard/bin/portboard start', cwd: '/Users/dev/portboard' };
  assert.equal(isPortboardProcess([launchd], { selfPid: 4242 }), true);
  const preview = { pid: 901, unit: null, cmdline: 'node src/server.ts', cwd: '~/projects/portboard' };
  assert.equal(isPortboardProcess([preview], { selfPid: 4242, isCheckout }), true);
  assert.equal(isPortboardProcess([preview], { selfPid: 4242 }), false, 'without isCheckout an entry point is not trusted');
  assert.equal(isPortboardProcess([{ ...preview, cwd: '~/projects/acme' }], { selfPid: 4242, isCheckout }), false);
});
