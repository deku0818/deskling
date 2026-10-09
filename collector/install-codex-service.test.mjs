import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LABEL, manageService, servicePlist } from './install-codex-service.mjs';

test('service uses absolute paths, escapes XML and survives terminal exit', () => {
  const text = servicePlist('/Users/test/A & B', '/node <22>/bin/node', '/bin:/A&B');
  assert.ok(text.includes('<string>/node &lt;22&gt;/bin/node</string>'));
  assert.ok(text.includes('<string>/Users/test/A &amp; B/bin/deskling-codex.mjs</string>'));
  assert.ok(text.includes('<key>DESKLING_HOME</key><string>/Users/test/A &amp; B</string>'));
  assert.ok(text.includes('<key>KeepAlive</key><true/>'));
  assert.ok(text.includes('<key>RunAtLoad</key><true/>'));
});

test('service install, reinstall and uninstall preserve account config and hooks', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'deskling-service-test-'));
  const home = path.join(root, 'collector'), agentsDir = path.join(root, 'agents');
  const calls = [];
  let loaded = false;
  const run = args => {
    calls.push(args);
    if (args[0] === 'print') return { status: loaded ? 0 : 113 };
    loaded = args[0] === 'bootstrap';
    return { status: 0 };
  };
  const options = { home, agentsDir, uid: 123, nodeBin: '/absolute/node', config: { hubUrl: 'http://localhost:8787', token: 'secret', source: 'mac' }, run };
  try {
    const plist = manageService(options);
    assert.equal(loaded, true);
    assert.ok(existsSync(path.join(home, 'bin', 'deskling-codex.mjs')));
    assert.ok(!readFileSync(plist, 'utf8').includes('secret'));
    manageService(options);
    assert.ok(calls.some(args => args[0] === 'bootout' && args[1] === `gui/123/${LABEL}`));
    assert.ok(!existsSync(path.join(home, 'config.json')));
    assert.ok(!existsSync(path.join(home, 'hooks.json')));
    manageService({ ...options, uninstall: true });
    assert.equal(loaded, false);
    assert.ok(!existsSync(plist));
    assert.ok(existsSync(path.join(home, 'bin', 'deskling-codex.mjs')));
    manageService({ ...options, uninstall: true });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a failed service bootstrap is reported', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'deskling-service-failure-'));
  try {
    assert.throws(() => manageService({ home: root, agentsDir: path.join(root, 'agents'), uid: 123,
      config: { hubUrl: 'http://localhost', token: 'secret', source: 'mac' },
      run: args => ({ status: args[0] === 'bootstrap' ? 5 : 113, stderr: 'bootstrap failed' }),
    }), /bootstrap failed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
