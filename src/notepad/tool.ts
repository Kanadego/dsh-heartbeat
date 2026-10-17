// 心事匣 as a MODEL TOOL (v2.0): the chat agents can leave ONE note for the
// next heartbeat, look at it, or let it go — the same host-side pattern as the
// ledger tool (see ledger/tool.ts:1-15): the definition is a PLAIN OBJECT built
// here, `parameters` is a raw JSON Schema, and nothing imports
// @deepseek-ai/dsh-tools, so this module keeps zero new runtime dependencies.
//
// Registration goes through the plugin's ROOT context, which lands the tool in
// the GLOBAL layer — every chat agent sees it. The engine room never does: its
// preset restrict({allow:['web_search']}) masks global tools, and it must stay
// that way. The note is the persona's own private line; the engine room only
// ever sees it indirectly, as text inside the delivery package it never builds.
//
// Scope note: the note is one slot, not a queue. `write` replaces — and that
// replacement is the whole mechanism by which the previous note is let go, so
// the tool deliberately has no "append".

import type { PathGuard } from '../core/path-guard.js';
import { clearNote, notepadView, readNotepad, writeNote, type NotepadView } from './store.js';

interface NotepadToolArgs {
  action?: unknown;
  text?: unknown;
}

/** One line, deliberately: this is a HOOK for the next self to re-expand, not a
 *  record. 120 (the ledger's per-item cap) is the convention here; the little
 *  extra room is because a note is a whole thought, where a ledger item is a
 *  task title. */
const MAX_NOTE_CHARS = 160;

function clean(v: unknown): string {
  return String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE_CHARS);
}

function fmtMinutes(m: number): string {
  if (m < 1) return '不到 1 分钟';
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest > 0 ? `${h} 小时 ${rest} 分` : `${h} 小时`;
}

/** Same phrasing the delivery package uses (material.ts notepadLines) so the
 *  note reads the same wherever she meets it. */
function fmtView(v: NotepadView): string {
  const beats = v.beatsAgo === 0 ? '本跳' : `${v.beatsAgo} 跳前`;
  const wakes = v.wakesAgo === 0 ? '还没被叫醒过' : `期间被叫醒过 ${v.wakesAgo} 次`;
  return `心事匣里现在有：${v.text}\n（留于${beats}，已搁 ${fmtMinutes(v.sinceMinutes)}，${wakes}）`;
}

export function buildNotepadTool(guard: PathGuard, file: string): unknown {
  return {
    name: 'notepad',
    description:
      '心事匣（心跳插件的"留给下一跳的自己"便签）。只有一格：写下新的就盖掉旧的。' +
      '当你有话想留到下次心跳再说、或者有一件放不下的事时，用 action=write 留下一句引子——' +
      '不要写整段，下次跳由那时的你重新展开。想留住原来的就照原样再写一遍（字样一致算保留，' +
      '它的年龄不会重算）；写别的就是换掉它。action=read 看现在格子里是什么；action=clear 主动放掉。' +
      '投递包读过之后，什么都不做它就下一跳没了。留不留都行，没话就空着。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['write', 'read', 'clear'],
          description: 'write=留一句（盖掉旧的），read=看现在是什么，clear=主动放掉',
        },
        text: {
          type: 'string',
          description: 'action=write 时必填：一句引子（不是整段心事，下次跳你自己重新展开）',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          message: { type: 'string' },
        },
        required: ['ok', 'message'],
        additionalProperties: false,
      },
      render: (_args: unknown, value: unknown) => {
        const v = value as { message?: string };
        return [{ type: 'text', text: String(v.message ?? '') }];
      },
    },
    timeoutMs: 5000,
    // Read-modify-write on one file, and the note's lifecycle depends on it.
    isConcurrencySafe: () => false,
    async execute(args: unknown): Promise<unknown> {
      const a = (args ?? {}) as NotepadToolArgs;
      const action = String(a.action ?? '');
      try {
        if (action === 'write') {
          const text = clean(a.text);
          if (!text) return { ok: false, message: 'write 需要非空 text（一句引子）' };
          const { note, kept } = writeNote(guard, file, text);
          return {
            ok: true,
            message: kept ? `还惦记着：${note.text}（年龄不变）` : `已留下心事：${note.text}`,
          };
        }
        if (action === 'read') {
          const v = notepadView(readNotepad(guard, file));
          return { ok: true, message: v ? fmtView(v) : '心事匣是空的' };
        }
        if (action === 'clear') {
          const prev = clearNote(guard, file);
          return prev
            ? { ok: true, message: `已放掉：${prev.text}` }
            : { ok: true, message: '心事匣本来就是空的' };
        }
        // Unsupported action shapes should be rare (schema-enforced); stay total.
        return { ok: false, message: `未知 action（${action || '空'}），只认 write / read / clear` };
      } catch (e) {
        // A damaged container throws on read (store.ts header). Never let that
        // surface as a tool crash; the host would show it as a tool failure.
        return { ok: false, message: `心事匣读写失败：${String(e).slice(0, 120)}` };
      }
    },
  };
}
