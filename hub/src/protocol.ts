// Wire formats shared by collectors, the hub and every display (web page, ESP32).
// Bump SNAPSHOT_VERSION whenever a display would need code changes to read a snapshot.

export const SNAPSHOT_VERSION = 2;
export const MAX_SESSIONS = 12;
export const MAX_TITLE_CHARS = 64;
export const WS_PATH = '/ws';
export const PROVIDERS = ['claude', 'codex'] as const;
export type Provider = typeof PROVIDERS[number];
export function isProvider(value: unknown): value is Provider { return value === 'claude' || value === 'codex'; }

// ---- Ingest: collector -> hub -------------------------------------------------

export interface HookPayload {
  event: string;
  state?: SessionState;
  tool?: string;
  notificationType?: string;
  errorType?: string;
  reason?: string;
  source?: string;
  agentId?: string;
  title?: string;
  prompt?: string;
}

// Normalized quota windows: Claude get_usage or Codex account/rateLimits/read.
export interface UsageWindow {
  utilization?: number | null; // percent used
  resets_at?: string | null; // ISO 8601
}

export interface UsagePayload {
  five_hour?: UsageWindow | null;
  seven_day?: UsageWindow | null;
  model_scoped?: (UsageWindow & { display_name?: string })[];
}

interface IngestBase {
  provider?: Provider; // legacy collectors default to Claude
  eventId: string;
  source: string;
  ts: number; // collector clock, milliseconds
}

export interface HookEvent extends IngestBase {
  kind: 'hook';
  sessionId: string;
  hook: HookPayload;
}

// Account quota read by a collector; not tied to any session.
export interface UsageEvent extends IngestBase {
  kind: 'usage';
  usage: UsagePayload;
}

export type IngestEvent = HookEvent | UsageEvent;

export interface IngestBatch {
  events: IngestEvent[];
}

// ---- Display: hub -> displays -------------------------------------------------

export type SessionState = 'working' | 'waiting' | 'done' | 'error' | 'limited' | 'stopped' | 'idle';
export type OverallState = 'working' | 'waiting' | 'done' | 'error' | 'stopped' | 'idle';

export interface SnapshotSession {
  id: string;
  title: string;
  state: SessionState;
  since: number; // unix seconds
  stale: boolean;
}

export interface SnapshotQuota {
  left: number; // remaining percent, 0-100
  resetAt: number | null; // unix seconds
  at: number; // unix seconds when the value was observed
}

export interface Snapshot {
  provider: Provider;
  v: number;
  seq: number;
  ts: number;
  overall: OverallState;
  sessions: SnapshotSession[];
  quota: { '5h': SnapshotQuota | null; week: SnapshotQuota | null; fable: SnapshotQuota | null };
  collectors: { source: string; lastSeen: number }[];
}
