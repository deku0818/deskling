import path from 'node:path';
import { fileURLToPath } from 'node:url';

const hubDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required (see hub/.env.example)`);
  return value;
}

function minutes(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number of minutes`);
  return value * 60_000;
}

export function loadConfig() {
  return {
    port: Number(process.env.PORT ?? 8787),
    host: process.env.HOST ?? '0.0.0.0',
    dataDir: path.resolve(hubDir, process.env.DATA_DIR ?? 'data'),
    staticDir: path.resolve(hubDir, process.env.STATIC_DIR ?? '..'),
    ingestToken: required('INGEST_TOKEN'),
    displayToken: required('DISPLAY_TOKEN'),
    logEvents: process.env.LOG_EVENTS === '1',
    mdns: process.env.MDNS !== '0',
    store: {
      sessionRetainMs: minutes('SESSION_RETAIN_MIN', 30),
      silentSuspectMs: minutes('SILENT_SUSPECT_MIN', 10),
    },
  };
}

export type Config = ReturnType<typeof loadConfig>;
