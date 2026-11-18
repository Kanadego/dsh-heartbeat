// Rework R-A/R-B/R-C: the silence decision must look at the WHOLE reply, strip
// only wrappers at the line ends, and live in ONE shared chain (reconcileReply)
// so these tests fail if the orchestrator's order changes — no local copy of
// the judgment in the test.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  SILENCE_TEXT,
  stripWrappers,
  isSilenceOnlyLine,
  isSilenceOnlyText,
  spokenLines,
  reconcileReply,
  type DeliveryReportInput,
  type MaterialInput,
} from '../src/core/material.js';

const M: MaterialInput[] = [{ id: 's1', text: '他最近在学煮咖啡', used: 0 }];
const SILENT_REPORT: DeliveryReportInput = {
  spoken: 'silent', seedIds: [], profileIds: [], reason: '不想说话', deliveryId: 'dsil0001',
};

function reconcile(raw: string) {
  return reconcileReply(raw, SILENT_REPORT, [], M);
}

// P15-1: fixtures build the tags by concatenation on purpose — one contiguous
// literal in source would truncate a model stream mid-sentence, the same hazard
// the production comment in material.ts describes.
const LT = String.fromCharCode(60);
const GT = String.fromCharCode(62);
const openTag = (attrs = ''): string => LT + 'thinking' + attrs + GT;
const closeTag = (gap = ''): string => LT + '/thinking' + gap + GT;

test('default rhythm: a silence-only reply reconciles as silent, not heartfelt', () => {
  const r = reconcile(SILENCE_TEXT);
  assert.equal(r.text, SILENCE_TEXT);
  assert.equal(r.spokeText, true, 'the line is Chinese — there is text in the reply');
  assert.equal(r.silenceOnly, true);
  assert.equal(r.effectiveSpokeText, false);
  assert.equal(r.account.spoken, 'silent');
  assert.equal(r.account.source, 'report');
  assert.equal(r.account.reason, '不想说话');
});

test('R-A: a real sentence followed by the silence line is SPEECH, not silence', () => {
  const r = reconcile(`我真有点想跟你说,今天特别累\n${SILENCE_TEXT}`);
  assert.equal(r.silenceOnly, false, 'the sentence is already visible — the whole reply counts');
  assert.equal(r.effectiveSpokeText, true);
  assert.equal(r.account.spoken, 'heartfelt');
  assert.equal(r.account.source, 'report');
});

test('R-A: the silence line twice (or with blank/thinking lines) is still silence', () => {
  for (const raw of [
    `${SILENCE_TEXT}\n${SILENCE_TEXT}`,
    `\n${SILENCE_TEXT}\n\n`,
    `${openTag()}要不要说呢${closeTag()}\n${SILENCE_TEXT}`,
  ]) {
    const r = reconcile(raw);
    assert.equal(r.silenceOnly, true, JSON.stringify(raw));
    assert.equal(r.account.spoken, 'silent', JSON.stringify(raw));
  }
});

test('R-A: a parenthetical aside before the line is speech (（好吧……） counts)', () => {
  const r = reconcile(`（好吧……）\n${SILENCE_TEXT}`);
  assert.equal(r.silenceOnly, false);
  assert.equal(r.account.spoken, 'heartfelt');
});

test('R-A: a silence line followed by a real sentence is speech → heartfelt', () => {
  const r = reconcile(`${SILENCE_TEXT}，不过今天有点累，想早点睡`);
  assert.equal(r.silenceOnly, false);
  assert.equal(r.account.spoken, 'heartfelt');
});

test('R-B: wrappers at the line ends keep it silence (quotes, brackets, punctuation)', () => {
  for (const raw of [
    `（${SILENCE_TEXT}）`,
    `【${SILENCE_TEXT}】`,
    `《${SILENCE_TEXT}》`,
    `「${SILENCE_TEXT}！」`,
    `"${SILENCE_TEXT}。"`,
    `[${SILENCE_TEXT}]`,
    `\u200B${SILENCE_TEXT}\u200B`,
    `\u3000${SILENCE_TEXT}`,
    `${SILENCE_TEXT}～`,
    `  ${SILENCE_TEXT}……  `,
  ]) {
    assert.equal(isSilenceOnlyLine(raw), true, JSON.stringify(raw));
  }
});

test('R-B: inner characters are never deleted — spliced or extended lines are speech', () => {
  for (const raw of [
    '『本』轮沉默',
    '「本轮」「沉默」',
    `${SILENCE_TEXT}🙂`,
    `${SILENCE_TEXT}\n沉默`,
    `${SILENCE_TEXT}，不过今天有点累。`,
    `${SILENCE_TEXT}${SILENCE_TEXT}`,
    '嗯',
    '',
  ]) {
    assert.equal(isSilenceOnlyLine(raw), false, JSON.stringify(raw));
  }
});

test('stripWrappers only trims the ends and never touches the middle', () => {
  assert.equal(stripWrappers(`「${SILENCE_TEXT}」`), SILENCE_TEXT);
  assert.equal(stripWrappers('『本』轮沉默'), '本』轮沉默');
  assert.equal(stripWrappers('  a b  '), 'a b');
  assert.equal(stripWrappers(''), '');
});

test('isSilenceOnlyText: every non-empty line must be the bare line', () => {
  assert.equal(isSilenceOnlyText(`${SILENCE_TEXT}`), true);
  assert.equal(isSilenceOnlyText(`${SILENCE_TEXT}\n【${SILENCE_TEXT}】`), true);
  assert.equal(isSilenceOnlyText(`真话\n${SILENCE_TEXT}`), false);
  assert.equal(isSilenceOnlyText(`${SILENCE_TEXT}\n真话`), false);
  assert.equal(isSilenceOnlyText(''), false);
  assert.equal(isSilenceOnlyText('<tool_calls>\n</tool_calls>'), false, 'no content line at all is not a silence');
});

test('P15-1: a real thinking pair before the silence line still reconciles as silence', () => {
  const r = reconcile(openTag() + '要不要说呢' + closeTag() + '\n' + SILENCE_TEXT);
  assert.equal(r.silenceOnly, true);
  assert.equal(r.account.spoken, 'silent');
});

test('P15-1: opening tag with attributes and a closing tag with padding stay paired', () => {
  const attrs = reconcile(openTag(' data-plan="hide"') + '想一想' + closeTag() + '\n' + SILENCE_TEXT);
  assert.equal(attrs.silenceOnly, true);
  assert.equal(attrs.account.spoken, 'silent');
  const padded = reconcile(openTag() + '想一想' + closeTag(' ') + '\n' + SILENCE_TEXT);
  assert.equal(padded.silenceOnly, true);
  assert.equal(padded.account.spoken, 'silent');
});

test('P15-1: an unclosed opening tag drops everything from it to the end', () => {
  const raw = SILENCE_TEXT + '\n' + openTag() + '被截断了,后面没有闭标签';
  const r = reconcile(raw);
  assert.equal(r.silenceOnly, true);
  assert.equal(r.account.spoken, 'silent');
  assert.deepEqual(spokenLines(raw), [SILENCE_TEXT]);
});

test('P15-1 regression: a real sentence before the silence line is still speech', () => {
  const r = reconcile('我真有点想跟你说,今天特别累\n' + SILENCE_TEXT);
  assert.equal(r.silenceOnly, false);
  assert.equal(r.effectiveSpokeText, true);
  assert.equal(r.account.spoken, 'heartfelt');
});
