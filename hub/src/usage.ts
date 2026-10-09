// Turns get_usage rate-limit windows (reported by collectors) into display quota readings.
import type { UsagePayload, UsageWindow } from './protocol.ts';
import type { QuotaKey } from './state.ts';

export interface QuotaReading {
  key: QuotaKey;
  used: number | null; // percent used, null when the account reports no such window
  resetAt: number | null; // unix seconds
}

function reading(key: QuotaKey, w: UsageWindow | null | undefined): QuotaReading {
  const used = typeof w?.utilization === 'number' ? w.utilization : null;
  const reset = w?.resets_at ? Date.parse(w.resets_at) : NaN;
  return { key, used, resetAt: Number.isFinite(reset) ? Math.floor(reset / 1000) : null };
}

// get_usage is experimental, so every field is optional and anything unexpected reads as "no data".
export function parseUsage(usage: UsagePayload): QuotaReading[] {
  const scoped = Array.isArray(usage.model_scoped) ? usage.model_scoped : [];
  return [
    reading('5h', usage.five_hour),
    reading('week', usage.seven_day),
    reading('fable', scoped.find(m => m?.display_name?.toLowerCase() === 'fable')),
  ];
}
