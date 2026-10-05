// Weekly report store + writer helpers (v1.8.0). Deliberately host-free:
// orchestration (when to run, which agent, toast) lives in the orchestrator —
// same split as profile/consolidate.ts. Reports are DPAPI-encrypted because a
// report contains user-identifying content (profile adds, ledger texts) —
// same划线标准 as profile/seeds (design doc §10.5).

import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJsonSync } from '../core/atomic-fs.js';
import { loadEncryptedText, saveEncryptedText } from '../vault/vault.js';
import type { PathGuard } from '../core/path-guard.js';
import type { WeeklyFacts } from './collect.js';

export const WEEKLY_INTERVAL_MS = 7 * 86_400_000;

export interface WeeklyReport {
  start: string;
  end: string;
  generatedAt: string;
  /** 'llm' = engine-room prose; 'template' = deterministic fallback. */
  source: 'llm' | 'template';
  text: string;
}

export function weeklyDirPath(dataDir: string): string {
  return path.join(dataDir, 'weekly');
}

function stateFilePath(dataDir: string): string {
  return path.join(weeklyDirPath(dataDir), 'state.json');
}

function reportFileName(endIso: string): string {
  return `report-${endIso.slice(0, 10)}.json`;
}

/** Last generation time from the weekly state file; 0 = never. */
export function lastWeeklyGeneratedAt(guard: PathGuard, dataDir: string): number {
  try {
    const raw = JSON.parse(fs.readFileSync(guard.assert(stateFilePath(dataDir)), 'utf8')) as { lastGeneratedAt?: number };
    return Number(raw.lastGeneratedAt) || 0;
  } catch {
    return 0;
  }
}

/** Due when the last report is ≥7 days old. Never-generated counts as due:
 * the first run after installing writes an onboarding report from whatever
 * the 7-day window already holds. */
export function weeklyDue(guard: PathGuard, dataDir: string, now = Date.now()): boolean {
  const last = lastWeeklyGeneratedAt(guard, dataDir);
  return now - last >= WEEKLY_INTERVAL_MS;
}

/** Persist a report (DPAPI) and stamp the state file. */
export function saveWeeklyReport(guard: PathGuard, dataDir: string, report: WeeklyReport): string {
  const dir = weeklyDirPath(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, reportFileName(report.end));
  saveEncryptedText(guard, file, JSON.stringify(report, null, 1));
  atomicWriteJsonSync(stateFilePath(dataDir), { lastGeneratedAt: Date.parse(report.generatedAt) });
  return file;
}

export interface WeeklyReportMeta {
  file: string;
  start: string;
  end: string;
  generatedAt: string;
  source: string;
}

/** Newest-first listing for the card; unparsable entries are skipped. */
export function listWeeklyReports(guard: PathGuard, dataDir: string): WeeklyReportMeta[] {
  const out: WeeklyReportMeta[] = [];
  try {
    for (const file of fs.readdirSync(weeklyDirPath(dataDir))) {
      if (!/^report-\d{4}-\d{2}-\d{2}\.json$/.test(file)) continue;
      const rep = readWeeklyReport(guard, dataDir, file);
      if (!rep) continue;
      out.push({ file, start: rep.start, end: rep.end, generatedAt: rep.generatedAt, source: rep.source });
    }
  } catch { /* no weekly dir yet */ }
  return out.sort((a, b) => (a.end < b.end ? 1 : -1));
}

export function readWeeklyReport(guard: PathGuard, dataDir: string, file: string): WeeklyReport | null {
  if (!/^report-\d{4}-\d{2}-\d{2}\.json$/.test(file)) return null; // guard.assert would reject ../ anyway
  try {
    const raw = loadEncryptedText(guard, path.join(weeklyDirPath(dataDir), file));
    if (!raw) return null;
    const rep = JSON.parse(raw) as WeeklyReport;
    if (typeof rep.text !== 'string') return null;
    return rep;
  } catch {
    return null;
  }
}

/** The engine-room prompt: neutral system narrator, fact-bound, ≤250 chars. */
export function buildWeeklyPrompt(facts: WeeklyFacts): string {
  return [
    '你是心跳插件的后台报告器。根据下面的本周事实清单，用中文写一份周报正文。',
    '规则：',
    '- 叙述者自称「心跳」——这是插件后台，不是任何会话里的 agent；绝不能以会话 agent 的身份或人格自称。',
    '- 只报告事实清单里有的内容；某一节没有数据就整节跳过，不要编造、不要凑数。',
    '- 语气平实中性，不用感叹号；篇幅不超过 250 字。',
    '- 待办积压那一节用商量的语气提一句，不催促。',
    '- 直接输出周报正文，不要输出解释、标题或 JSON。',
    '',
    '本周事实（JSON）：',
    JSON.stringify(facts, null, 1),
  ].join('\n');
}

/** Deterministic fallback: the facts, plainly stated. Used when the LLM turn
 * fails or comes back empty — a plain report beats no report. */
export function renderTemplateReport(facts: WeeklyFacts): string {
  const d = (iso: string): string => iso.slice(0, 10);
  const lines: string[] = [`本周（${d(facts.windowStart)} ~ ${d(facts.windowEnd)}）`];
  lines.push(`表达 ${facts.spoken} 次，静默 ${facts.silent} 次。`);
  if (facts.silentTopReasons.length > 0) {
    lines.push(`静默主因：${facts.silentTopReasons.map((r) => `${r.reason}（${r.count}）`).join('、')}。`);
  }
  if (facts.profileAdds.length > 0) {
    lines.push(`新认识 ${facts.profileAdds.length} 条：${facts.profileAdds.map((a) => a.content).join('；')}。`);
  }
  if (facts.ledger.added.length > 0 || facts.ledger.done.length > 0) {
    const parts: string[] = [];
    if (facts.ledger.added.length > 0) parts.push(`新增待办：${facts.ledger.added.join('、')}`);
    if (facts.ledger.done.length > 0) parts.push(`已解决：${facts.ledger.done.join('、')}`);
    lines.push(`${parts.join('；')}。`);
  }
  if (facts.ledger.stale.length > 0) {
    lines.push(`挂了很久：${facts.ledger.stale.map((s) => `${s.text}（${s.days} 天）`).join('、')}——要删掉还是继续挂着？`);
  }
  if (facts.seeds.added.length > 0) {
    lines.push(`素材池新增 ${facts.seeds.added.length} 条，已消费 ${facts.seeds.consumed.length} 条。`);
  }
  if (facts.seeds.waiting.length > 0) {
    lines.push(`还没聊过的素材：${facts.seeds.waiting.join('、')}。`);
  }
  if (facts.peakHours.length > 0) {
    lines.push(`活跃高峰：${facts.peakHours.join('、')}。`);
  }
  return lines.join('\n');
}
