import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendAuditLine } from '../src/core/audit-log.js';
import { initWorkspace, resetWorkspaceForTest, workspace } from '../src/core/paths.js';
import { createPathGuard } from '../src/core/path-guard.js';
import { loadPolicy } from '../src/config/load.js';
import { appendEntry, ledgerFilePath, markDone } from '../src/ledger/ledger.js';
import { persistWithJournal } from '../src/profile/store.js';
import { snapshotProfile } from '../src/profile/snapshot.js';
import { savePool, seedsFilePath } from '../src/seeds/pool.js';
import type { SeedDb } from '../src/seeds/types.js';
import { collectWeeklyFacts } from '../src/weekly/collect.js';
import {
  weeklyDue,
  ensureWeeklyAnchor,
  saveWeeklyReport,
  listWeeklyReports,
  readWeeklyReport,
  renderTemplateReport,
  buildWeeklyPrompt,
  WEEKLY_INTERVAL_MS,
  weeklyDirPath,
} from '../src/weekly/report.js';

let sandbox = '';
let guard: ReturnType<typeof createPathGuard>;

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-weekly-'));
  process.env.HEARTBEAT_DATA_DIR = path.join(sandbox, 'data');
  resetWorkspaceForTest();
  initWorkspace();
  guard = createPathGuard(workspace().dataDir);
});

after(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
  delete process.env.HEARTBEAT_DATA_DIR;
  resetWorkspaceForTest();
});

const policy = () => loadPolicy(guard, workspace().configDir, workspace().settingsDir);

test('weeklyDue: a fresh install is anchored (waits a full week), a saved report resets the clock', () => {
  const now = Date.parse('2026-10-05T12:00:00');
  const dataDir = workspace().dataDir;
  // raw predicate: no anchor yet = "due" — the orchestrator always anchors first
  assert.equal(weeklyDue(guard, dataDir, now), true);
  // v1.9.0: the first maintenance beat anchors instead of generating, so the
  // first report lands ~7 days after installation (what the release notes say)
  assert.equal(ensureWeeklyAnchor(guard, dataDir, now), true);
  assert.equal(weeklyDue(guard, dataDir, now), false);
  assert.equal(weeklyDue(guard, dataDir, now + 6 * 86_400_000), false);
  assert.equal(weeklyDue(guard, dataDir, now + 8 * 86_400_000), true);
  // idempotent: a later beat must not push the anchor forward
  assert.equal(ensureWeeklyAnchor(guard, dataDir, now + 3 * 86_400_000), false);
  assert.equal(weeklyDue(guard, dataDir, now + 8 * 86_400_000), true);

  saveWeeklyReport(guard, dataDir, {
    start: new Date(now - WEEKLY_INTERVAL_MS).toISOString(),
    end: new Date(now).toISOString(),
    generatedAt: new Date(now).toISOString(),
    source: 'template',
    text: '第一份',
  });
  assert.equal(weeklyDue(guard, dataDir, now), false);
  assert.equal(weeklyDue(guard, dataDir, now + 8 * 86_400_000), true);
});

test('save/list/read roundtrip: newest first, filename allowlist enforced', () => {
  const dataDir = workspace().dataDir;
  const older = Date.parse('2026-09-21T12:00:00');
  const newer = Date.parse('2026-09-28T12:00:00');
  saveWeeklyReport(guard, dataDir, {
    start: new Date(older - 86_400_000 * 7).toISOString(), end: new Date(older).toISOString(),
    generatedAt: new Date(older).toISOString(), source: 'llm', text: '旧的一期',
  });
  saveWeeklyReport(guard, dataDir, {
    start: new Date(newer - 86_400_000 * 7).toISOString(), end: new Date(newer).toISOString(),
    generatedAt: new Date(newer).toISOString(), source: 'template', text: '新的一期',
  });
  const list = listWeeklyReports(guard, dataDir);
  assert.equal(list.length, 2);
  assert.equal(list[0]!.file, 'report-2026-09-28.json');
  assert.equal(readWeeklyReport(guard, dataDir, list[0]!.file)!.text, '新的一期');
  // traversal / odd names never resolve
  assert.equal(readWeeklyReport(guard, dataDir, '../settings/ui.json'), null);
  assert.equal(readWeeklyReport(guard, dataDir, 'state.json'), null);
});

test('collectWeeklyFacts: audit, journal, ledger and pool all land in the facts', () => {
  const now = Date.parse('2026-10-05T12:00:00');
  const paths = workspace();
  const auditFile = paths.logsDir + '/heartbeat.jsonl';
  const iso = (t: number): string => new Date(t).toISOString();
  // audit: 2 spoken, 3 silent (2 busy + 1 quiet), 4 observed items; one stale spoke outside the window
  appendAuditLine(auditFile, { event: 'spoke', ts: iso(now - 86_400_000) });
  appendAuditLine(auditFile, { event: 'spoke', ts: iso(now - 2 * 86_400_000) });
  appendAuditLine(auditFile, { event: 'silent', reason: 'busy window (work)', ts: iso(now - 86_400_000) });
  appendAuditLine(auditFile, { event: 'silent', reason: 'busy window (work)', ts: iso(now - 2 * 86_400_000) });
  appendAuditLine(auditFile, { event: 'silent', reason: 'quiet hours', ts: iso(now - 3 * 86_400_000) });
  appendAuditLine(auditFile, { event: 'observed', added: 4, ts: iso(now - 86_400_000) });
  appendAuditLine(auditFile, { event: 'spoke', ts: iso(now - 20 * 86_400_000) }); // outside 7d

  // journal: one ADD inside, one outside the window
  persistWithJournal(guard, paths.dataDir, {
    version: 1,
    partitions: { interest: { entries: [] }, projects: { entries: [] }, comm: { entries: [] }, psy: { entries: [] } },
  }, {
    runId: 'r1',
    applied: [{ op: 'ADD', partition: 'interest', topic: 'audio', subTopic: 'podcast', content: '在折腾播客工具', confidence: 0.5, temporal: 'stable', evidence: [], assignedId: 'a1' } as never],
    rejected: [],
  });
  // backdate the journal line to inside the window: rewrite the file with an old ts
  const journalFile = path.join(paths.dataDir, 'profile_journal.jsonl');
  const journalRaw = fs.readFileSync(journalFile, 'utf8')
    .replace(/"ts":"[^"]*"/, `"ts":"${iso(now - 86_400_000)}"`);
  fs.writeFileSync(journalFile, journalRaw, 'utf8');

  // ledger: one added this week, one done this week, one stale open (20 days old)
  const lf = ledgerFilePath(paths.dataDir);
  appendEntry(guard, lf, '重装 WSL', now - 20 * 86_400_000);
  appendEntry(guard, lf, '新的事项', now - 2 * 86_400_000);
  const doneEntry = appendEntry(guard, lf, '已完成的事项', now - 3 * 86_400_000);
  markDone(guard, lf, doneEntry.id, now);

  // pool: one fresh add, one consumed this week, one waiting (never used), one already used
  const seed = (over: Partial<SeedDb['seeds'][number]>): SeedDb['seeds'][number] => ({
    id: over.id ?? 's1',
    text: over.text ?? 'x',
    topic: over.topic ?? 't',
    tag: 'news',
    source: 'browse',
    category: 'topic',
    confidence: 0.5,
    protected: false,
    used: 0,
    bornAt: iso(now - 86_400_000),
    expiresAt: iso(now + 86_400_000),
    lastUsedAt: null,
    lastEvidenceAt: iso(now - 86_400_000),
    status: 'active',
    ...over,
  } as SeedDb['seeds'][number]);
  savePool(guard, seedsFilePath(paths.dataDir), {
    seq: 4,
    seeds: [
      seed({ id: 's1', text: 'TS 7.0 发布说明' }),
      seed({ id: 's2', text: '已消费素材', status: 'archived', retireReason: 'consumed', retiredAt: iso(now - 86_400_000) }),
      seed({ id: 's3', text: '在等的素材', bornAt: iso(now - 10 * 86_400_000) }),
      seed({ id: 's4', text: '用过的素材', used: 1, lastUsedAt: iso(now - 86_400_000) }),
    ],
  } as SeedDb);

  const facts = collectWeeklyFacts(guard, paths, policy(), now);
  assert.equal(facts.spoken, 2);
  assert.equal(facts.silent, 3);
  assert.equal(facts.silentTopReasons[0]!.reason, 'busy window (work)');
  assert.equal(facts.observedItems, 4);
  assert.equal(facts.profileAdds.length, 1);
  assert.equal(facts.profileAdds[0]!.content, '在折腾播客工具');
  assert.deepEqual(facts.ledger.added, ['新的事项']);
  assert.deepEqual(facts.ledger.done, ['已完成的事项']); // markDone restamps the date
  assert.deepEqual(facts.ledger.stale.map((s) => s.text), ['重装 WSL']);
  assert.equal(facts.seeds.poolActive, 3);
  assert.deepEqual(facts.seeds.consumed, ['已消费素材']);
  assert.deepEqual(facts.seeds.waiting, ['TS 7.0 发布说明', '在等的素材']); // used===0, newest bornAt first
  assert.ok(facts.seeds.added.includes('TS 7.0 发布说明'));
});

test('renderTemplateReport: includes present sections, skips empty ones', () => {
  const now = Date.parse('2026-10-05T12:00:00');
  const base = collectWeeklyFacts(guard, workspace(), policy(), now);
  const text = renderTemplateReport(base);
  assert.ok(text.includes('表达 0 次'));
  assert.ok(!text.includes('挂了很久')); // empty stale section skipped
  assert.ok(!text.includes('活跃高峰')); // no rhythm data

  const withStale = renderTemplateReport({
    ...base,
    ledger: { ...base.ledger, stale: [{ text: '重装 WSL', days: 12 }] },
  });
  assert.ok(withStale.includes('重装 WSL（12 天）'));
  assert.ok(withStale.includes('删掉还是继续挂着'));
});

test('buildWeeklyPrompt: narrator rules and facts are both present', () => {
  const now = Date.parse('2026-10-05T12:00:00');
  const prompt = buildWeeklyPrompt(collectWeeklyFacts(guard, workspace(), policy(), now));
  assert.ok(prompt.includes('自称「心跳」'));
  assert.ok(prompt.includes('本周事实'));
  assert.ok(prompt.includes('windowStart'));
  void weeklyDirPath;
});

test('v1.9.0: unaccounted deliveries surface in the report instead of hiding', () => {
  const now = Date.parse('2026-10-05T12:00:00');
  const facts = collectWeeklyFacts(guard, workspace(), policy(), now);
  assert.equal(facts.reports.missing, 0);
  const text = renderTemplateReport({ ...facts, reports: { ...facts.reports, missing: 2 } });
  assert.ok(text.includes('2 次投递没等到报账'));
});

test('H-01: a rotated journal (archive shard) still feeds profileAdds', () => {
  const now = Date.parse('2026-10-05T12:00:00');
  const paths = workspace();
  const iso = (t: number): string => new Date(t).toISOString();
  persistWithJournal(guard, paths.dataDir, {
    version: 1,
    partitions: { interest: { entries: [] }, projects: { entries: [] }, comm: { entries: [] }, psy: { entries: [] } },
  }, {
    runId: 'r1',
    applied: [{ op: 'ADD', partition: 'interest', topic: 'audio', subTopic: 'podcast', content: '在折腾播客工具', confidence: 0.5, temporal: 'stable', evidence: [], assignedId: 'a1' } as never],
    rejected: [],
  });
  const journalFile = path.join(paths.dataDir, 'profile_journal.jsonl');
  fs.writeFileSync(journalFile, fs.readFileSync(journalFile, 'utf8').replace(/"ts":"[^"]*"/, `"ts":"${iso(now - 86_400_000)}"`), 'utf8');

  // Rotate exactly like the maintenance phase does: fold into the snapshot and
  // move the records into an archive shard, leaving the live journal empty.
  // The week's ADD must survive that move — before H-01 was fixed it vanished
  // and the report claimed the profile had learned nothing all week.
  assert.equal(snapshotProfile(guard, paths.dataDir, now).ok, true);
  assert.equal(fs.readFileSync(journalFile, 'utf8'), '');

  const facts = collectWeeklyFacts(guard, paths, policy(), now);
  assert.equal(facts.profileAdds.length, 1);
  assert.equal(facts.profileAdds[0]!.content, '在折腾播客工具');
});
