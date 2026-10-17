// 心事匣 (notepad, v2.0): one-slot memo + its lifecycle.
//
// The lifecycle is the part worth testing, because it is the part that is easy
// to get wrong: "shown on an earlier beat and never touched since" is decided
// by TWO ordinals (shownAtBeat vs touchedAtBeat), and the reason the comparison
// is strict is that a note born or kept during this very beat's turn must not be
// eaten by the delivery that just carried it.

import { sandboxDir } from './_sandbox.js';
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { initWorkspace, resetWorkspaceForTest, workspace } from '../src/core/paths.js';
import { createPathGuard } from '../src/core/path-guard.js';
import {
  beginBeat,
  clearNote,
  markDelivered,
  notepadFilePath,
  notepadView,
  readNotepad,
  writeNote,
} from '../src/notepad/store.js';
import { buildNotepadTool } from '../src/notepad/tool.js';
import { buildMaterialPrompt, notepadLines, type NotepadDigest } from '../src/core/material.js';

let sandbox = '';
let guard: ReturnType<typeof createPathGuard>;
let file = '';

const M0 = { id: 's1', text: '某个素材', used: 0 };

beforeEach(() => {
  sandbox = sandboxDir('hb-notepad-');
  process.env.HEARTBEAT_DATA_DIR = path.join(sandbox, 'data');
  resetWorkspaceForTest();
  initWorkspace();
  guard = createPathGuard(workspace().dataDir);
  file = notepadFilePath(workspace().dataDir);
});

after(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
  delete process.env.HEARTBEAT_DATA_DIR;
  resetWorkspaceForTest();
});

// ── ordinals ────────────────────────────────────────────────────────────

test('beginBeat: a startup beat consumes no ordinal and lets nothing go', () => {
  assert.deepEqual(beginBeat(guard, file, true), { beatNo: 0, dropped: false });
  assert.equal(readNotepad(guard, file).counters.beats, 0);

  // A note that was live before the restart must survive it.
  beginBeat(guard, file, false); // beat 1
  writeNote(guard, file, '想跟他说的事');
  beginBeat(guard, file, false); // beat 2 — carries it
  markDelivered(guard, file);    // shown on beat 2
  const afterRestart = beginBeat(guard, file, true);
  assert.equal(afterRestart.dropped, false);
  assert.equal(readNotepad(guard, file).note?.text, '想跟他说的事');
  assert.equal(afterRestart.beatNo, 2, 'the startup beat changed nothing');
});

test('beginBeat: a normal beat consumes exactly one ordinal', () => {
  assert.equal(beginBeat(guard, file, false).beatNo, 1);
  assert.equal(beginBeat(guard, file, false).beatNo, 2);
  assert.equal(beginBeat(guard, file, false).beatNo, 3);
});

test('markDelivered: stamps the note shown, and anchors only a freshly born one', () => {
  beginBeat(guard, file, false); // beat 1
  writeNote(guard, file, '心事'); // born on beat 1
  assert.equal(markDelivered(guard, file), 1);
  let st = readNotepad(guard, file);
  assert.equal(st.note?.shownAtBeat, 1, 'stamped with the CURRENT beat ordinal');
  assert.equal(st.note?.deliverNo, 1, 'born in this very beat: its count starts after it');

  // A note that was already in the box is NOT re-anchored — its age keeps
  // counting from the beat it arrived on.
  beginBeat(guard, file, false); // beat 2 (shown 1 > touched 1 is false → survives)
  assert.equal(markDelivered(guard, file), 2);
  st = readNotepad(guard, file);
  assert.equal(st.note?.shownAtBeat, 2);
  assert.equal(st.note?.deliverNo, 1);
});

// ── lifecycle ───────────────────────────────────────────────────────────

test('lifecycle: carried to her and untouched -> let go at the next beat', () => {
  beginBeat(guard, file, false); // beat 1
  writeNote(guard, file, '放不下的一句');
  beginBeat(guard, file, false); // beat 2 — carries it
  markDelivered(guard, file);
  const next = beginBeat(guard, file, false); // beat 3
  assert.equal(next.dropped, true);
  assert.equal(readNotepad(guard, file).note, null);
});

test('lifecycle: the same text again is a KEEP and survives, age intact', () => {
  const t0 = 1_700_000_000_000;
  beginBeat(guard, file, false); // beat 1
  const first = writeNote(guard, file, '旧的一句', t0);
  beginBeat(guard, file, false); // beat 2 — carries it
  markDelivered(guard, file);

  const kept = writeNote(guard, file, '旧的一句', t0 + 60_000);
  assert.equal(kept.kept, true);
  assert.equal(kept.note.beatNo, first.note.beatNo, 'the age is not restarted');
  assert.equal(kept.note.leftAt, t0, 'leftAt survives the keep');

  const next = beginBeat(guard, file, false);
  assert.equal(next.dropped, false);
  assert.equal(readNotepad(guard, file).note?.text, '旧的一句');
});

test('lifecycle: never shown -> survives any number of beats', () => {
  beginBeat(guard, file, false);
  writeNote(guard, file, '还没机会说');
  for (let i = 0; i < 4; i += 1) {
    assert.equal(beginBeat(guard, file, false).dropped, false);
  }
  assert.equal(readNotepad(guard, file).note?.text, '还没机会说');
  assert.equal(readNotepad(guard, file).counters.beats, 5);
});

// ── view / mutation ─────────────────────────────────────────────────────

test('notepadView: beats, wakes and wall-clock age', () => {
  const t0 = 1_700_000_000_000;
  beginBeat(guard, file, false); // beat 1 — the thought arrives
  writeNote(guard, file, '心事', t0);
  beginBeat(guard, file, false); // beat 2 — carries it
  markDelivered(guard, file);    // woken once since it arrived
  writeNote(guard, file, '心事'); // kept on beat 2
  beginBeat(guard, file, false); // beat 3 — carries it again

  const v = notepadView(readNotepad(guard, file), t0 + 95 * 60_000);
  assert.ok(v);
  assert.equal(v!.beatsAgo, 2, 'arrived on beat 1, now beat 3');
  assert.equal(v!.wakesAgo, 1);
  assert.equal(v!.sinceMinutes, 95);
});

test('notepadView: an empty slot has no view', () => {
  assert.equal(notepadView(readNotepad(guard, file)), null);
});

test('writeNote: different text replaces the thought and restarts its age', () => {
  const t0 = 1_700_000_000_000;
  beginBeat(guard, file, false);
  writeNote(guard, file, 'A', t0);
  beginBeat(guard, file, false);
  const b = writeNote(guard, file, 'B', t0 + 1_000);
  assert.equal(b.kept, false);
  assert.equal(b.note.beatNo, 2);
  assert.equal(b.note.leftAt, t0 + 1_000);
  assert.throws(() => writeNote(guard, file, '   '), /must not be empty/);
  assert.equal(readNotepad(guard, file).note?.text, 'B', 'a rejected write changes nothing');
});

test('clearNote: returns what it dropped, null when already empty', () => {
  assert.equal(clearNote(guard, file), null);
  beginBeat(guard, file, false);
  writeNote(guard, file, '主动放掉的事');
  assert.equal(clearNote(guard, file)?.text, '主动放掉的事');
  assert.equal(readNotepad(guard, file).note, null);
});

test('the slot is stored encrypted and survives a re-read', () => {
  beginBeat(guard, file, false);
  writeNote(guard, file, '一句只属于我的话');
  const raw = fs.readFileSync(file);
  assert.ok(!raw.toString('utf8').includes('一句只属于我的话'), 'plaintext must not reach the disk');
  const back = readNotepad(guard, file);
  assert.equal(back.note?.text, '一句只属于我的话');
  assert.equal(back.counters.beats, 1);
});

// ── the tool ────────────────────────────────────────────────────────────

let tool: Record<string, any>;
const run = async (args: unknown): Promise<{ ok: boolean; message: string }> =>
  (await (tool ?? (tool = buildNotepadTool(guard, file) as Record<string, any>)).execute(args, {} as never)) as {
    ok: boolean;
    message: string;
  };

test('definition carries the model-facing contract', () => {
  tool = buildNotepadTool(guard, file) as Record<string, any>;
  assert.equal(tool.name, 'notepad');
  assert.ok(String(tool.description).includes('心事匣'));
  assert.ok(String(tool.description).includes('盖掉旧的'));
  assert.ok(String(tool.description).includes('照原样再写一遍'), 'the keep rule must be stated');
  const params = tool.parameters as { type: string; required: string[]; properties: Record<string, { enum?: string[] }> };
  assert.equal(params.type, 'object');
  assert.deepEqual(params.required, ['action']);
  assert.deepEqual(params.properties.action!.enum, ['write', 'read', 'clear']);
  assert.equal(typeof tool.output.render, 'function');
  assert.equal(tool.isConcurrencySafe({}), false);
  assert.deepEqual(tool.output.render({}, { message: '你好' }), [{ type: 'text', text: '你好' }]);
});

test('tool roundtrip: empty -> write -> read -> keep -> clear', async () => {
  tool = buildNotepadTool(guard, file) as Record<string, any>;
  assert.equal((await run({ action: 'read' })).message, '心事匣是空的');

  const wrote = await run({ action: 'write', text: '  想说的   那句  ' });
  assert.equal(wrote.ok, true);
  assert.ok(wrote.message.includes('想说的 那句'), 'whitespace is collapsed');

  const read = await run({ action: 'read' });
  assert.ok(read.message.includes('想说的 那句'));
  assert.ok(read.message.includes('本跳'));

  const kept = await run({ action: 'write', text: '想说的 那句' });
  assert.ok(kept.message.includes('还惦记着'), 'the same text reports a keep');

  const cleared = await run({ action: 'clear' });
  assert.equal(cleared.ok, true);
  assert.ok(cleared.message.includes('想说的 那句'));
  assert.equal((await run({ action: 'read' })).message, '心事匣是空的');
});

test('tool: bad input fails soft, never throws', async () => {
  tool = buildNotepadTool(guard, file) as Record<string, any>;
  assert.equal((await run({ action: 'write' })).ok, false);
  assert.equal((await run({ action: 'write', text: '   ' })).ok, false);
  assert.equal((await run({ action: 'explode' })).ok, false);
  assert.equal((await run({ action: 'clear' })).ok, true); // already empty is not an error
  await assert.doesNotReject(() => run(null));
});

// ── the delivery package ────────────────────────────────────────────────

test('notepadLines: states the keep/let-go semantics, not just the text', () => {
  const lines = notepadLines({ text: '一句话', beatsAgo: 2, wakesAgo: 1, sinceMinutes: 95 });
  const joined = lines.join('\n');
  assert.ok(joined.includes('你上跳留下的心事:一句话'));
  assert.ok(joined.includes('2 跳前'));
  assert.ok(joined.includes('1 小时 35 分'));
  assert.ok(joined.includes('被叫醒过 1 次'));
  assert.ok(joined.includes('照原样再写一遍'));
  assert.ok(joined.includes('什么都不做它下一跳就没了'));
});

test('notepadLines: a note left this beat says so', () => {
  const joined = notepadLines({ text: '刚写的', beatsAgo: 0, wakesAgo: 0, sinceMinutes: 0 }).join('\n');
  assert.ok(joined.includes('留于本跳'));
  assert.ok(joined.includes('还没被叫醒过'));
});

test('buildMaterialPrompt: the note block rides only when there is one', () => {
  const note: NotepadDigest = { text: '心事', beatsAgo: 0, wakesAgo: 0, sinceMinutes: 0 };
  const withNote = buildMaterialPrompt([M0], { notepad: note });
  assert.ok(withNote.includes('你上跳留下的心事:心事'));
  assert.ok(withNote.indexOf('你上跳留下的心事') < withNote.indexOf('- [s1] '), 'the note comes before the materials');
  const without = buildMaterialPrompt([M0]);
  assert.ok(!without.includes('留下的心事'));
});
