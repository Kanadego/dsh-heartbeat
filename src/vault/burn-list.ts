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
  /** Directories are removed recursively (no shred - content is files). */
  dir?: string;
  note: string;
}

export const BURN_LIST: BurnTarget[] = [
  { file: 'profile.json', note: '画像物化视图' },
  { file: 'profile_inbox.jsonl', note: '观察收件箱' },
  { file: 'profile_journal.jsonl', note: '画像操作流水' },
  { file: 'profile_rhythm.json', note: '作息聚合（纯统计）' },
  { file: 'screen.json', note: '屏幕快照（加密）' },
  { file: 'screen.jpg', note: '截图（加密）' },
  { file: 'sent.json', note: '表达记录（加密）' },
  { file: 'browse.json', note: '浏览流状态（加密）' },
  { file: 'seeds.jsonl', note: '素材池（加密）' },
  { file: 'ledger.md', note: '账本（明文，人可读是设计目标）' },
  { file: 'envpulse.json', note: '环境温度计快照' },
  { file: 'gate.json', note: '闸门运行时计数' },
  { dir: 'tmp', note: '解锁临时文件（崩溃残留的解密明文是最该烧的东西）' },
  { dir: 'logs', note: '审计与决策日志' },
  { dir: 'exports', note: '导出产物' },
];

const SETTINGS_DIR = 'settings'; // excluded unless --all

export interface BurnPlanItem {
  target: BurnTarget;
  exists: boolean;
}

/** Preview: what exists, what would be removed. No writes. */
export function planBurn(guard: PathGuard, paths: WorkspacePaths, all = false): BurnPlanItem[] {
  const plan: BurnPlanItem[] = [];
  for (const t of BURN_LIST) {
    const rel = t.file ?? t.dir!;
    if (!all && rel === SETTINGS_DIR) continue;
    const abs = path.join(paths.dataDir, rel);
    let exists = false;
    try {
      exists = fs.existsSync(guard.assert(abs));
    } catch {
      exists = false;
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
