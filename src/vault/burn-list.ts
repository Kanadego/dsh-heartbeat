// Burn list - SINGLE SOURCE OF TRUTH (design doc §10.10; v1 shipped two
// hardcoded lists and one drifted). burn and uninstall --purge both consume
// this list. Settings (data/settings/) are NOT burned by default: losing
// memory != losing the charter/gates the user configured (--all overrides).

import fs from 'node:fs';
import path from 'node:path';
import type { PathGuard } from '../core/path-guard.js';
import type { WorkspacePaths } from '../core/paths.js';
import { shredFileSync } from '../core/atomic-fs.js';
import { appendAuditLine } from '../core/audit-log.js';

export interface BurnTarget {
  /** Relative to dataDir. Files are shredded (overwrite x3) then deleted. */
  file?: string;
  /** Every dataDir file whose name starts with this prefix — a family of
   *  timestamped files a bare `file` cannot name (journal archive shards).
   *  Shredded like files. */
  prefix?: string;
  /** Directories are removed recursively (no shred - content is files). */
  dir?: string;
  note: string;
}

export const BURN_LIST: BurnTarget[] = [
  { file: 'profile.json', note: '画像物化视图' },
  { file: 'profile_inbox.jsonl', note: '观察收件箱' },
  { file: 'profile_journal.jsonl', note: '画像操作流水' },
  // H-19: the rotation shards hold the whole profile history and are written
  // in PLAINTEXT — a burn that leaves them behind leaves the memory readable.
  { prefix: 'profile_journal.archive-', note: '画像流水归档分片（明文；journal 轮转产物）' },
  { file: 'profile_rhythm.json', note: '作息聚合（纯统计）' },
  { file: 'screen.json', note: '屏幕快照（加密）' },
  { file: 'screen.jpg', note: '截图（加密）' },
  { file: 'sent.json', note: '表达记录（加密）' },
  { file: 'browse.json', note: '浏览流状态（加密）' },
  { file: 'seeds.jsonl', note: '素材池（加密）' },
  { file: 'ledger.md', note: '账本（明文，人可读是设计目标）' },
  { file: 'envpulse.json', note: '环境温度计快照' },
  { file: 'gate.json', note: '闸门运行时计数' },
  // v1.9.0 completion (H-19): these carry memory just as much as the rows
  // above — the persona report log records WHAT SHE SAID (spoken / seed_ids /
  // profile_ids / reason), so a burn that skips it is a burn that lies.
  { file: 'profile_snapshot.json', note: '画像快照（journal 轮转基线）' },
  { file: 'cursors.json', note: '观察游标（会话事件位点）' },
  { file: 'seed_report.jsonl', note: '投递报账日志（加密）' },
  { file: 'preference.json', note: '话题偏好统计' },
  { dir: 'weekly', note: '周报（画像与素材散文）' },
  { dir: 'tmp', note: '解锁临时文件（崩溃残留的解密明文是最该烧的东西）' },
  { dir: 'logs', note: '审计与决策日志' },
  { dir: 'exports', note: '导出产物' },
];

const SETTINGS_DIR = 'settings'; // excluded unless --all

/** dataDir files matching a prefix target, name-sorted for stable output. */
function prefixMatches(guard: PathGuard, paths: WorkspacePaths, prefix: string): string[] {
  try {
    return fs.readdirSync(guard.assert(paths.dataDir))
      .filter((f) => f.startsWith(prefix))
      .sort();
  } catch {
    return [];
  }
}

export interface BurnPlanItem {
  target: BurnTarget;
  exists: boolean;
}

/** Preview: what exists, what would be removed. No writes. */
export function planBurn(guard: PathGuard, paths: WorkspacePaths, all = false): BurnPlanItem[] {
  const plan: BurnPlanItem[] = [];
  for (const t of BURN_LIST) {
    const rel = t.file ?? t.dir ?? t.prefix ?? '';
    if (!all && rel === SETTINGS_DIR) continue;
    let exists = false;
    if (t.prefix) {
      exists = prefixMatches(guard, paths, t.prefix).length > 0;
    } else {
      try {
        exists = fs.existsSync(guard.assert(path.join(paths.dataDir, rel)));
      } catch {
        exists = false;
      }
    }
    plan.push({ target: t, exists });
  }
  if (all) {
    plan.push({ target: { dir: SETTINGS_DIR, note: '用户设定（隐私宪章/闸门参数）——仅 --all 连带' }, exists: fs.existsSync(paths.settingsDir) });
  }
  return plan;
}

/**
 * Execute the burn: overwrite x3 + delete files, remove dirs. Irreversible.
 * Returns per-target results and writes a BURN_EVENT into the (recreated)
 * journal afterwards - the only trace, on purpose (transparency).
 */
export function executeBurn(
  guard: PathGuard,
  paths: WorkspacePaths,
  opts: { all?: boolean; shredPasses?: number } = {},
): { burned: string[]; missing: string[] } {
  const burned: string[] = [];
  const missing: string[] = [];
  const passes = opts.shredPasses ?? 3;
  for (const t of BURN_LIST) {
    // H-19: a prefix target is a family of files (timestamped archive shards);
    // shred every match individually.
    if (t.prefix) {
      const matches = prefixMatches(guard, paths, t.prefix);
      if (matches.length === 0) {
        missing.push(`${t.prefix}*`);
        continue;
      }
      for (const f of matches) {
        try {
          shredFileSync(guard.assert(path.join(paths.dataDir, f)), passes);
          burned.push(f);
        } catch { /* vanished between listing and shredding: not fatal */ }
      }
      continue;
    }
    const rel = t.file ?? t.dir!;
    const abs = path.join(paths.dataDir, rel);
    let absCanon: string;
    try {
      absCanon = guard.assert(abs);
    } catch {
      missing.push(rel);
      continue;
    }
    if (t.file) {
      if (fs.existsSync(absCanon)) {
        shredFileSync(absCanon, passes);
        burned.push(rel);
      } else {
        missing.push(rel);
      }
    } else if (fs.existsSync(absCanon)) {
      fs.rmSync(absCanon, { recursive: true, force: true });
      burned.push(rel);
    } else {
      missing.push(rel);
    }
  }
  if (opts.all) {
    fs.rmSync(paths.settingsDir, { recursive: true, force: true });
    burned.push(SETTINGS_DIR);
  }
  // BURN_EVENT: recreate the journal; data dir is now re-initializable.
  appendAuditLine(guard.assert(path.join(paths.dataDir, 'profile_journal.jsonl')), {
    event: 'BURN_EVENT',
    burned: burned.length,
    missing: missing.length,
    settingsPreserved: !opts.all,
  });
  return { burned, missing };
}
