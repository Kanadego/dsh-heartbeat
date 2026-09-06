// Digest supply layer (design doc §3.4): per-consumer slices, built fresh per
// gated model call, never persisted into any context (D7). Total budget <=800
// tokens (approximated by ~3200 chars).
//
// B6: tact includes the gate's window CLASS (busy-rules result), never the
// window title. stable entries flagged low-activity are deprioritized with an
// "unverified" note (D9).

import type { PathGuard } from '../core/path-guard.js';
import type { WorkspacePaths } from '../core/paths.js';
import type { Policy } from '../config/schema.js';
import { loadProfile, profileFilePath } from './store.js';
import { readText as vaultReadText } from '../vault/vault.js';
import { pendingOlderThan } from '../ledger/ledger.js';
import { ledgerFilePath } from '../ledger/ledger.js';

const BUDGET_CHARS = 3200; // ~800 tokens CJK-heavy

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
}

function fmtEntry(prefix: string, content: string, opts: { low?: boolean; confidence: number }): string {
  const flag = opts.low ? '（久未验证）' : '';
  return `${prefix}${content}${flag} [conf ${opts.confidence.toFixed(2)}]`;
}

export function buildDigest(guard: PathGuard, paths: WorkspacePaths, policy: Policy, input: DigestInput = {}): SituationDigest {
  const doc = loadProfile(guard, profileFilePath(paths.dataDir));
  const topN = input.topN ?? 8;

  // -- tact: rhythm summary + comm high-confidence + window class (B6)
  const rhythm = vaultReadText(guard, paths.dataDir + '/profile_rhythm.json', '');
  let rhythmLine = '作息未知（样本不足）';
  try {
    const r = JSON.parse(rhythm) as { daysSampled?: number; peakHours?: string[] };
    if (r.daysSampled && r.peakHours) {
      rhythmLine = `近期活跃时段: ${r.peakHours.slice(0, 4).join('、')}（样本 ${r.daysSampled} 天）`;
    }
  } catch {
    // no rhythm yet
  }
  const comm = doc.partitions.comm!.entries
    .filter((e) => e.validTo === null && e.confidence > 0.5)
    .map((e) => fmtEntry('- 沟通偏好: ', e.content, { low: e.lowActivity, confidence: e.confidence }));
  const tactParts = [
    `[时间感] ${rhythmLine}${input.windowClass ? ` | 当前窗口类别: ${input.windowClass}` : ''}`,
    ...comm,
  ];

  // -- topic: interest + projects valid entries, confidence x recency
  const score = (e: { confidence: number; updatedAt: string }) =>
    e.confidence * 0.7 + (1 / (1 + Math.max(0, Date.now() - Date.parse(e.updatedAt)) / 86_400_000)) * 0.3;
  const topicEntries = [...doc.partitions.interest!.entries, ...doc.partitions.projects!.entries]
    .filter((e) => e.validTo === null)
    .sort((a, b) => score(b) - score(a))
    .slice(0, topN)
    .map((e) => {
      const prefix = e.partition === 'projects' ? '- 进行中: ' : '- 兴趣: ';
      return fmtEntry(prefix, `${e.topic}/${e.subTopic}: ${e.content}`, { low: e.lowActivity, confidence: e.confidence });
    });

  // -- wander: high-confidence interests
  const wanderEntries = doc.partitions.interest!.entries
    .filter((e) => e.validTo === null && e.confidence >= 0.6 && e.subTopic === 'preference')
    .slice(0, 5)
    .map((e) => `- ${e.content} [conf ${e.confidence.toFixed(2)}]`);

  // -- ledger stale items (跟进时机)
  const stale = pendingOlderThan(guard, ledgerFilePath(paths.dataDir), 3)
    .slice(0, 3)
    .map((e) => `- ${e.text}（${e.date}）`);

  const tact = tactParts.join('\n');
  const topic = [
    ...topicEntries,
    ...(stale.length ? ['[账本待跟进] ', ...stale] : []),
  ].join('\n');
  const wander = wanderEntries.join('\n') || '(无高置信兴趣)';
  const totalChars = tact.length + topic.length + wander.length;

  // budget guard: trim the topic section first (largest, most enumerable)
  let outTopic = topic;
  if (tact.length + outTopic.length + wander.length > BUDGET_CHARS && outTopic.length > 800) {
    outTopic = outTopic.slice(0, 800) + '\n(已截断以控制预算)';
  }
  return {
    tact,
    topic: outTopic,
    wander,
    totalChars: tact.length + outTopic.length + wander.length,
    withinBudget: tact.length + outTopic.length + wander.length <= BUDGET_CHARS,
  };
}
