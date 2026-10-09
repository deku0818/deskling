import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { WebSocket } from 'ws';

test('HTTP and WebSocket subscriptions publish only the selected provider', { timeout: 15000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'deskling-hub-test-'));
  const child = spawn(process.execPath, ['src/server.ts'], {
    cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
    env: { ...process.env, PORT: '0', HOST: '127.0.0.1', MDNS: '0', DATA_DIR: dir, INGEST_TOKEN: 'ingest-test', DISPLAY_TOKEN: 'display-test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const sockets: WebSocket[] = [];
  try {
    const base: string = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.stdout.on('data', chunk => {
        const match = String(chunk).match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);
        if (match) resolve(match[1]);
      });
      child.once('exit', code => reject(new Error(`server exited: ${code}`)));
    });
    // Page sources moved to web/, while public URLs and shared assets stay stable.
    for (const route of ['/', '/index.html', '/setup.html']) {
      const response = await fetch(base + route);
      assert.equal(response.status, 200, route);
      assert.match(response.headers.get('content-type') ?? '', /text\/html/);
    }
    for (const route of ['/assets/fonts/deck-pixel.woff2', '/assets/pets/clawd/sheet.webp', '/assets/pets/clawd/pet.js']) {
      assert.equal((await fetch(base + route)).status, 200, route);
    }
    for (const route of ['/dual-agent-demo.html', '/setup-demo.html', '/animations.html', '/README.md', '/web/index.html', '/hub/.env', '/assets/%2e%2e%2fhub%2fsrc%2fserver.ts']) {
      assert.equal((await fetch(base + route)).status, 404, route);
    }
    const frames = { claude: [] as any[], codex: [] as any[] };
    for (const provider of ['claude', 'codex'] as const) {
      const socket = new WebSocket(base.replace('http:', 'ws:') + `/ws?token=display-test&provider=${provider}`);
      sockets.push(socket);
      socket.on('message', data => frames[provider].push(JSON.parse(String(data))));
      await once(socket, 'message');
    }
    const response = await fetch(base + '/ingest', { method: 'POST', headers: { authorization: 'Bearer ingest-test', 'content-type': 'application/json' },
      body: JSON.stringify({ events: ['claude', 'codex'].map(provider => ({ provider, source: 'mac', ts: Date.now(), eventId: provider,
        kind: 'hook', sessionId: 'same', hook: { event: 'Status', state: provider === 'claude' ? 'waiting' : 'working', title: provider } })) }) });
    assert.equal(response.status, 200);
    await Promise.all(sockets.map(socket => once(socket, 'message')));
    for (const provider of ['claude', 'codex'] as const) {
      const snapshot: any = await (await fetch(base + `/snapshot?token=display-test&provider=${provider}`)).json();
      assert.equal(snapshot.v, 2); assert.equal(snapshot.provider, provider);
      assert.deepEqual(snapshot.sessions.map((s: any) => s.title), [provider]);
      assert.ok(frames[provider].every(frame => frame.provider === provider));
      assert.deepEqual(frames[provider].at(-1).sessions.map((s: any) => s.title), [provider]);
    }
    assert.equal((await fetch(base + '/snapshot?token=display-test&provider=other')).status, 400);
    assert.equal((await fetch(base + '/snapshot?provider=codex')).status, 401);
    const legacy: any = await (await fetch(base + '/snapshot?token=display-test')).json();
    assert.equal(legacy.provider, 'claude');
  } finally {
    for (const socket of sockets) socket.terminate();
    child.kill(); await once(child, 'exit').catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});
