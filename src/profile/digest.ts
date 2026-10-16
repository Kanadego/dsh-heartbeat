// Digest supply layer (design doc §3.4): per-consumer slices, built fresh per
// gated model call, never persisted into any context (D7).
//
// v2.0 (item 6, 方向 A): the budget is 6000 chars (~1500 tokens CJK-heavy) and
// every section has its own ceiling. The old shape had one lever — hard-slice
// the topic block to 800 chars whenever the total passed 3200 — and the profile
// grew past it (58 valid entries): tact+wander alone were 3304 chars, so the
// topic slice was ALWAYS cut to 800 (the 4th entry sliced mid sentence) and
// `withinBudget` was permanently false (CODE-REVIEW-2026-10-07.md:551). Now the
// caps are named, truncation happens on ENTRY boundaries (an entry that does not
// fit is skipped whole, never sliced), the ledger follow-ups are reserved space,
// and the digest reports how many entries each cap dropped.
//
// B6: tact includes the gate's window CLASS (busy-rules result), never the
// window title. stable entries flagged low-activity are deprioritized with an
// "unverified" note (D9).

import type { PathGuard } from '../core/path-guard.js';
import type { WorkspacePaths } from '../core/paths.js';
import type { Policy } from '../config/schema.js';
import { loadProfile, profileFilePath } from './store.js';
import type { ProfileDoc, ProfileEntry } from './types.js';
import { summarizeRhythm } from '../rhythm/rhythm.js';
import { pendingOlderThan } from '../ledger/ledger.js';
import { ledgerFilePath } from '../ledger/ledger.js';

/** Total digest budget in characters (~1500 tokens CJK-heavy). */
export const BUDGET_CHARS = 6000;
/** tact ceiling: the 时间感 line is always kept, then comm entries until full. */
const TACT_MAX_CHARS = 2500;
/** wander ceiling (5 high-confidence interests is ~800 chars in practice). */
const WANDER_MAX_CHARS = 850;
/** Floor for the topic slice, whatever tact/wander leave behind. */
const TOPIC_MIN_CHARS = 2400;
/** Ledger follow-ups are reserved space, but each line is clamped and the block
 *  has its own ceiling — 低优先级 review (2026-10-17): an unbounded ledger row
 *  could otherwise push the whole digest past the budget. */
const LEDGER_ITEM_CHARS = 120;
const LEDGER_MAX_CHARS = 400;
/** Default slice size for the topic section (v2.0: was 8, the budget grew). */
const TOPN_DEFAULT = 12;

export interface DigestInput {
  windowClass?: string | null;
  topN?: number;
}

export interface SituationDigest {
  tact: string;
  topic: string;
  wander: string;
  totalChars: number;
  withinBudget: boolean;
  /** v2.0 (item 6): entries dropped by each section's cap, for the card view. */
  omitted: { tact: number; topic: number; wander: number };
  /** v2.0 (item 6): the budget the three sections were measured against. */
  budgetChars: number;
}

function fmtEntry(prefix: string, content: string, opts: { low?: boolean; confidence: number }): string {
  const flag = opts.low ? '（久未验证）' : '';
  return `${prefix}${content}${flag} [conf ${opts.confidence.toFixed(2)}]`;
}

/** Scored, valid interest+projects entries, best first. Shared by the digest
 * topic slice and the idle-mode fallback materials — the fallback needs the
 * REAL entry ids so the persona's seed_report can credit profile usage. */
export function profileTopicEntries(doc: ProfileDoc, topN: number): ProfileEntry[] {
  const score = (e: { confidence: number; updatedAt: string }) =>
    e.confidence * 0.7 + (1 / (1 + Math.max(0, Date.now() - Date.parse(e.updatedAt)) / 86_400_000)) * 0.3;
  return [...doc.partitions.interest!.entries, ...doc.partitions.projects!.entries]
    .filter((e) => e.validTo === null)
    .sort((a, b) => score(b) - score(a))
    .slice(0, topN);
}

/**
 * v2.0 (item 6, 方向 A): fill a section up to `cap` chars one WHOLE entry at a
 * time. An entry that does not fit is skipped — half a sentence is worse than a
 * missing one, and one huge entry must not blank the section — and the scan
 * continues so the entries behind it still get their turn. No marker line is
 * appended: the model would otherwise talk about entries it cannot see; the
 * dropped count travels back to the card in `SituationDigest.omitted`.
 */
function capSection(entries: string[], cap: number): { text: string; omitted: number } {
  const kept: string[] = [];
  let len = 0;
  let omitted = 0;
  for (const line of entries) {
    const add = kept.length === 0 ? line.length : line.length + 1;
    if (len + add > cap) {
      omitted += 1;
      continue;
    }
    kept.push(line);
    len += add;
  }
  if (kept.length === 0 && omitted > 0) return { text: `（本节 ${omitted} 条超出预算，已省略）`, omitted };
  return { text: kept.join('\n'), omitted };
}

export function buildDigest(guard: PathGuard, paths: WorkspacePaths, policy: Policy, input: DigestInput = {}): SituationDigest {
  const doc = loadProfile(guard, profileFilePath(paths.dataDir));
  const topN = input.topN ?? TOPN_DEFAULT;

  // -- tact: rhythm summary + comm high-confidence + window class (B6)
  // 第 86 条: `daysSampled`/`peakHours` are `summarizeRhythm()`'s OUTPUT and are
  // never written into profile_rhythm.json (that file holds histogram/days/
  // lastDecayAt only), so reading them off the raw JSON always produced
  // "作息未知（样本不足）". Compute the summary from the histogram instead.
  const summary = summarizeRhythm(paths);
  let rhythmLine = '作息未知（样本不足）';
  if (summary.daysSampled > 0 && summary.peakHours.length > 0) {
    rhythmLine = `近期活跃时段: ${summary.peakHours.slice(0, 4).join('、')}（样本 ${summary.daysSampled} 天）`;
  }
  const comm = doc.partitions.comm!.entries
    .filter((e) => e.validTo === null && e.confidence > 0.5)
    .map((e) => fmtEntry('- 沟通偏好: ', e.content, { low: e.lowActivity, confidence: e.confidence }));
  const tactParts = [
    `[时间感] ${rhythmLine}${input.windowClass ? ` | 当前窗口类别: ${input.windowClass}` : ''}`,
    ...comm,
  ];

  // -- topic: interest + projects valid entries, confidence x recency
  const topicEntries = profileTopicEntries(doc, topN).map((e) => {
    const prefix = e.partition === 'projects' ? '- 进行中: ' : '- 兴趣: ';
    return fmtEntry(prefix, `${e.topic}/${e.subTopic}: ${e.content}`, { low: e.lowActivity, confidence: e.confidence });
  });

  // -- wander: high-confidence interests
  const wanderEntries = doc.partitions.interest!.entries
    .filter((e) => e.validTo === null && e.confidence >= 0.6 && e.subTopic === 'preference')
    .slice(0, 5)
    .map((e) => `- ${e.content} [conf ${e.confidence.toFixed(2)}]`);

  // -- ledger stale items (跟进时机) — reserved space, never budgeted away
  const ledgerBlock = pendingOlderThan(guard, ledgerFilePath(paths.dataDir), 3)
    .slice(0, 3)
    .map((e) => `- ${e.text.slice(0, LEDGER_ITEM_CHARS)}（${e.date}）`);
  const ledgerCapped = capSection(ledgerBlock, LEDGER_MAX_CHARS);
  const ledgerText = ledgerCapped.text.length ? ['[账本待跟进] ', ledgerCapped.text].join('\n') : '';

  const tact = capSection(tactParts, TACT_MAX_CHARS);
  const wander = capSection(wanderEntries.length ? wanderEntries : ['(无高置信兴趣)'], WANDER_MAX_CHARS);
  // The topic slice takes whatever tact/wander/the ledger block leave behind.
  const topicBudget = Math.max(
    TOPIC_MIN_CHARS,
    BUDGET_CHARS - tact.text.length - wander.text.length - ledgerText.length - 40,
  );
  let topicCapped = capSection(topicEntries, topicBudget);
  let topic = [topicCapped.text, ledgerText].filter((s) => s.length > 0).join('\n');

  let totalChars = tact.text.length + topic.length + wander.text.length;
  // 低优先级 review (2026-10-17): the ledger block is reserved space and the
  // topic slice has a floor, so their sum can still pass the budget. The ledger
  // is a promise and stays; the topic slice gives way — whole entries only — and
  // the count it cost is folded into `omitted.topic` for the card view.
  if (totalChars > BUDGET_CHARS) {
    const room = Math.max(0, topicBudget - (totalChars - BUDGET_CHARS));
    const trimmed = room === 0
      ? { text: '', omitted: topicEntries.length }
      : capSection(topicEntries, room);
    topicCapped = { text: trimmed.text, omitted: topicCapped.omitted + trimmed.omitted };
    topic = [topicCapped.text, ledgerText].filter((s) => s.length > 0).join('\n');
    totalChars = tact.text.length + topic.length + wander.text.length;
  }
  return {
    tact: tact.text,
    topic,
    wander: wander.text,
    totalChars,
    withinBudget: totalChars <= BUDGET_CHARS,
    omitted: { tact: tact.omitted, topic: topicCapped.omitted, wander: wander.omitted },
    budgetChars: BUDGET_CHARS,
  };
}
