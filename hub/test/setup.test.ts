import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { request as httpRequest, createServer } from 'node:http';
import { SetupService } from '../src/setup.ts';
import { WebSocket } from 'ws';

test('management rejects cross-site access; approved device credentials are read-only and work for both providers', { timeout: 15000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'deskling-setup-test-'));
  const child = spawn(process.execPath, ['src/server.ts'], {
    cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
    env: { ...process.env, PORT: '0', HOST: '127.0.0.1', MDNS: '0', DATA_DIR: dir, INGEST_TOKEN: 'ingest-test', DISPLAY_TOKEN: 'display-test' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const base: string = await new Promise((resolve, reject) => {
      child.once('error', reject); child.stdout.on('data', c => { const match = String(c).match(/listening on (http:\/\/127\.0\.0\.1:\d+)/); if (match) resolve(match[1]); });
      child.once('exit', c => reject(new Error(`server exited: ${c}`)));
    });
    const post = (url: string, body: object, headers: Record<string, string> = {}) => fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    assert.equal((await fetch(base + '/setup.html')).status, 200);
    assert.equal((await fetch(base + '/assets%2f..%2fhub%2f.env')).status, 404);
    assert.equal((await fetch(base + '/assets/fonts/setup-pixel.woff2')).status, 200);
    const foreignHost = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(base + '/manage/info', { headers: { host: 'attacker.invalid' } }, response => { response.resume(); resolve(response.statusCode); });
      request.on('error', reject); request.end();
    });
    assert.equal(foreignHost, 403);
    assert.equal((await post('/manage/pairing/start', {}, { origin: 'https://attacker.invalid' })).status, 403);
    assert.equal((await fetch(base + '/manage/info', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
    assert.equal((await fetch(base + '/manage/pairing/start', { method: 'POST', body: '{}' })).status, 403);
    assert.equal((await post('/pair/request', { deviceId: 'test-device', name: 'Deskling' })).status, 400);
    assert.equal((await post('/manage/pairing/start', {}, { origin: base })).status, 200);
    const request: any = await (await post('/pair/request', { deviceId: 'test-device', name: 'Deskling' })).json();
    const pending: any = await (await fetch(base + '/manage/info')).json();
    assert.equal(pending.pending[0].code, request.code); assert.equal(JSON.stringify(pending).includes(request.secret), false);
    assert.equal((await fetch(base + `/pair/status?id=${request.id}`, { headers: { authorization: 'Bearer invalid' } })).status, 404);
    await post('/manage/pairing/approve', { id: request.id });
    const approved: any = await (await fetch(base + `/pair/status?id=${request.id}`, { headers: { authorization: `Bearer ${request.secret}` } })).json();
    assert.equal(approved.approved, true);
    const headers = { authorization: `Bearer ${approved.token}` };
    for (const provider of ['claude', 'codex']) {
      const snapshot: any = await (await fetch(base + `/snapshot?provider=${provider}`, { headers })).json(); assert.equal(snapshot.provider, provider);
      const socket = new WebSocket(base.replace('http:', 'ws:') + `/ws?provider=${provider}`, { headers });
      const [data] = await once(socket, 'message'); assert.equal(JSON.parse(String(data)).provider, provider); socket.terminate();
    }
    assert.equal((await post('/ingest', { events: [] }, headers)).status, 401);
    assert.equal((await post('/pair/activate', {}, headers)).status, 200);
    assert.equal((await post('/pair/activate', {}, headers)).status, 200);
    const result: any = await (await fetch(base + '/manage/info')).json(); assert.equal(result.devices.length, 1); assert.equal(result.pending.length, 0);
    assert.equal(JSON.stringify(result).includes(approved.token), false);
    assert.equal((await post('/manage/usb/open', { path: '/etc/passwd' })).status, 400);
  } finally {
    child.kill(); await once(child, 'exit').catch(() => {}); rmSync(dir, { recursive: true, force: true });
  }
});

test('two independent Hubs never share device credentials or pairing approvals', { timeout: 15000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'deskling-two-hubs-'));
  const children: ReturnType<typeof spawn>[] = [];
  async function start(label: string) {
    const child = spawn(process.execPath, ['src/server.ts'], {
      cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
      env: { ...process.env, PORT: '0', HOST: '127.0.0.1', MDNS: '0', DATA_DIR: path.join(dir, label), INGEST_TOKEN: label + '-ingest', DISPLAY_TOKEN: label + '-display' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    return await new Promise<string>((resolve, reject) => {
      child.once('error', reject); child.stdout!.on('data', c => { const m = String(c).match(/listening on (http:\/\/127\.0\.0\.1:\d+)/); if (m) resolve(m[1]); });
      child.once('exit', () => reject(Error('test Hub exited')));
    });
  }
  try {
    const [local, remote] = await Promise.all([start('local'), start('remote')]);
    const post = (base: string, route: string, body: object, token?: string) => fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? {authorization:'Bearer '+token} : {}) }, body: JSON.stringify(body) });
    const snapshot = (base: string, token: string) => fetch(base + '/snapshot?provider=codex', { headers: { authorization:'Bearer '+token } });
    assert.equal((await snapshot(remote, 'remote-display')).status, 200);
    assert.equal((await snapshot(remote, 'local-display')).status, 401);
    await post(remote, '/manage/pairing/start', {});
    const rejected: any = await (await post(remote, '/pair/request', {deviceId:'rejected',name:'Deskling'})).json();
    assert.equal((await post(remote, '/manage/pairing/reject', {id:rejected.id})).status, 200);
    assert.equal((await fetch(remote + '/pair/status?id=' + rejected.id, {headers:{authorization:'Bearer '+rejected.secret}})).status, 404);
    const request: any = await (await post(remote, '/pair/request', {deviceId:'remote-device',name:'Deskling'})).json();
    assert.equal((await post(local, '/manage/pairing/approve', {id:request.id})).status, 400);
    assert.equal((await post(remote, '/manage/pairing/approve', {id:request.id})).status, 200);
    const approved: any = await (await fetch(remote + '/pair/status?id=' + request.id, {headers:{authorization:'Bearer '+request.secret}})).json();
    assert.equal((await snapshot(remote, approved.token)).status, 200);
    assert.equal((await snapshot(local, approved.token)).status, 401);
    assert.equal((await post(remote, '/pair/activate', {}, approved.token)).status, 200);
    const localState: any = await (await fetch(local + '/manage/info')).json();
    const remoteState: any = await (await fetch(remote + '/manage/info')).json();
    assert.equal(localState.devices.length, 0); assert.equal(localState.pending.length, 0); assert.equal(remoteState.devices.length, 1);
    assert.notEqual(localState.name, ''); assert.notEqual(remoteState.devices[0].deviceId, 'rejected');
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit').catch(() => {}); }
    rmSync(dir, {recursive:true,force:true});
  }
});


test('USB acknowledgement loss resumes only the matching newly accepted job', async () => {
  for (const mode of ['matching', 'old-job', 'other-target']) {
    const dir = mkdtempSync(path.join(tmpdir(), 'deskling-usb-ack-'));
    const setup = new SetupService(dir, 0);
    const before = { job: 7, stage: 'done', busy: false, configured: true, protocol: 2, ssid: 'Saved', hub: 'http://old.example', hubType: 'local', deviceId: 'test-device' };
    let accepted = false;
    (setup as any).usb = { close() {}, async command(op: string) {
      if (op === 'configure') { accepted = true; throw Error('设备响应超时，请重试。'); }
      if (!accepted || mode === 'old-job') return before;
      return { ...before, job: 8, busy: true, stage: 'pair_wait', targetHubType: 'remote', targetHub: mode === 'other-target' ? 'https://other.example' : 'https://remote.example' };
    }};
    const server = createServer((req, res) => { void setup.handle(req, res, new URL(req.url!, 'http://' + req.headers.host)); });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const port = (server.address() as any).port; setup.setPort(port);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/manage/usb/configure`, { method: 'POST', headers: {'content-type':'application/json'}, body:JSON.stringify({hubType:'remote',hub:'https://remote.example',keepWifi:true}) });
      const result: any = await response.json();
      assert.equal(response.status, mode === 'matching' ? 202 : 400);
      if (mode === 'matching') assert.equal(result.job, 8); else assert.match(result.error, /超时/);
    } finally { setup.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir,{recursive:true,force:true}); }
  }
});
