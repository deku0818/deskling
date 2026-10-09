import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync, createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { loadConfig } from './config.ts';
import { isValidEvent, type PersistedState } from './state.ts';
import { ProviderStore, type ProviderState } from './providers.ts';
import { WS_PATH, PROVIDERS, isProvider, type Provider, type IngestEvent, type Snapshot } from './protocol.ts';
import { SetupService } from './setup.ts';

const config = loadConfig();
const store = new ProviderStore(config.store);
const statePath = path.join(config.dataDir, 'state.json');
const MAX_BODY = 256 * 1024;

mkdirSync(config.dataDir, { recursive: true });
const setup = new SetupService(config.dataDir, config.port);
try {
  store.load(JSON.parse(readFileSync(statePath, 'utf8')) as ProviderState | PersistedState);
  console.log(`restored state from ${statePath}`);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('ignoring unreadable state file:', error);
}

// ---- snapshot publishing ------------------------------------------------------

let seq = 0;
const current = new Map<Provider, Snapshot>();
const lastKeys = new Map<Provider, string>();
let publishTimer: NodeJS.Timeout | null = null;
let saveTimer: NodeJS.Timeout | null = null;
const sockets = new Map<WebSocket, Provider>();
const deviceTokens = new WeakMap<WebSocket, string>();

// Rebuilds the snapshot and pushes it only when its content changed.
function publish() {
  publishTimer = null;
  const now = Date.now();
  store.prune(now);
  let changed = false;
  for (const provider of PROVIDERS) {
    const next = store.snapshot(provider, seq, now);
    const key = JSON.stringify({ ...next, seq: 0, ts: 0 });
    if (key === lastKeys.get(provider)) continue;
    changed = true;
    lastKeys.set(provider, key);
    const snapshot = { ...next, seq: ++seq };
    current.set(provider, snapshot);
    const message = JSON.stringify(snapshot);
    for (const [ws, selected] of sockets) if (selected === provider && ws.readyState === ws.OPEN) ws.send(message);
  }
  if (changed) scheduleSave();
}

function schedulePublish() {
  publishTimer ??= setTimeout(publish, 100);
}

function save() {
  saveTimer = null;
  const tmp = statePath + '.tmp';
  writeFileSync(tmp, JSON.stringify(store));
  renameSync(tmp, statePath);
}

function scheduleSave() {
  saveTimer ??= setTimeout(save, 2000);
}

// Staleness and pruning depend on time passing, not only on new events.
setInterval(publish, 5000).unref();
publish();

// ---- HTTP ---------------------------------------------------------------------

function tokenMatches(given: string | null | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function requestToken(req: IncomingMessage, url: URL): string | null {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  return url.searchParams.get('token');
}

// One line per ingested event, for checking which hooks Claude Code actually fires.
function describe(e: IngestEvent): string {
  const time = new Date(e.ts).toLocaleTimeString();
  if (e.kind === 'usage') return `${time} ${e.source} usage`;
  const { event, ...rest } = e.hook;
  delete rest.prompt;
  return `${time} ${e.source}:${e.sessionId.slice(0, 8)} ${event} ${JSON.stringify(rest)}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webp': 'image/webp', '.css': 'text/css; charset=utf-8', '.gif': 'image/gif', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

// Public URLs stay stable while page sources live in web/.
// Serve only the two application pages and shared assets.
function serveStatic(res: ServerResponse, pathname: string): boolean {
  const rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname).replace(/^\/+/, '');
  const page = rel === 'index.html' || rel === 'setup.html';
  const file = path.resolve(config.staticDir, page ? path.join('web', rel) : rel);
  const allowed = page ||
    (rel.startsWith('assets/') && file.startsWith(path.resolve(config.staticDir, 'assets') + path.sep));
  if (!allowed || !file.startsWith(config.staticDir + path.sep)) return false;
  try {
    if (!statSync(file).isFile()) return false;
  } catch {
    return false;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
  createReadStream(file).pipe(res);
  return true;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://hub');
  try {
    if (await setup.handle(req, res, url)) return;
    if (req.method === 'POST' && url.pathname === '/ingest') {
      if (!tokenMatches(requestToken(req, url), config.ingestToken)) return sendJson(res, 401, { error: 'unauthorized' });
      const body = JSON.parse(await readBody(req)) as { events?: unknown };
      const events = Array.isArray(body.events) ? body.events : [];
      let accepted = 0;
      const now = Date.now();
      for (const event of events) {
        if (!isValidEvent(event)) continue;
        if (config.logEvents) console.log(describe(event));
        store.apply(event, now);
        accepted++;
      }
      if (accepted) { schedulePublish(); scheduleSave(); }
      return sendJson(res, 200, { accepted, rejected: events.length - accepted });
    }
    if (req.method === 'GET' && url.pathname === '/snapshot') {
      if (!tokenMatches(requestToken(req, url), config.displayToken) && !setup.pairing.accepts(requestToken(req, url))) return sendJson(res, 401, { error: 'unauthorized' });
      const provider = url.searchParams.get('provider') ?? 'claude';
      if (!isProvider(provider)) return sendJson(res, 400, { error: 'invalid provider' });
      return sendJson(res, 200, current.get(provider));
    }
    if (req.method === 'GET' && url.pathname === '/healthz') return sendJson(res, 200, { ok: true, seq });
    if (req.method === 'GET' && serveStatic(res, url.pathname)) return;
    sendJson(res, 404, { error: 'not found' });
  } catch (error) {
    sendJson(res, 400, { error: error instanceof Error ? error.message : 'bad request' });
  }
});

// ---- WebSocket ----------------------------------------------------------------

const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
const alive = new WeakSet<WebSocket>();

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://hub');
  if (url.pathname !== WS_PATH || (!tokenMatches(requestToken(req, url), config.displayToken) && !setup.pairing.accepts(requestToken(req, url)))) {
    socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return;
  }
  const provider = url.searchParams.get('provider') ?? 'claude';
  if (!isProvider(provider)) { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
  wss.handleUpgrade(req, socket, head, ws => {
    sockets.set(ws, provider);
    const token = requestToken(req, url);
    if (token && !tokenMatches(token, config.displayToken)) deviceTokens.set(ws, token);
    alive.add(ws);
    ws.on('pong', () => alive.add(ws));
    ws.on('close', () => sockets.delete(ws));
    ws.on('error', () => ws.terminate());
    ws.send(JSON.stringify(current.get(provider)));
  });
});

setInterval(() => {
  for (const ws of sockets.keys()) {
    const token = deviceTokens.get(ws);
    if (token && !setup.pairing.accepts(token)) { ws.terminate(); continue; }
    if (!alive.has(ws)) { ws.terminate(); continue; }
    alive.delete(ws);
    ws.ping();
  }
}, 20_000).unref();

let stopAdvertising: (() => void) | null = null;
server.listen(config.port, config.host, () => {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  setup.setPort(port);
  console.log(`deskling hub listening on http://${config.host}:${port}`);
  // Loaded only when enabled, so a public deployment (MDNS=0) never loads the mDNS stack.
  if (config.mdns) void import('./mdns.ts').then(m => { stopAdvertising = m.advertise(port, setup.pairing.hubId); });
});

function shutdown() {
  setup.close();
  stopAdvertising?.();
  if (saveTimer) clearTimeout(saveTimer);
  save();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
