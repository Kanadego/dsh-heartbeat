// P1-2 (2.3.0, 账本 #00b1a5): silence is decided by the FACTS of the reply
// (body empty or not), not by the report's self-declaration. The one judgment
// chain is reconcileReply/pickSpokenLine; these tests pin its verdicts and the
// reference/mismatch outputs the orchestrator audits.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  SILENCE_TEXT,
  TURN_END_SILENCE_KIND,
  deliveryVerdict,
  reconcileReply,
  type DeliveryReportInput,
  type MaterialInput,
  type SpokenKind,
} from '../src/core/material.js';
import { classifySilentReason, silentAuditLine } from '../src/core/orchestrator.js';

const M: MaterialInput[] = [{ id: 's1', text: '他最近在学煮咖啡', used: 0 }];

function report(spoken: SpokenKind, extra: Partial<DeliveryReportInput> = {}): DeliveryReportInput {
  return { spoken, seedIds: spoken === 'material' ? ['s1'] : [], profileIds: [], deliveryId: 'dfact001', ...extra };
}

// P15-1 fixture rule: build the tags by concatenation, never as one literal.
const LT = String.fromCharCode(60);
const GT = String.fromCharCode(62);
const thinkingOnly = `${LT}thinking${GT}要不要说呢${LT}/thinking${GT}`;

test('P1-2: an empty body + a heartfelt report settles as SILENT, with a mismatch', () => {
  for (const raw of ['', '\n\n', '   \n\t', thinkingOnly]) {
    const r = reconcileReply(raw, report('heartfelt'), [], M);
    assert.equal(r.effectiveSpokeText, false, JSON.stringify(raw));
    assert.equal(r.account.spoken, 'silent', JSON.stringify(raw));
    assert.equal(r.reportedSpoken, 'heartfelt');
    assert.deepEqual(r.spokenMismatch, { reported: 'heartfelt', actual: 'silent' }, JSON.stringify(raw));
  }
});

test('P1-2: an empty body + a material report is likewise settled as SILENT', () => {
  const r = reconcileReply('', report('material'), [], M);
  assert.equal(r.account.spoken, 'silent');
  assert.deepEqual(r.spokenMismatch, { reported: 'material', actual: 'silent' });
});

test('P1-2: body text + a silent report settles as HEARTFELT, with a mismatch', () => {
  const r = reconcileReply('今天有点累，想早点睡', report('silent', { reason: '不想说话' }), [], M);
  assert.equal(r.effectiveSpokeText, true);
  assert.equal(r.account.spoken, 'heartfelt');
  assert.equal(r.account.source, 'report', 'the settled books still trust the report source');
  assert.deepEqual(r.spokenMismatch, { reported: 'silent', actual: 'heartfelt' });
});

test('P1-2: agreement is zero noise', () => {
  const quiet = reconcileReply(SILENCE_TEXT, report('silent', { reason: '不想说话' }), [], M);
  assert.equal(quiet.account.spoken, 'silent');
  assert.equal(quiet.reportedSpoken, 'silent');
  assert.equal(quiet.spokenMismatch, null);

  const heartfelt = reconcileReply('今天有点累', report('heartfelt'), [], M);
  assert.equal(heartfelt.account.spoken, 'heartfelt');
  assert.equal(heartfelt.spokenMismatch, null);

  const material = reconcileReply('说到咖啡，我最近也在喝', report('material'), [], M);
  assert.equal(material.account.spoken, 'material');
  assert.deepEqual(material.account.seedIds, ['s1']);
  assert.equal(material.spokenMismatch, null);
});

test('P1-2: no report means no reference and no mismatch', () => {
  for (const raw of ['说点什么', '']) {
    const r = reconcileReply(raw, null, [], M);
    assert.equal(r.reportedSpoken, null, JSON.stringify(raw));
    assert.equal(r.spokenMismatch, null, JSON.stringify(raw));
  }
});

test('P1-2: claiming material with no valid id keeps the v1.9.0 downgrade (reference only)', () => {
  const r = reconcileReply('说了一段话', report('material', { seedIds: ['s9'] }), [], M);
  assert.equal(r.account.spoken, 'heartfelt');
  assert.deepEqual(r.account.seedIds, []);
  assert.deepEqual(r.spokenMismatch, { reported: 'material', actual: 'heartfelt' });
});

// ── attempt 3: the FACT alone settles a silent beat ──────────────────────
// The report is a reference; a rejected/missing report must not demote a
// silent beat to spoke_failed, and a silence-line body is a fact too.

test('P1-2: an empty body with NO report is still a silent beat, zero noise', () => {
  const r = reconcileReply('', null, [], M);
  assert.equal(r.effectiveSpokeText, false);
  assert.equal(r.account.spoken, 'silent');
  assert.equal(r.reportedSpoken, null);
  assert.equal(r.spokenMismatch, null);
  const v = deliveryVerdict(r, 'completed');
  assert.equal(v.factSilent, true);
  assert.equal(v.bodyEmpty, true);
  assert.equal(v.silentReason, '正文为空');
  // blocked means the model was never asked — never a fact about speech
  assert.equal(deliveryVerdict(r, 'blocked').factSilent, false);
  // N15①: an error end is a FAILED turn, not a chosen silence — same
  // exclusion as blocked (the real cause rides in turn_extraction_empty /
  // turn_concluded audits, and the silent line now carries turnEndKind too).
  assert.equal(deliveryVerdict(r, 'error').factSilent, false);
});

test('P1-2: an empty body overrides a heartfelt report with exactly one mismatch', () => {
  const r = reconcileReply('', report('heartfelt'), [], M);
  const v = deliveryVerdict(r, 'completed');
  assert.equal(v.factSilent, true);
  assert.match(v.silentReason ?? '', /按事实记沉默/);
  assert.deepEqual(r.spokenMismatch, { reported: 'heartfelt', actual: 'silent' });
});

// ── B2 中2 (2.3.0): the end kind is an ALLOWLIST — only 'completed' may ──
// carry a fact-silence. DSH's real TurnEndReasonMap also has aborted /
// interrupted / max-tokens / forked; every one of them means the reply was
// cut short, and filing that as "she chose silence" is exactly the N15①
// misfiling. Unknown kinds and a missing turn/end fail closed the same way.

test('B2 中2: only a completed end can carry a fact-silence (all failure kinds excluded)', () => {
  const r = reconcileReply('', null, [], M);
  assert.equal(r.bodyEmpty, true);
  const ok = deliveryVerdict(r, 'completed');
  assert.equal(ok.factSilent, true);
  assert.equal(ok.silentReason, '正文为空');
  for (const kind of ['blocked', 'error', 'aborted', 'interrupted', 'max-tokens', 'forked'] as const) {
    assert.equal(deliveryVerdict(r, kind).factSilent, false, `${kind} must be spoke_failed, not silence`);
  }
  // no turn/end at all (defensive: the delivery turn settled, so this should
  // not happen) — no completed end, no fact-silence
  assert.equal(deliveryVerdict(r, null).factSilent, false, 'null kind fails closed');
  // a kind this codebase has never heard of fails closed too
  assert.equal(deliveryVerdict(r, 'some-future-kind').factSilent, false, 'unknown kind fails closed');
  // and the allowlist applies to the silence-line body exactly the same way
  const line = reconcileReply(SILENCE_TEXT, null, [], M);
  assert.equal(deliveryVerdict(line, 'max-tokens').factSilent, false, 'silence-line body is no exception');
});

test('P1-2: aligned facts and reports produce no mismatch at all', () => {
  const cases: [string, SpokenKind][] = [
    ['今天有点累', 'heartfelt'],
    ['说到咖啡，我最近也在喝', 'material'],
    [SILENCE_TEXT, 'silent'],
  ];
  for (const [raw, spoken] of cases) {
    assert.equal(reconcileReply(raw, report(spoken), [], M).spokenMismatch, null, raw);
  }
});

test('P1-2: a body that is only the silence line, with no report, is silence', () => {
  const r = reconcileReply(SILENCE_TEXT, null, [], M);
  assert.equal(r.silenceOnly, true);
  assert.equal(r.effectiveSpokeText, false);
  assert.equal(r.account.spoken, 'silent');
  assert.equal(r.spokenMismatch, null);
  const v = deliveryVerdict(r, 'completed');
  assert.equal(v.factSilent, true);
  assert.equal(v.bodyEmpty, false);
  assert.equal(v.silentReason, '正文只有沉默行');
});

// ── N15④ (2.3.0): the three boundary verdicts nothing pinned before ──────

test('N15④: a declared silence keeps its reason as 报账沉默:<reason>', () => {
  const r = reconcileReply(SILENCE_TEXT, report('silent', { reason: '不想说话' }), [], M);
  const v = deliveryVerdict(r, 'completed');
  assert.equal(v.factSilent, true);
  assert.equal(v.silentReason, '报账沉默:不想说话');
  // a declared silence with no reason still says so, instead of a bare word
  const bare = reconcileReply('', report('silent'), [], M);
  assert.equal(deliveryVerdict(bare, 'completed').silentReason, '报账沉默:未说明');
});

test('N15④: a silence-line body over a contradicting report names both sides', () => {
  // the reply IS only the silence line, but the report claims material —
  // the audit must carry both the fact AND the claimed spoken
  const r = reconcileReply(SILENCE_TEXT, report('material'), [], M);
  const v = deliveryVerdict(r, 'completed');
  assert.equal(v.factSilent, true);
  assert.equal(v.bodyEmpty, false);
  assert.equal(v.silentReason, '按事实记沉默(报账 spoken=material,正文只有沉默行)');
});

test('N15④: a non-Chinese body is NOT a fact-silence — it is a failed speech attempt', () => {
  // N15④③: text existed, so the FACT says something was said; it only died at
  // the Chinese gate. deliveryVerdict must leave it factSilent=false so the
  // orchestrator files spoke_failed ('non-Chinese output discarded') — record
  // this on purpose: it once looked like the silent branch's job.
  const r = reconcileReply('hello world, just thinking out loud', null, [], M);
  assert.equal(r.silenceOnly, false);
  assert.equal(r.bodyEmpty, false);
  const v = deliveryVerdict(r, 'completed');
  assert.equal(v.factSilent, false);
  assert.equal(v.silentReason, null);
});

// ── B2 中5 (2.3.0): the N15① audit fields are pinned, not just implemented ─
// The 'silent' line rides reportedSpoken (the agent's claimed spoken) and
// turnEndKind (which way the turn actually ended) so a fact-silence can never
// again be confused with a failed end in the audit alone.

test('B2 中5: the silent audit line carries reportedSpoken and turnEndKind', () => {
  const declared = reconcileReply(SILENCE_TEXT, report('silent', { reason: '不想说话' }), [], M);
  const declaredLine = silentAuditLine(deliveryVerdict(declared, 'completed'), declared.reportedSpoken, 'completed');
  assert.deepEqual(declaredLine, {
    event: 'silent',
    reason: '报账沉默:不想说话',
    reportedSpoken: 'silent',
    turnEndKind: 'completed',
  });

  const bare = reconcileReply('', null, [], M);
  const bareLine = silentAuditLine(deliveryVerdict(bare, 'completed'), bare.reportedSpoken, 'completed');
  assert.deepEqual(bareLine, {
    event: 'silent',
    reason: '正文为空',
    turnEndKind: 'completed',
  }, 'no report → no reportedSpoken field; turnEndKind still rides along');
});

test('B2 中5: the audit line stays lean when the end kind is unknown', () => {
  const r = reconcileReply('', null, [], M);
  const line = silentAuditLine(deliveryVerdict(r, 'some-future-kind'), null, null);
  assert.deepEqual(line, { event: 'silent', reason: '正文为空' }, 'null references produce no fields');
});

// ── B2 rework 低2 (2.3.0): with the switch off (or no conclude request this
// turn), an empty body produces BOTH turn_extraction_empty (agentTurn's fault
// line) and this silent line. The reason is suffixed so the two co-occurring
// lines read as one story instead of "statusbar silent vs audit fault";
// DESIGN.md §B pins the co-occurrence.

test('B2 低2: an unconcluded empty body is suffixed (回合无输出); the conclude path stays lean', () => {
  const r = reconcileReply('', null, [], M);
  const v = deliveryVerdict(r, 'completed');
  // fault line co-occurring → the suffix marks the same fact
  assert.equal(silentAuditLine(v, null, 'completed', true).reason, '正文为空（回合无输出）');
  // the 3-arg default (conclude path / existing callers) is untouched
  assert.equal(silentAuditLine(v, null, 'completed').reason, '正文为空');
  assert.equal(silentAuditLine(v, null, 'completed', false).reason, '正文为空');
  // a silence-LINE body never gets the suffix: text existed, no fault line
  const line = reconcileReply(SILENCE_TEXT, null, [], M);
  assert.equal(silentAuditLine(deliveryVerdict(line, 'completed'), null, 'completed', true).reason, '正文只有沉默行');
  // a declared silence with an empty body keeps its reason under the suffix
  const declared = reconcileReply('', report('silent', { reason: '不想说话' }), [], M);
  assert.equal(
    silentAuditLine(deliveryVerdict(declared, 'completed'), declared.reportedSpoken, 'completed', true).reason,
    '报账沉默:不想说话（回合无输出）',
  );
});

// ── B2 rework 低3 (2.3.0): ONE source of truth for the allowlist boundary ─
// classifySilentReason must consult material's TURN_END_SILENCE_KIND, not its
// own 'completed' literal — otherwise retyping the allowlist in material.ts
// forks the two callers (deliveryVerdict would treat the new kind as a
// conclusion while classifySilentReason still files it as a failure).

test('B2 低3: the allowlist boundary IS the shared constant — retyping it moves both callers', () => {
  // the constant is pinned to the DSH real kind (B2 低7's follow-through)
  assert.equal(TURN_END_SILENCE_KIND, 'completed');
  // classifySilentReason's boundary rides the SAME constant: retyping
  // TURN_END_SILENCE_KIND goes red here AND in the deliveryVerdict allowlist
  // test above — before 低3 the literal kept this assertion green while the
  // rest of the system moved, so the fork was invisible at this call site.
  assert.equal(classifySilentReason('', TURN_END_SILENCE_KIND), 'empty model output');
});
