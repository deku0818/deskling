import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PairingStore } from '../src/pairing.ts';

test('device credentials survive restart, retain the old credential on failure and replace it only after activation', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'deskling-pair-test-'));
  try {
    const store = new PairingStore(dir), old = store.issue('device-1', 'Deskling');
    store.activateToken(old.token);
    const failed = store.issue('device-1', 'Deskling'); store.revoke(failed.id);
    assert.equal(store.accepts(old.token), true); assert.equal(store.accepts(failed.token), false);
    const next = store.issue('device-1', 'Deskling');
    assert.equal(store.accepts(old.token), true); assert.equal(store.accepts(next.token), true);
    store.activateToken(next.token);
    assert.equal(store.accepts(old.token), false); assert.equal(store.accepts(next.token), true);
    const restored = new PairingStore(dir);
    assert.equal(restored.hubId, store.hubId); assert.equal(restored.accepts(next.token), true);
    const file = path.join(dir, 'devices.json');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(readFileSync(file, 'utf8').includes(next.token), false);
    assert.equal(JSON.stringify(store.list()).includes('token'), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('phone pairing requires a local pairing window, a request secret and approval; abandoned credentials expire', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'deskling-pair-test-')); const now = Date.now;
  try {
    let clock = now(); Date.now = () => clock;
    const store = new PairingStore(dir);
    assert.throws(() => store.request('device-1', 'Deskling'), /closed/);
    store.begin(); const request = store.request('device-1', 'Deskling');
    assert.match(request.code, /^\d{6}$/); assert.equal(store.status(request.id, 'wrong'), null);
    assert.equal(store.status(request.id, request.secret)?.token, undefined);
    assert.equal(JSON.stringify(store.pending()).includes(request.secret), false);
    store.approve(request.id); const token = store.status(request.id, request.secret)!.token!;
    assert.equal(store.accepts(token), true);
    clock += 300_001;
    assert.equal(store.accepts(token), false); assert.equal(store.status(request.id, request.secret), null);
    assert.equal(store.open, false);
  } finally { Date.now = now; rmSync(dir, { recursive: true, force: true }); }
});
