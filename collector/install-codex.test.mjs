import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('Codex installer is idempotent, uninstall preserves unrelated hooks, observer is silent', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'deskling-install-test-'));
  const home = path.join(root, 'collector'), codex = path.join(root, 'codex');
  mkdirSync(home); mkdirSync(codex);
  const existing = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'my-existing-hook' }] }] } };
  writeFileSync(path.join(codex, 'hooks.json'), JSON.stringify(existing));
  writeFileSync(path.join(home, 'config.json'), JSON.stringify({ hubUrl: 'http://127.0.0.1:1', token: 'test-token', source: 'mac' }));
  const env = { ...process.env, DESKLING_HOME: home, DESKLING_CODEX_HOME: codex };
  const installer = path.join(path.dirname(fileURLToPath(import.meta.url)), 'install-codex.mjs');
  try {
    for (let i = 0; i < 2; i++) {
      const result = spawnSync(process.execPath, [installer], { env, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    }
    const installed = JSON.parse(readFileSync(path.join(codex, 'hooks.json'), 'utf8'));
    assert.equal(installed.hooks.Stop.length, 2);
    assert.equal(installed.hooks.Stop[0].hooks[0].command, 'my-existing-hook');
    const observer = spawnSync(process.execPath, [path.join(home, 'bin', 'deskling-codex-hook.mjs')], {
      env, encoding: 'utf8', input: JSON.stringify({ session_id: 'thread', hook_event_name: 'PermissionRequest', tool_input: { secret: 'not-for-upload' } }),
    });
    assert.equal(observer.status, 0); assert.equal(observer.stdout, ''); assert.equal(observer.stderr, '');
    const files = readdirSync(path.join(home, 'spool')).filter(file => file.endsWith('.json'));
    assert.equal(files.length, 1);
    const event = JSON.parse(readFileSync(path.join(home, 'spool', files[0]), 'utf8'));
    assert.equal(event.provider, 'codex'); assert.equal(event.hook.state, 'waiting');
    assert.ok(!JSON.stringify(event).includes('not-for-upload'));
    const uninstalled = spawnSync(process.execPath, [installer, '--uninstall'], { env, encoding: 'utf8' });
    assert.equal(uninstalled.status, 0);
    assert.deepEqual(JSON.parse(readFileSync(path.join(codex, 'hooks.json'), 'utf8')), existing);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
