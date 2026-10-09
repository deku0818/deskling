// Shared collector plumbing: config, a crash-safe local spool, and a batch sender.
// Plain JavaScript with no dependencies so it runs on any machine with Node 18+.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, unlinkSync, rmdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const HOME = process.env.DESKLING_HOME ?? path.join(homedir(), '.deskling');
const SPOOL = path.join(HOME, 'spool');
const LOCK = path.join(HOME, 'flush.lock');
const MAX_SPOOL = 2000;
const BATCH = 100;

export function loadConfig() {
  try {
    const config = JSON.parse(readFileSync(path.join(HOME, 'config.json'), 'utf8'));
    return config.hubUrl && config.token && config.source ? config : null;
  } catch {
    return null;
  }
}

export async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

// Writes one event to the spool. File names sort by time, so flushing keeps the original order.
export function enqueue(config, sessionId, kind, payload) {
  mkdirSync(SPOOL, { recursive: true });
  const event = { eventId: randomUUID(), provider: config.provider ?? 'claude', source: config.source, ts: Date.now(), sessionId, kind, [kind]: payload };
  const name = `${String(event.ts).padStart(15, '0')}-${event.eventId}.json`;
  const tmp = path.join(SPOOL, `.${name}`);
  writeFileSync(tmp, JSON.stringify(event));
  renameSync(tmp, path.join(SPOOL, name));
}

function acquireLock() {
  try {
    mkdirSync(LOCK);
    return true;
  } catch {
    // A flusher killed mid-run leaves its lock behind; reclaim it after a while.
    try {
      if (Date.now() - statSync(LOCK).mtimeMs > 30_000) {
        rmdirSync(LOCK);
        mkdirSync(LOCK);
        return true;
      }
    } catch {}
    return false;
  }
}

// Sends spooled events in batches. Safe to call from many processes; the hub drops duplicates.
export async function flush(config, timeoutMs = 3000) {
  if (!acquireLock()) return;
  try {
    let files = readdirSync(SPOOL).filter(f => f.endsWith('.json')).sort();
    // Keep the spool bounded while the hub is unreachable for a long time.
    for (const f of files.slice(0, Math.max(0, files.length - MAX_SPOOL))) unlinkSync(path.join(SPOOL, f));
    files = files.slice(-MAX_SPOOL);
    while (files.length) {
      const batch = files.splice(0, BATCH);
      const events = [];
      for (const f of batch) {
        try {
          events.push(JSON.parse(readFileSync(path.join(SPOOL, f), 'utf8')));
        } catch {}
      }
      const res = await fetch(new URL('/ingest', config.hubUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.token}` },
        body: JSON.stringify({ events }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return;
      for (const f of batch) {
        try {
          unlinkSync(path.join(SPOOL, f));
        } catch {}
      }
    }
  } catch {
    // Network or hub errors: events stay spooled for the next flush.
  } finally {
    try {
      rmdirSync(LOCK);
    } catch {}
  }
}

// Claims the next quota read if the last one is older than the interval. Many hooks run at once,
// so the claim is taken under a lock and stamped before the read starts.
export function claimUsageRead(intervalMs) {
  const stamp = path.join(HOME, 'usage-last');
  const lock = path.join(HOME, 'usage.lock');
  const due = () => {
    try {
      return Date.now() - statSync(stamp).mtimeMs >= intervalMs;
    } catch {
      return true;
    }
  };
  if (!due()) return false;
  try {
    mkdirSync(lock);
  } catch {
    try {
      if (Date.now() - statSync(lock).mtimeMs > 60_000) rmdirSync(lock);
    } catch {}
    return false;
  }
  try {
    if (!due()) return false;
    writeFileSync(stamp, String(Date.now()));
    return true;
  } finally {
    rmdirSync(lock);
  }
}
