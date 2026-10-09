import {
  MAX_SESSIONS, MAX_TITLE_CHARS, SNAPSHOT_VERSION, isProvider,
  type HookPayload, type IngestEvent, type OverallState, type SessionState, type Snapshot, type SnapshotQuota,
} from './protocol.ts';
import { parseUsage } from './usage.ts';

export interface StoreOptions {
  sessionRetainMs: number; // keep abandoned sessions (and end markers) this long
  silentSuspectMs: number; // a working session with no hook events this long is marked stale
  forgetAfterMs: number; // drop any session not heard from this long
}

export const defaultStoreOptions: StoreOptions = {
  sessionRetainMs: 30 * 60_000,
  silentSuspectMs: 10 * 60_000,
  forgetAfterMs: 12 * 3600_000,
};

type TitleSource = 'name' | 'prompt';
export type QuotaKey = '5h' | 'week' | 'fable';

interface Session {
  key: string;
  source: string;
  sessionId: string;
  title: string | null;
  titleSource: TitleSource | null;
  state: SessionState;
  since: number; // hub ms when state last changed
  firstSeen: number;
  lastHookTs: number; // collector ms of the newest applied hook, for ordering
  lastHookAt: number; // hub ms
  lastSeenAt: number; // hub ms, any event
}

interface QuotaValue {
  left: number | null; // null: the account reported no such window
  resetAt: number | null;
  observedMs: number; // collector ms when read
}

export interface PersistedState {
  sessions: Session[];
  ended?: Record<string, { ts: number; at: number }>;
  collectors: Record<string, number>;
  quota: Partial<Record<QuotaKey, QuotaValue>>;
}

// Tools whose execution means Claude is waiting for the user to answer.
const INTERACTIVE_TOOLS = new Set(['AskUserQuestion']);
const WAITING_NOTIFICATIONS = new Set(['permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input']);
const RESUMED_NOTIFICATIONS = new Set(['elicitation_complete', 'elicitation_response']);
const DEDUPE_LIMIT = 5000;

// Returns the next state for a hook event, or null to keep the current one.
export function transition(hook: HookPayload, current: SessionState): SessionState | null {
  switch (hook.event) {
    case 'Status':
      return hook.state && ['working', 'waiting', 'done', 'error', 'limited', 'stopped', 'idle'].includes(hook.state) ? hook.state : null;
    case 'SessionStart':
      return current === 'stopped' ? 'idle' : null;
    case 'UserPromptSubmit':
      return 'working';
    case 'PreToolUse':
      return hook.tool && INTERACTIVE_TOOLS.has(hook.tool) ? 'waiting' : 'working';
    case 'PostToolUse':
    case 'PostToolUseFailure':
      return 'working';
    case 'PermissionRequest':
      return 'waiting';
    case 'Notification': {
      const type = hook.notificationType ?? '';
      if (WAITING_NOTIFICATIONS.has(type)) return 'waiting';
      if (RESUMED_NOTIFICATIONS.has(type)) return 'working';
      // Claude is idle at the prompt while we still think it works: the turn was interrupted.
      if (type === 'idle_prompt' && current === 'working') return 'idle';
      return null;
    }
    case 'Stop':
      return hook.agentId ? null : 'done';
    case 'StopFailure':
      return hook.errorType === 'rate_limit' ? 'limited' : 'error';
    case 'SessionEnd':
      return 'stopped';
    default:
      return null;
  }
}

function clip(text: string, max: number): string {
  const chars = [...text.replace(/\s+/g, ' ').trim()];
  return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : chars.join('');
}

export function isValidEvent(e: unknown): e is IngestEvent {
  if (!e || typeof e !== 'object') return false;
  const v = e as Record<string, unknown>;
  if (typeof v.eventId !== 'string' || typeof v.source !== 'string' || !v.source
    || typeof v.ts !== 'number' || !Number.isFinite(v.ts)) return false;
  if (v.provider !== undefined && !isProvider(v.provider)) return false;
  if (v.kind === 'usage') return !!v.usage && typeof v.usage === 'object';
  return v.kind === 'hook' && typeof v.sessionId === 'string' && v.sessionId.length > 0
    && !!v.hook && typeof (v.hook as HookPayload).event === 'string';
}

export class Store {
  private sessions = new Map<string, Session>();
  // Sessions removed by SessionEnd: collector ts of the end, and hub ms when it arrived.
  private ended = new Map<string, { ts: number; at: number }>();
  private collectors = new Map<string, number>(); // source -> hub ms last seen
  private quota: Partial<Record<QuotaKey, QuotaValue>> = {};
  private seen = new Set<string>();
  readonly options: StoreOptions;

  constructor(options: Partial<StoreOptions> = {}) {
    this.options = { ...defaultStoreOptions, ...options };
  }

  // Applies one event; returns true if anything visible may have changed.
  apply(event: IngestEvent, now: number): boolean {
    if (this.seen.has(event.eventId)) return false;
    this.seen.add(event.eventId);
    if (this.seen.size > DEDUPE_LIMIT) this.seen.delete(this.seen.values().next().value!);
    this.collectors.set(event.source, now);

    if (event.kind === 'usage') {
      for (const r of parseUsage(event.usage)) this.setQuota(r.key, r.used, r.resetAt, event.ts);
      return true;
    }

    const hook = event.hook;
    const key = `${event.source}:${event.sessionId}`;
    // Archiving or exiting a session removes it from the display at once. Hooks arrive out of
    // order, so anything older than the end is ignored; a later event (a resume) brings it back.
    const end = this.ended.get(key);
    if (end && event.ts <= end.ts) return false;
    if (hook.event === 'SessionEnd') {
      this.ended.set(key, { ts: event.ts, at: now });
      return this.sessions.delete(key);
    }
    let session = this.sessions.get(key);
    if (!session) {
      session = {
        key, source: event.source, sessionId: event.sessionId, title: null, titleSource: null,
        state: 'idle', since: now, firstSeen: now, lastHookTs: 0, lastHookAt: now, lastSeenAt: now,
      };
      this.sessions.set(key, session);
    }
    session.lastSeenAt = now;

    if (hook.title) this.setTitle(session, hook.title, 'name');
    if (hook.prompt) this.setTitle(session, hook.prompt, 'prompt');
    // Hooks run concurrently; never let an older event overwrite a newer state.
    if (event.ts < session.lastHookTs) return true;
    session.lastHookTs = event.ts;
    session.lastHookAt = now;
    const next = transition(hook, session.state);
    if (next && next !== session.state) {
      session.state = next;
      session.since = now;
    }
    return true;
  }

  // Records account quota. Several machines report the same account, so only a newer reading wins.
  setQuota(key: QuotaKey, usedPercent: number | null, resetAt: number | null, observedMs: number) {
    const prev = this.quota[key];
    if (prev && prev.observedMs > observedMs) return;
    const left = usedPercent === null ? null : Math.max(0, Math.min(100, Math.round(100 - usedPercent)));
    this.quota[key] = { left, resetAt, observedMs };
  }

  private setTitle(session: Session, text: string, source: TitleSource) {
    // A real session name always wins over the first-prompt fallback.
    if (source === 'prompt' && session.titleSource) return;
    const title = clip(text, source === 'prompt' ? 24 : MAX_TITLE_CHARS);
    if (title) {
      session.title = title;
      session.titleSource = source;
    }
  }

  private isStale(s: Session, now: number): boolean {
    return s.state === 'working' && now - s.lastHookAt > this.options.silentSuspectMs;
  }

  // Drops sessions that ended or went silent long enough ago; returns true if any were removed.
  prune(now: number): boolean {
    const { sessionRetainMs, forgetAfterMs } = this.options;
    let removed = false;
    for (const [key, s] of this.sessions) {
      const abandoned = this.isStale(s, now) && now - s.lastSeenAt > sessionRetainMs;
      if (abandoned || now - s.lastSeenAt > forgetAfterMs) {
        this.sessions.delete(key);
        removed = true;
      }
    }
    for (const [key, end] of this.ended) if (now - end.at > sessionRetainMs) this.ended.delete(key);
    const active = new Set([...this.sessions.values()].map(s => s.source));
    for (const [source, lastSeen] of this.collectors) {
      if (!active.has(source) && now - lastSeen > sessionRetainMs) {
        this.collectors.delete(source);
        removed = true;
      }
    }
    return removed;
  }

  snapshot(seq: number, now: number): Snapshot {
    let list = [...this.sessions.values()].sort((a, b) => a.firstSeen - b.firstSeen);
    if (list.length > MAX_SESSIONS) {
      // Keep the most relevant sessions, but show them in their stable first-seen order.
      const keep = new Set([...list]
        .sort((a, b) => Number(a.state === 'stopped') - Number(b.state === 'stopped') || b.lastSeenAt - a.lastSeenAt)
        .slice(0, MAX_SESSIONS));
      list = list.filter(s => keep.has(s));
    }
    const sessions = list.map(s => ({
      id: s.key, // source:sessionId, unique and stable for displays to key on
      title: s.title ?? '新会话',
      state: s.state,
      since: Math.floor(s.since / 1000),
      stale: this.isStale(s, now),
    }));
    const quota = (k: QuotaKey): SnapshotQuota | null => {
      const q = this.quota[k];
      return q && q.left !== null ? { left: q.left, resetAt: q.resetAt, at: Math.floor(q.observedMs / 1000) } : null;
    };
    return {
      v: SNAPSHOT_VERSION,
      provider: 'claude',
      seq,
      ts: Math.floor(now / 1000),
      overall: overallState(sessions),
      sessions,
      quota: { '5h': quota('5h'), week: quota('week'), fable: quota('fable') },
      collectors: [...this.collectors].sort(([a], [b]) => a.localeCompare(b))
        .map(([source, lastSeen]) => ({ source, lastSeen: Math.floor(lastSeen / 1000) })),
    };
  }

  toJSON(): PersistedState {
    return {
      sessions: [...this.sessions.values()],
      ended: Object.fromEntries(this.ended),
      collectors: Object.fromEntries(this.collectors),
      quota: this.quota,
    };
  }

  load(data: PersistedState) {
    this.sessions = new Map((data.sessions ?? []).filter(s => s.state !== 'stopped').map(s => [s.key, s]));
    this.ended = new Map(Object.entries(data.ended ?? {}));
    this.collectors = new Map(Object.entries(data.collectors ?? {}).filter(([, v]) => typeof v === 'number'));
    this.quota = data.quota ?? {};
  }
}

// Priority: anything needing the user, then failures, then work in progress.
// Stale sessions cannot claim attention or work, since we no longer know what they are doing.
export function overallState(sessions: { state: SessionState; stale: boolean }[]): OverallState {
  if (!sessions.length) return 'idle';
  const live = sessions.filter(s => !s.stale);
  const has = (...states: SessionState[]) => live.some(s => states.includes(s.state));
  if (has('waiting')) return 'waiting';
  if (has('error', 'limited')) return 'error';
  if (has('working')) return 'working';
  if (has('done')) return 'done';
  if (has('idle')) return 'idle';
  return 'stopped';
}
