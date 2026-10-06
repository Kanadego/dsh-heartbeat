// Persona report (2026-10-06): after every material delivery the persona
// files ONE report through a model tool — what she said (material / heartfelt
// / silent), which seed ids she actually used, which profile entries she
// chatted about, and a one-line reason when she used nothing. This is the
// unified bookkeeping channel that REPLACES the deleted containment-match
// attribution: under-crediting is cheap (a seed waits one more beat), a false
// credit poisons the preference loop.
//
// The tool definition is a PLAIN OBJECT (ledger-tool precedent, 0.2.0-rc.2
// verified — ToolSchema.parameters is a raw JSON Schema), so the module keeps
// zero runtime dependencies. The report file is an encrypted JSONL ring
// (newest last, trimmed to REPORT_KEEP) — same DPAPI treatment as seeds.jsonl
// because the reasons/profile refs carry user-adjacent information.

import path from 'node:path';
import type { PathGuard } from '../core/path-guard.js';
import { loadEncryptedText, saveEncryptedText } from '../vault/vault.js';

export type ReportSpoken = 'material' | 'heartfelt' | 'silent';

/** Canonical one-line reasons for not using material (persona picks one). */
export const REPORT_REASONS = ['不想说话', '素材不搭', '在忙或刚聊过'] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export interface SeedReportEntry {
  ts: number;
  spoken: ReportSpoken;
  seedIds: string[];
  profileIds: string[];
  reason?: ReportReason;
  /** Delivery id of the package this report answers (v1.9.0). Absent in older
   *  entries / when the persona forgot it; reconciliation then falls back to
   *  the newest in-window report. */
  deliveryId?: string;
}

export function reportFilePath(dataDir: string): string {
  return path.join(dataDir, 'seed_report.jsonl');
}

/** Ring cap: reports older than this roll off. Reconciliation only ever needs
 * the last beat's window; weekly/preference aggregate over a few hundred. */
export const REPORT_KEEP = 400;

function parseEntry(obj: unknown): SeedReportEntry | null {
  const e = obj as Partial<SeedReportEntry> | null;
  if (!e || typeof e.ts !== 'number' || !Number.isFinite(e.ts)) return null;
  if (e.spoken !== 'material' && e.spoken !== 'heartfelt' && e.spoken !== 'silent') return null;
  const arr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];
  const ids = arr(e.seedIds);
  const pids = arr(e.profileIds);
  const reason = REPORT_REASONS.includes(e.reason as ReportReason) ? (e.reason as ReportReason) : undefined;
  const did = typeof e.deliveryId === 'string' && e.deliveryId.trim() ? e.deliveryId.trim() : '';
  return {
    ts: e.ts, spoken: e.spoken, seedIds: ids, profileIds: pids,
    ...(did ? { deliveryId: did } : {}),
    ...(reason ? { reason } : {}),
  };
}

export function appendSeedReport(guard: PathGuard, file: string, entry: SeedReportEntry): void {
  const raw = loadEncryptedText(guard, file) ?? '';
  const lines = raw.split('\n').filter((l) => l.trim());
  lines.push(JSON.stringify(entry));
  saveEncryptedText(guard, file, lines.slice(-REPORT_KEEP).join('\n') + '\n');
}

/** All stored reports, oldest first. Never throws per-line (corrupt -> skip). */
export function readSeedReports(guard: PathGuard, file: string): SeedReportEntry[] {
  const raw = loadEncryptedText(guard, file);
  if (!raw) return [];
  const out: SeedReportEntry[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const e = parseEntry(JSON.parse(t));
      if (e) out.push(e);
    } catch {
      // corrupt line: skip
    }
  }
  return out;
}

/** Reports filed at or after `sinceTs` (the delivery turn's start mark). */
export function readSeedReportsSince(guard: PathGuard, file: string, sinceTs: number): SeedReportEntry[] {
  return readSeedReports(guard, file).filter((e) => e.ts >= sinceTs);
}

// ── the model tool ────────────────────────────────────────────────────────

interface ReportToolArgs {
  spoken?: unknown;
  seed_ids?: unknown;
  profile_ids?: unknown;
  reason?: unknown;
  delivery_id?: unknown;
}

/** Ids come from a model, so accept the shapes it actually writes: `s3`, `[s3]`,
 *  `"s3"`. Brackets/quotes are never part of an id — `[s3]` comes straight from
 *  the package line `- [s3] <text>` — and leaving them in made every id fail the
 *  package check, so the delivery was credited to nobody (fixed 2026-10-06). */
function cleanIds(v: unknown): string[] {
  return Array.isArray(v)
    ? v
        .map((x) => String(x ?? '').replace(/[[\]{}"'`]/g, '').trim().replace(/\s+/g, ''))
        .filter((s) => s.length > 0 && s.length <= 24)
    : [];
}

export function buildSeedReportTool(guard: PathGuard, file: string): unknown {
  return {
    name: 'seed_report',
    description:
      '素材报账工具（心跳插件）。收到心跳素材包后必须调用一次本工具报账，说不说、用没用都要报：' +
      'spoken=material 表示说了素材里的内容（此时 seed_ids 必填，填实际用到的素材编号，可多条）；' +
      'spoken=heartfelt 表示说了不带素材的话（真心话或短应答）；spoken=silent 表示没说话。' +
      '把当成话题聊了的画像条目编号填进 profile_ids。没用素材时用 reason 记一笔原因：' +
      '不想说话 / 素材不搭 / 在忙或刚聊过。一次投递只报一次账，' +
      '并把素材包里的本次投递编号原样填进 delivery_id。',
    parameters: {
      type: 'object',
      properties: {
        spoken: { type: 'string', enum: ['material', 'heartfelt', 'silent'], description: 'material=说了素材，heartfelt=说了不带素材的话，silent=没说话' },
        seed_ids: { type: 'array', items: { type: 'string' }, description: 'spoken=material 时必填：实际用到的素材编号，只填编号本身（如 ["s3"]），不要带方括号' },
        profile_ids: { type: 'array', items: { type: 'string' }, description: '实际当成话题聊了的画像条目编号（闲着模式素材包里才有）' },
        reason: { type: 'string', enum: [...REPORT_REASONS], description: '没用素材时的原因，选填' },
        delivery_id: { type: 'string', description: '素材包里的本次投递编号（形如 d1a2b3c4），原样回填' },
      },
      required: ['spoken'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, message: { type: 'string' } },
        required: ['ok', 'message'],
        additionalProperties: false,
      },
      render: (_args: unknown, value: unknown) => {
        const v = value as { message?: string };
        return [{ type: 'text', text: String(v.message ?? '') }];
      },
    },
    // Whole-file load+save through DPAPI, and the report is filed while the
    // persona turn is still finishing — 0.7–2.7 s measured here, so 5 s was
    // too tight for a slow disk (raised 2026-10-06).
    timeoutMs: 15000,
    // whole-file rewrite on one encrypted file; never parallel
    isConcurrencySafe: () => false,
    async execute(args: unknown): Promise<unknown> {
      const a = (args ?? {}) as ReportToolArgs;
      const spoken = String(a.spoken ?? '');
      if (spoken !== 'material' && spoken !== 'heartfelt' && spoken !== 'silent') {
        return { ok: false, message: 'spoken 必须是 material / heartfelt / silent 之一' };
      }
      const seedIds = cleanIds(a.seed_ids);
      const profileIds = cleanIds(a.profile_ids);
      if (spoken === 'material' && seedIds.length === 0) {
        return { ok: false, message: 'spoken=material 需要 seed_ids：把实际用到的素材编号填进来' };
      }
      const reasonRaw = String(a.reason ?? '');
      const reason = (REPORT_REASONS as readonly string[]).includes(reasonRaw)
        ? (reasonRaw as ReportReason)
        : undefined;
      const deliveryId = String(a.delivery_id ?? '').trim().slice(0, 64);
      // A "material" report is about ids; the reason field is for NOT using
      // material — storing both would muddle the preference aggregates.
      const entry: SeedReportEntry = {
        ts: Date.now(), spoken, seedIds, profileIds,
        ...(deliveryId ? { deliveryId } : {}),
      };
      if (spoken !== 'material' && reason) entry.reason = reason;
      appendSeedReport(guard, file, entry);
      const bits = [`spoken=${entry.spoken}`];
      if (entry.deliveryId) bits.push(`delivery_id=${entry.deliveryId}`);
      if (entry.seedIds.length) bits.push(`seed_ids=${entry.seedIds.join(',')}`);
      if (entry.profileIds.length) bits.push(`profile_ids=${entry.profileIds.join(',')}`);
      if (entry.reason) bits.push(`reason=${entry.reason}`);
      return { ok: true, message: `已报账：${bits.join(' ')}` };
    },
  };
}
