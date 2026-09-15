// Material delivery pure functions (redesign 2026-09-16): buildMaterialPrompt,
// buildRuminationPrompt, attributionIds, wantHonestOption, materialLines, PACKAGE_DECLARE.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  PACKAGE_DECLARE,
  buildMaterialPrompt,
  buildRuminationPrompt,
  attributionIds,
  wantHonestOption,
  materialLines,
  type MaterialInput,
} from '../src/core/material.js';

const M0: MaterialInput = { id: 's1', text: '他最近在学煮咖啡', used: 0 };
const M1: MaterialInput = { id: 's2', text: '昨天他说那只橘猫又来了', used: 0 };
const M2: MaterialInput = { id: 's3', text: '他提到想换一块机械键盘', used: 1 };
const M3: MaterialInput = { id: 's4', text: '他们一起看完了那部电影', used: 1 };

test('PACKAGE_DECLARE: section ① is the heartbeat material delivery declaration', () => {
  assert.ok(PACKAGE_DECLARE.includes('这是心跳插件素材投递'));
  assert.ok(PACKAGE_DECLARE.includes('判断要不要选一条说'));
});

test('materialLines: each material becomes one trimmed line, no reasons, no order', () => {
  const lines = materialLines([M0, M2]);
  assert.deepStrictEqual(lines, [M0.text, M2.text]);
  assert.ok(lines.every((l) => typeof l === 'string' && l.length > 0));
});

test('wantHonestOption: true only when 2+ materials have used >= 1', () => {
  assert.strictEqual(wantHonestOption([M0, M1, M2]), false); // only 1 used
  assert.strictEqual(wantHonestOption([M0, M2, M3]), true);  // 2 used
  assert.strictEqual(wantHonestOption([M0, M1]), false);       // 0 used
  assert.strictEqual(wantHonestOption([],), false);
  // custom threshold
  assert.strictEqual(wantHonestOption([M0, M2], 1), true);
});

test('buildMaterialPrompt: sections ①+② always, section ③ only when 2+ used', () => {
  const p0 = buildMaterialPrompt([M0, M1]); // 0 used -> no honest line
  assert.ok(p0.includes(PACKAGE_DECLARE));
  assert.ok(p0.includes('- ' + M0.text));
  assert.ok(p0.includes('- ' + M1.text));
  assert.ok(!p0.includes('真心话'));

  const p1 = buildMaterialPrompt([M0, M2]); // 1 used
  assert.ok(!p1.includes('真心话'));

  const p2 = buildMaterialPrompt([M2, M3]); // 2 used -> honest line
  assert.ok(p2.includes('真心话'));
  assert.ok(p2.includes('不带素材'));
});

test('buildRuminationPrompt: picks from candidates, one sentence per line, JSON speak/text/seed_ids', () => {
  const prompt = buildRuminationPrompt({ digestTact: 't', digestTopic: 'top', staleLedger: '', candidates: 's1: a\ns2: b', max: 3 });
  assert.ok(prompt.includes('反刍备料'));
  assert.ok(prompt.includes('s1: a'));
  assert.ok(prompt.includes('speak'));
  assert.ok(prompt.includes('seed_ids'));
  assert.ok(prompt.includes('最多 3 条'));
});

test('attributionIds: explicit seed_ids first', () => {
  const out = attributionIds([M0, M1], '他最近在学煮咖啡真有意思', ['s1']);
  assert.deepStrictEqual(out, ['s1']);
});

test('attributionIds: containment match fallback (>=8-char prefix) when no explicit id', () => {
  const out = attributionIds([M0, M2], M0.text + ' 之后我也试了');
  assert.deepStrictEqual(out, ['s1']);
  assert.ok(out.includes('s1'));
});

test('attributionIds: no credit for a material whose text is absent from the output', () => {
  const out = attributionIds([M0, M1], '我今天特别想吃火锅');
  assert.deepStrictEqual(out, []);
});

test('attributionIds: short (<8 char) material never credited by containment', () => {
  const short: MaterialInput = { id: 'sX', text: '短', used: 0 };
  const out = attributionIds([short], short.text);
  assert.deepStrictEqual(out, []);
});
