// Policy shape + runtime validation. Factory defaults live in config/policy.json
// (read-only); the user layer in data/settings/policy.json overrides via deep
// merge (design doc §13, D3).

export interface QuietHours {
  start: string; // "HH:MM"
  end: string;   // "HH:MM"
}

export interface BrowseWindow {
  start: string;
  end: string;
}

export interface Policy {
  heartbeat: { intervalMin: number };
  gate: {
    maxDailySend: number;
    cooldownMinutes: number;
    quietHours: QuietHours;
  };
  browse: {
    windows: BrowseWindow[];
    minIntervalHours: number;
    maxSeedsPerVisit: number;
  };
  seeds: {
    maxActive: number;
    ttlDays: { news: number; fandom: number; scene: number; promise: number };
    coldBenchDays: number;
    retireAfterUsed: number;
    scoreWeights: { freshness: number; unused: number; confidence: number };
  };
  profile: {
    consolidation: { minIntervalHours: number; inboxBacklog: number };
    partitionCap: number;
    maxOpsPerRun: number;
    confidenceCap: { chat: number; screen: number; browse: number };
    volatileDays: number;
    stableLowActivityDays: number;
    psyEnabled: boolean;
  };
  retention: { envPulseHours: number; decisionLogDays: number };
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function fail(msg: string): never {
  throw new Error(`policy: ${msg}`);
}

export function assertPolicy(input: unknown): asserts input is Policy {
  if (!isPlainObject(input)) fail('root must be an object');
  const p = input;
  const hb = p.heartbeat;
  if (!isPlainObject(hb)) fail('heartbeat missing');
  if (typeof hb.intervalMin !== 'number' || hb.intervalMin < 1 || hb.intervalMin > 1440) {
    fail('heartbeat.intervalMin must be a number in [1, 1440]');
  }
  const g = p.gate;
  if (!isPlainObject(g)) fail('gate missing');
  if (typeof g.maxDailySend !== 'number' || g.maxDailySend < 0) fail('gate.maxDailySend must be >= 0');
  if (typeof g.cooldownMinutes !== 'number' || g.cooldownMinutes < 0) fail('gate.cooldownMinutes must be >= 0');
  const qh = g.quietHours;
  if (!isPlainObject(qh)) fail('gate.quietHours missing');
  if (typeof qh.start !== 'string' || !HHMM.test(qh.start) || typeof qh.end !== 'string' || !HHMM.test(qh.end)) {
    fail('gate.quietHours must be {start:"HH:MM", end:"HH:MM"}');
  }
  const b = p.browse;
  if (!isPlainObject(b)) fail('browse missing');
  if (!Array.isArray(b.windows) || b.windows.length === 0) fail('browse.windows must be a non-empty array');
  for (const w of b.windows) {
    if (!isPlainObject(w)) fail('browse.windows entries must be objects');
    if (typeof w.start !== 'string' || !HHMM.test(w.start) || typeof w.end !== 'string' || !HHMM.test(w.end)) {
      fail('browse.windows entries must be {start:"HH:MM", end:"HH:MM"}');
    }
  }
  if (typeof b.minIntervalHours !== 'number' || b.minIntervalHours <= 0) fail('browse.minIntervalHours must be > 0');
  if (typeof b.maxSeedsPerVisit !== 'number' || b.maxSeedsPerVisit < 1) fail('browse.maxSeedsPerVisit must be >= 1');
  const s = p.seeds;
  if (!isPlainObject(s)) fail('seeds missing');
  if (typeof s.maxActive !== 'number' || s.maxActive < 1) fail('seeds.maxActive must be >= 1');
  if (!isPlainObject(s.ttlDays)) fail('seeds.ttlDays missing');
  for (const k of ['news', 'fandom', 'scene', 'promise'] as const) {
    if (typeof s.ttlDays[k] !== 'number') fail(`seeds.ttlDays.${k} missing`);
  }
  if (typeof s.coldBenchDays !== 'number') fail('seeds.coldBenchDays missing');
  if (typeof s.retireAfterUsed !== 'number' || s.retireAfterUsed < 1) fail('seeds.retireAfterUsed must be >= 1');
  if (!isPlainObject(s.scoreWeights)) fail('seeds.scoreWeights missing');
  const pr = p.profile;
  if (!isPlainObject(pr)) fail('profile missing');
  const c = pr.consolidation;
  if (!isPlainObject(c)) fail('profile.consolidation missing');
  if (typeof c.minIntervalHours !== 'number' || typeof c.inboxBacklog !== 'number') fail('profile.consolidation fields missing');
  if (typeof pr.partitionCap !== 'number' || pr.partitionCap < 1) fail('profile.partitionCap must be >= 1');
  if (typeof pr.maxOpsPerRun !== 'number' || pr.maxOpsPerRun < 1) fail('profile.maxOpsPerRun must be >= 1');
  const cc = pr.confidenceCap;
  if (!isPlainObject(cc)) fail('profile.confidenceCap missing');
  if (typeof cc.chat !== 'number' || typeof cc.screen !== 'number' || typeof cc.browse !== 'number') {
    fail('profile.confidenceCap fields missing');
  }
  if (typeof pr.volatileDays !== 'number' || pr.volatileDays < 1) fail('profile.volatileDays must be >= 1');
  if (typeof pr.stableLowActivityDays !== 'number' || pr.stableLowActivityDays < 1) fail('profile.stableLowActivityDays must be >= 1');
  if (typeof pr.psyEnabled !== 'boolean') fail('profile.psyEnabled must be boolean');
  const r = p.retention;
  if (!isPlainObject(r)) fail('retention missing');
  if (typeof r.envPulseHours !== 'number' || typeof r.decisionLogDays !== 'number') fail('retention fields missing');
}

/** Recursive merge: user values win; objects merge, arrays and scalars replace. */
export function deepMerge<T>(base: T, override: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return (override === undefined ? base : (override as T));
  }
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = v === undefined ? (base as Record<string, unknown>)[k] : deepMerge((base as Record<string, unknown>)[k], v);
  }
  return out as T;
}
