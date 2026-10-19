import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frameworkOf, planStart, portArgs, unitFor, UNIT_PREFIX } from '../src/core/devservers.ts';

test('framework comes from the script command, not the dependencies', () => {
  assert.equal(frameworkOf('next dev --turbo'), 'next');
  assert.equal(frameworkOf('vite'), 'vite');
  assert.equal(frameworkOf('astro dev'), 'astro');
  assert.equal(frameworkOf('node server.js'), 'generic');
});

test('port flags per framework bind to loopback', () => {
  assert.deepEqual(portArgs('vite', 5281), ['--port', '5281', '--strictPort', '--host', '127.0.0.1']);
  assert.deepEqual(portArgs('next', 3001), ['-p', '3001', '-H', '127.0.0.1']);
  assert.deepEqual(portArgs('generic', 4000), []);
});

test('unit names are stable per directory, safe and prefixed', () => {
  const a = unitFor('/home/dev/projects/worktrees/shop-web-17860689da5dd0b4/3d-redesign-design-88cb3d');
  assert.equal(a, unitFor('/home/dev/projects/worktrees/shop-web-17860689da5dd0b4/3d-redesign-design-88cb3d'));
  assert.ok(a.startsWith(UNIT_PREFIX) && a.endsWith('.service'));
  assert.match(a, /^[a-z0-9-]+\.service$/);
  assert.notEqual(a, unitFor('/home/dev/projects/shop-web'));
});

test('planStart: npm run <script> -- <flags>, PORT env, working directory, no shell', () => {
  const p = planStart({ dir: '/w/x', label: 'shop-web@main', script: 'dev', command: 'vite', port: 5300, nodeBin: '/n/bin' });
  assert.equal(p.fw, 'vite');
  assert.ok(p.args.includes('--property=WorkingDirectory=/w/x'));
  assert.ok(p.args.includes('--setenv=PORT=5300'));
  assert.ok(p.args.includes('--collect'));
  const i = p.args.indexOf('--');
  assert.deepEqual(p.args.slice(i + 1), ['/n/bin/npm', 'run', 'dev', '--', '--port', '5300', '--strictPort', '--host', '127.0.0.1']);
  const g = planStart({ dir: '/w/y', label: 'x@b', script: 'start', command: 'node s.js', port: 4000, nodeBin: '/n/bin' });
  assert.deepEqual(g.args.slice(g.args.indexOf('--') + 1), ['/n/bin/npm', 'run', 'start']);
  assert.match(p.description, /:5300/);
});
