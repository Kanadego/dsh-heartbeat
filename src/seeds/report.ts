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
import { withFileLock, FileLockTimeoutError } from '../core/file-lock.js';
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

/** The host surface this tool touches beyond args (DSH 0.2.2-rc.1 verified):
 *  `concludeTurn()` ends the running turn after the current tool batch, with
 *  no further model request. Older hosts do not provide it — always optional. */
export interface ConcludeTurnContext {
  concludeTurn?: () => void;
}

/** One audit line per attempted conclude (2.3.0 experimental). Kept flat so the
 *  caller can append it to logs/heartbeat.jsonl verbatim. */
export interface ConcludeSilentAudit {
  /** P15-3 (2.3.0): named `_requested` because `exec.concludeTurn()` is only a
   *  REQUEST — the host may still abort or race the turn afterwards, and this
   *  tool cannot observe the eventual turn/end. The audit stays honest at the
   *  point of knowledge; the final state is the host's own turn/end event. */
  event: 'conclude_silent_requested' | 'conclude_silent_failed';
  reason?: 'no-host-api' | 'threw';
  error?: string;
  deliveryId?: string;
  [key: string]: unknown;
}

/** P1-1 (2.3.0, 账本 #d891e0): a report that was NOT written is audited too —
 *  the ledger stays clean, the attempt stays visible. */
export interface ReportRejectedAudit {
  event: 'report_rejected';
  /** 'lock timeout' (B2 中3): the cross-process lock could not be taken — the
   *  critical section never ran, NOTHING landed, and the attempt is audited
   *  before the error is surfaced to the host. 'write failed' (B2 rework 中):
   *  the critical section DID run and something inside it threw — the append
   *  itself (DPAPI/ENOSPC/EACCES, vault key gone) or a test seam. Misfiling a
   *  write/decrypt fault as lock contention sends排障 chasing the wrong lock. */
  reason: 'unknown delivery' | 'duplicate delivery' | 'lock timeout' | 'write failed';
  deliveryId?: string;
  currentDeliveryId?: string;
  [key: string]: unknown;
}

// B2 rework 低1 (2.3.0): per-delivery-turn flag — agentTurn's turn_concluded
// line may only be written when seed_report ACTUALLY requested concludeTurn
// THIS turn. Without it, switch ON + expression + completed + zero assistant
// text (the model only produced thinking blocks, or a tool round ended with
// no body) would be renamed into a conclusion even though P15-2 exists to
// catch exactly that "thinking ate the body" shape. Set ONLY on a real
// concludeTurn request; the orchestrator resets it when a delivery turn
// opens and again when the id is cleared. Module-level for the same reason
// currentDeliveryId is: the tool registers once and must leave a live trace
// the orchestrator can read without a wiring change.
let concludeRequestedThisTurn = false;

/** Mark that THIS delivery turn saw a real concludeTurn request (tool only). */
export function markConcludeRequested(): void {
  concludeRequestedThisTurn = true;
}

/** Did seed_report request a conclude during the current delivery turn? */
export function wasConcludeRequested(): boolean {
  return concludeRequestedThisTurn;
}

/** Start of a new delivery turn / end of the current one: no request yet. */
export function resetConcludeRequested(): void {
  concludeRequestedThisTurn = false;
}

/** P1-1 (2.3.0) audit sink. The lock itself is UNCONDITIONAL — seed_report
 *  only ever accepts the id written into the current delivery package. */
export interface SeedReportToolOptions {
  onRejected?: (entry: ReportRejectedAudit) => void;
  /** Test seam (B2 中4): invoked INSIDE the lock between the duplicate check
   *  and the append. Production never passes it — the concurrency test's
   *  runner uses it to hold the critical section half-open and prove the lock
   *  closes it (and that removing the lock double-books). */
  onLockHeldForTest?: () => void;
}

export function buildSeedReportTool(
  guard: PathGuard,
  file: string,
  isConcludeSilent?: () => boolean,
  audit?: (entry: ConcludeSilentAudit) => void,
  /** The delivery id of the turn currently open ('' = none). Only a report
   *  answering THAT package may end the turn — seed_report is global, so a
   *  stale id or a typo would otherwise cut the user's current chat turn. */
  currentDeliveryId?: () => string,
  options?: SeedReportToolOptions,
): unknown {
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
      required: ['spoken', 'delivery_id'],
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
    async execute(args: unknown, exec?: ConcludeTurnContext): Promise<unknown> {
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
      // P1-1 (2.3.0, 账本 #d891e0): only the id written into THIS delivery
      // package is accepted, and only once. Unconditional — there is no
      // "unlocked" path. Rejections write nothing to the ring; they leave one
      // audit line instead. (N15⑥: `reject` lives at execute scope now — the
      // duplicate branch below fires AFTER the locked critical section.)
      const reject = (reason: ReportRejectedAudit['reason']): void => {
        const current = currentDeliveryId?.() ?? '';
        try {
          options?.onRejected?.({
            event: 'report_rejected', reason,
            ...(deliveryId ? { deliveryId } : {}),
            ...(current ? { currentDeliveryId: current } : {}),
          });
        } catch {
          // auditing must never mask the rejection itself
        }
      };
      {
        const current = currentDeliveryId?.() ?? '';
        if (!deliveryId || deliveryId !== current) {
          reject('unknown delivery');
          // N15③: the MISMATCH message never echoes the live package id —
          // seed_report is global, so a stray call in another session would
          // otherwise learn this delivery's id and could retry with it,
          // stealing the package's report (and, with concludeSilentTurn on,
          // cutting a user chat turn). The live id stays in the
          // report_rejected audit line only. The DUPLICATE branch below is the
          // one deliberate exception: there the caller itself just supplied the
          // id and it already matches the live one, so echoing it leaks nothing
          // the caller does not already have.
          return {
            ok: false,
            message: deliveryId
              ? '报账被拒：delivery_id 与当前投递包不符，本次不记账（用素材包里的本次投递编号原样回填）'
              : '报账被拒：缺少 delivery_id（用素材包里的本次投递编号原样回填），本次不记账',
          };
        }
      }
      // A "material" report is about ids; the reason field is for NOT using
      // material — storing both would muddle the preference aggregates.
      // (rework a2: the N15⑥ re-shuffle dropped this spread once — a silent
      // report's reason vanished from the ring; test-pinned now.)
      const entry: SeedReportEntry = {
        ts: Date.now(), spoken, seedIds, profileIds,
        ...(deliveryId ? { deliveryId } : {}),
        ...(spoken !== 'material' && reason ? { reason } : {}),
      };
      // Evaluated BEFORE the write: this report settles its own follow-up, so a
      // switch flipped mid-execute must not leak into this beat.
      const concludeWanted = isConcludeSilent?.() === true;
      // N15⑥ (2.3.0): the duplicate check and the append are ONE critical
      // section under the cross-process file lock (pool.ts update() precedent)
      // — naked check-then-act let two concurrent seed_report calls both pass
      // the read and both land. Acquisition is fail-closed: a lock that cannot
      // be taken throws and NOTHING is filed.
      let duplicate = false;
      try {
        withFileLock(file, () => {
          try {
            duplicate = readSeedReports(guard, file).some((e) => e.deliveryId === deliveryId);
          } catch {
            // unreadable ring: the write below would fail the same way; do not
            // pretend a duplicate check happened, let append surface the error
          }
          if (duplicate) return;
          // B2 中4 test seam: invoked INSIDE the lock between the duplicate
          // check and the append. Production never passes it; the concurrency
          // test's runner uses it to hold the critical section half-open.
          options?.onLockHeldForTest?.();
          appendSeedReport(guard, file, entry);
        });
      } catch (e) {
        // B2 中3: a lock that could not be taken used to escape this function
        // with no audit line at all — the books said nothing while nothing
        // landed, breaking the "a report that was NOT written is audited too"
        // contract. Audit it, THEN rethrow: fail loud, same contract as a
        // failed save (an ok:false here would invite an immediate model retry
        // against a lock that is probably still held).
        // B2 rework 中: ONLY FileLockTimeoutError means "the critical section
        // never ran". appendSeedReport's own faults (DPAPI/decrypt, ENOSPC,
        // EACCES) and a throwing test seam happen INSIDE the section — the
        // ring may already have been read (and the write half-done), so those
        // are audited as 'write failed', never as lock contention.
        reject(e instanceof FileLockTimeoutError ? 'lock timeout' : 'write failed');
        throw e;
      }
      if (duplicate) {
        reject('duplicate delivery');
        // N15③: this message MAY echo the id — the caller itself just
        // supplied it and it already matches the live package id, so nothing
        // new is revealed (see the mismatch branch above).
        return { ok: false, message: `报账被拒：delivery_id=${deliveryId} 已经报过一次，同一投递只认第一次` };
      }
      // 2.3.0 experimental: ONLY a silent report answering THE CURRENT package
      // may end the turn. Without the id we cannot tell whose silence this is;
      // a stale/typo'd id would cut the user's running chat turn. material/
      // heartfelt never qualify, a failed save above throws before this point,
      // and old hosts have no concludeTurn at all (optional chain).
      let concludeNote = '';
      const concludeAudit = (e: ConcludeSilentAudit): void => {
        try {
          audit?.(e);
        } catch {
          // Auditing must never undo a report that is already settled.
        }
      };
      if (entry.spoken === 'silent' && concludeWanted) {
        const did = entry.deliveryId;
        if (!did) {
          concludeNote = '；回合收尾:跳过(无投递编号)';
        } else if (did !== (currentDeliveryId?.() ?? '')) {
          concludeNote = '；回合收尾:跳过(编号不匹配)';
        } else if (typeof exec?.concludeTurn !== 'function') {
          concludeNote = '；回合收尾:宿主不支持';
          concludeAudit({ event: 'conclude_silent_failed', reason: 'no-host-api', deliveryId: did });
        } else {
          try {
            exec.concludeTurn();
            concludeNote = '；回合收尾:已结束';
            // B2 rework 低1: this is the ONLY place the per-turn conclude flag
            // is set — a turn_concluded audit without it is a misfiled fault.
            markConcludeRequested();
            concludeAudit({ event: 'conclude_silent_requested', deliveryId: did });
          } catch (e) {
            concludeNote = '；回合收尾:失败';
            concludeAudit({ event: 'conclude_silent_failed', reason: 'threw', error: String(e).slice(0, 120), deliveryId: did });
          }
        }
      }
      const bits = [`spoken=${entry.spoken}`];
      if (entry.deliveryId) bits.push(`delivery_id=${entry.deliveryId}`);
      if (entry.seedIds.length) bits.push(`seed_ids=${entry.seedIds.join(',')}`);
      if (entry.profileIds.length) bits.push(`profile_ids=${entry.profileIds.join(',')}`);
      if (entry.reason) bits.push(`reason=${entry.reason}`);
      return { ok: true, message: `已报账：${bits.join(' ')}${concludeNote}` };
    },
  };
}
