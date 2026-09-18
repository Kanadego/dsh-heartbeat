import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initWorkspace, resetWorkspaceForTest, workspace } from '../src/core/paths.js';
import { createPathGuard } from '../src/core/path-guard.js';
import { loadPolicy } from '../src/config/load.js';
import type { Policy } from '../src/config/schema.js';
import {
  inboxAppend,
  inboxClear,
  inboxCount,
  inboxDrain,
  inboxHealthCheck,
  dedupeItems,
  inboxFilePath,
} from '../src/profile/inbox.js';
import { runConsolidation, shouldConsolidate } from '../src/profile/consolidate.js';
import { buildDigest } from '../src/profile/digest.js';
import { recordPresence, summarizeRhythm } from '../src/rhythm/rhythm.js';
import { planBurn, executeBurn } from '../src/vault/burn-list.js';
import { appendAuditLine } from '../src/core/audit-log.js';
import type { EnvSnapshot } from '../src/env/envpulse.js';

const NOW = Date.parse('2026-09-06T12:00:00.000Z');

let sandbox = '';
let guard: ReturnType<typeof createPathGuard>;
let paths: ReturnType<typeof workspace>;
let policy: Policy;

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-flow-'));
  process.env.HEARTBEAT_DATA_DIR = path.join(sandbox, 'data');
  resetWorkspaceForTest();
  paths = initWorkspace();
  guard = createPathGuard(paths.dataDir);
  policy = loadPolicy(guard, paths.configDir, paths.settingsDir);
  appendAuditLine(path.join(paths.dataDir, 'logs', 'heartbeat.jsonl'), { event: 'test' });
});

after(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
  delete process.env.HEARTBEAT_DATA_DIR;
  resetWorkspaceForTest();
});

const inboxFile = () => inboxFilePath(paths.dataDir);

test('inbox: append/count/drain/clear with note truncation and dedupe key', () => {
  inboxAppend(guard, inboxFile(), { kind: 'chat', at: new Date(NOW).toISOString(), ref: 'logs/heartbeat.jsonl#a', note: '短观察' });
  inboxAppend(guard, inboxFile(), { kind: 'chat', at: new Date(NOW).toISOString(), ref: 'logs/heartbeat.jsonl#b', note: 'x'.repeat(300) });
  const items = inboxDrain(guard, inboxFile());
  assert.equal(items.length, 2);
  assert.ok(items[1]!.note.length <= 121); // truncated + ellipsis
  assert.equal(inboxCount(guard, inboxFile()), 2);
  // dedupe by kind+ref
  const deduped = dedupeItems([...items, items[0]!]);
  assert.equal(deduped.length, 2);
  inboxClear(guard, inboxFile());
  assert.equal(inboxCount(guard, inboxFile()), 0);
});

test('inbox health check counts corrupt and duplicate lines', async () => {
  inboxAppend(guard, inboxFile(), { kind: 'chat', at: 'x', ref: 'r1', note: 'a' });
  inboxAppend(guard, inboxFile(), { kind: 'chat', at: 'x', ref: 'r1', note: 'b' }); // duplicate key
  // inject a corrupt line through the ENCRYPTED channel (file is DPAPI at rest)
  const { loadEncryptedText, saveEncryptedText } = await import('../src/vault/vault.js');
  const raw = loadEncryptedText(guard, inboxFile()) ?? '';
  saveEncryptedText(guard, inboxFile(), raw + '{broken\n');
  const health = inboxHealthCheck(guard, inboxFile());
  assert.equal(health.total, 2);
  assert.equal(health.duplicates, 1);
  assert.equal(health.corrupt, 1);
});

test('shouldConsolidate: interval + backlog dual trigger', () => {
  const notDue = shouldConsolidate(guard, paths, policy, NOW);
  assert.equal(notDue.due, false);
  // backlog trigger
  for (let i = 0; i < policy.profile.consolidation.inboxBacklog; i++) {
    inboxAppend(guard, inboxFile(), { kind: 'chat', at: 'x', ref: `r${i}`, note: `观察${i}` });
  }
  const due = shouldConsolidate(guard, paths, policy, NOW);
  assert.equal(due.due, true);
  assert.match(due.reason, /backlog/);
});

test('consolidation: fake LLM ops applied, inbox drained only on success, journal written', async () => {
  inboxAppend(guard, inboxFile(), {
    kind: 'chat', at: new Date(NOW).toISOString(), ref: 'logs/heartbeat.jsonl#k1',
    note: '他连玩三天杀戮尖塔2',
  });
  const llm = async () => JSON.stringify([
    { op: 'ADD', partition: 'interest', topic: 'games', subTopic: 'current', content: '在玩《杀戮尖塔2》', temporal: 'volatile', confidence: 0.6, why: '观察', evidence: [{ kind: 'chat', at: new Date(NOW).toISOString(), ref: 'logs/heartbeat.jsonl#k1' }] },
    { op: 'NOOP', why: '无其他变化' },
  ]);
  const run = await runConsolidation(guard, paths, policy, llm, NOW);
  assert.equal(run.ran, true);
  assert.equal(run.applied, 2);
  assert.equal(inboxCount(guard, inboxFile()), 0); // drained after success
  const digest = buildDigest(guard, paths, policy, {});
  assert.match(digest.topic, /杀戮尖塔2/);
});

test('consolidation: unusable LLM output leaves the inbox intact (§3.7)', async () => {
  inboxAppend(guard, inboxFile(), { kind: 'screen', at: 'x', ref: 'logs/heartbeat.jsonl#k2', note: '观察' });
  const badLlm = async () => '这不是JSON';
  const run = await runConsolidation(guard, paths, policy, badLlm, NOW);
  assert.equal(run.ran, false);
  assert.equal(inboxCount(guard, inboxFile()), 1); // preserved for retry next beat
});

test('consolidation: per-run ops cap enforced', async () => {
  for (let i = 0; i < 5; i++) {
    inboxAppend(guard, inboxFile(), { kind: 'chat', at: 'x', ref: `cap${i}`, note: `观察${i}` });
  }
  const many = Array.from({ length: 20 }, (_, i) => ({
    op: 'ADD', partition: 'interest', topic: 'games', subTopic: 'preference',
    content: `条目${i}`, confidence: 0.5, why: 'x',
    evidence: [{ kind: 'chat', at: '2026-09-06T12:00:00.000Z', ref: 'logs/heartbeat.jsonl#test' }],
  }));
  const llm = async () => JSON.stringify(many);
  const run = await runConsolidation(guard, paths, policy, llm, NOW);
  assert.equal(run.ran, true);
  assert.equal(run.applied, policy.profile.maxOpsPerRun);
});

test('consolidation single-flight: second concurrent call is refused', async () => {
  inboxAppend(guard, inboxFile(), { kind: 'chat', at: 'x', ref: 'sf1', note: '观察' });
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const slowLlm = async () => { await gate; return '[]'; };
  const first = runConsolidation(guard, paths, policy, slowLlm, NOW);
  const second = await runConsolidation(guard, paths, policy, async () => '[]', NOW);
  assert.equal(second.ran, false);
  assert.match(second.reason, /single-flight/);
  release();
  await first;
});

test('digest: low-activity stable entries are flagged 久未验证; budget respected', async () => {
  const { applyOpsToDoc, loadProfile, runDeterministicAging } = await import('../src/profile/store.js');
  const { profileFilePath, persistWithJournal } = await import('../src/profile/store.js');
  const { emptyProfile } = await import('../src/profile/types.js');
  const { loadProfileSchema } = await import('../src/profile/schema.js');
  const schema = loadProfileSchema(workspace());
  const doc = emptyProfile();
  const { applyOpsToDoc: apply } = { applyOpsToDoc };
  apply(guard, paths.dataDir, doc, [
    { op: 'ADD', partition: 'comm', topic: 'expression', subTopic: 'style', content: '说话要短', confidence: 0.6, why: 'x', evidence: [{ kind: 'chat', at: '2026-01-01T00:00:00.000Z', ref: 'logs/heartbeat.jsonl#test' }] },
  ], schema, policy, Date.parse('2026-01-01T00:00:00.000Z'));
  const aged = runDeterministicAging(doc, policy, NOW); // ~250d later -> low-activity
  assert.equal(aged.lowActivityMarked, 1);
  persistWithJournal(guard, paths.dataDir, doc, { runId: 'dg', applied: [], rejected: [] });
  const saved = loadProfile(guard, profileFilePath(paths.dataDir));
  void saved;
  const digest = buildDigest(guard, paths, policy, { windowClass: 'idle' });
  assert.match(digest.tact, /久未验证/);
  assert.match(digest.tact, /窗口类别: idle/);
  assert.equal(digest.withinBudget, true);
  void inboxFile;
});

test('rhythm: presence samples aggregate into a decaying histogram', () => {
  const env = (presence: string): EnvSnapshot => ({
    takenAt: new Date(NOW).toISOString(), idleSeconds: 0, presence: presence as never,
    windowClass: 'unknown', daypart: '正午', weekday: '周日', isWeekend: true, festival: null,
  });
  for (let i = 0; i < 5; i++) recordPresence(paths, env('active'), NOW + i * 1000);
  recordPresence(paths, env('away'), NOW + 6000);
  const summary = summarizeRhythm(paths);
  assert.equal(summary.daysSampled, 1);
  assert.ok(summary.peakHours.length > 0);
  const localHour = new Date(NOW).getHours();
  assert.ok(summary.peakHours[0]!.includes(`${localHour}时`));
});

test('burn: plan previews without writing; execute shreds runtime data but preserves settings', () => {
  fs.writeFileSync(path.join(paths.dataDir, 'ledger.md'), '# 账本\n', 'utf8');
  fs.writeFileSync(path.join(paths.dataDir, 'profile.json'), '{}', 'utf8');
  fs.writeFileSync(path.join(paths.settingsDir, 'policy.json'), '{}', 'utf8');
  const plan = planBurn(guard, paths, false);
  assert.equal(plan.some((p) => p.target.file === 'ledger.md' && p.exists), true);
  const result = executeBurn(guard, paths, {});
  assert.ok(result.burned.includes('ledger.md'));
  assert.equal(fs.existsSync(path.join(paths.dataDir, 'ledger.md')), false);
  assert.equal(fs.existsSync(path.join(paths.settingsDir, 'policy.json')), true); // settings preserved
  // BURN_EVENT is the only trace, in the recreated journal
  const journal = fs.readFileSync(path.join(paths.dataDir, 'profile_journal.jsonl'), 'utf8');
  assert.match(journal, /BURN_EVENT/);
  // --all removes settings too
  const all = executeBurn(guard, paths, { all: true });
  assert.ok(all.burned.includes('settings'));
  assert.equal(fs.existsSync(paths.settingsDir), false);
});

// ── M3: chat seeds from consolidation (2026-09-18 spec ⑧) ─────────────────

test('spec ⑧: CHAT_SEED ops split out and written to the pool (category=chat)', async () => {
  inboxAppend(guard, inboxFile(), {
    kind: 'chat', at: new Date(NOW).toISOString(), ref: 'cs1',
    note: '他说想去看新上映的那部科幻片',
  });
  const llm = async () => JSON.stringify([
    { op: 'CHAT_SEED', text: '他想看新上映的科幻片', topic: '科幻片' },
    { op: 'CHAT_SEED', text: '另一个话题' },
    { op: 'NOOP', why: '无画像变化' },
  ]);
  const run = await runConsolidation(guard, paths, policy, llm, NOW);
  assert.equal(run.ran, true);
  assert.equal(run.applied, 1); // only the NOOP counts as a profile op
  assert.equal(inboxCount(guard, inboxFile()), 0);
  const { loadPool, seedsFilePath } = await import('../src/seeds/pool.js');
  const db = loadPool(guard, seedsFilePath(paths.dataDir));
  const chatSeeds = db.seeds.filter((s) => s.category === 'chat' && s.status === 'active');
  assert.equal(chatSeeds.length, 2);
  assert.ok(chatSeeds.some((s) => s.text === '他想看新上映的科幻片' && s.topic === '科幻片'));
});

test('spec ⑧: invalid CHAT_SEED rows dropped silently; per-run cap 3 enforced', async () => {
  for (let i = 0; i < 5; i++) {
    inboxAppend(guard, inboxFile(), { kind: 'chat', at: 'x', ref: `csx${i}`, note: `观察${i}` });
  }
  const llm = async () => JSON.stringify([
    { op: 'CHAT_SEED', text: '种子一' },
    { op: 'CHAT_SEED', text: '   ' },           // blank text -> dropped
    { op: 'CHAT_SEED' },                          // no text -> dropped
    { op: 'CHAT_SEED', text: '种子二' },
    { op: 'CHAT_SEED', text: '种子三' },
    { op: 'CHAT_SEED', text: '种子四' },          // beyond cap 3 -> dropped
  ]);
  const run = await runConsolidation(guard, paths, policy, llm, NOW);
  assert.equal(run.ran, true);
  const { loadPool, seedsFilePath } = await import('../src/seeds/pool.js');
  const db = loadPool(guard, seedsFilePath(paths.dataDir));
  const texts = db.seeds.filter((s) => s.category === 'chat').map((s) => s.text).sort();
  assert.deepEqual(texts, ['种子一', '种子三', '种子二']);
});

test('spec ⑧: same-topic chat seed merges into the existing row (addSeed semantics)', async () => {
  const { addSeed, loadPool, seedsFilePath } = await import('../src/seeds/pool.js');
  addSeed(guard, seedsFilePath(paths.dataDir), policy, { text: '旧的一句', topic: '科幻片', source: 'chat' }, NOW - 1000);
  for (let i = 0; i < policy.profile.consolidation.inboxBacklog; i++) {
    inboxAppend(guard, inboxFile(), { kind: 'chat', at: 'x', ref: `csm${i}`, note: `观察${i}` });
  }
  const llm = async () => JSON.stringify([
    { op: 'CHAT_SEED', text: '新的一句更准', topic: '科幻片' },
  ]);
  const run = await runConsolidation(guard, paths, policy, llm, NOW);
  assert.equal(run.ran, true);
  const db = loadPool(guard, seedsFilePath(paths.dataDir));
  const rows = db.seeds.filter((s) => s.category === 'chat' && s.status === 'active');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.text, '新的一句更准');
});
