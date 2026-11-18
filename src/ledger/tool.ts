// Ledger / 错题本 as MODEL TOOLS (v1.8.0 ledger, v2.3.0 corrections): the chat
// agents can record / list / check off items themselves, so a todo — or a
// correction the user just made — lands in the shared book without the user
// commanding anyone to "write it down".
//
// Registration is host-side (`ToolRuntime.register`, 0.2.0-rc.2 verified):
// the definition is built as a PLAIN OBJECT here — `parameters` is a raw JSON
// Schema per ToolSchema (dsh-llm), so we do not import `defineTool` and the
// module carries zero new runtime dependencies. `ToolRuntime.register` is the
// only host entry point (looked up dynamically by the caller); on a host
// without it the caller audits and moves on, nothing else is affected.
//
// Scope: registration happens through the plugin's ROOT context, which lands
// the tools in the GLOBAL layer — every agent sees them. The engine room is
// unaffected: its preset restrict({allow:['web_search']}) masks global tools,
// so the heartbeat's own turns cannot touch either book.
//
// Both books share ONE contract (`buildBookTool`); only the model-facing copy
// and the seeded header differ. 2.3.0: both are live-only — done rows are摘走
// into `<book>-done.md` by markDone, which derives the archive from the book
// file, so the tool needs no extra path here.

import {
  CORRECTIONS_HEADER,
  LEDGER_HEADER,
  appendEntry,
  markDone,
  readLedger,
  scanPending,
  type LedgerAuditSink,
  type LedgerEntry,
} from './ledger.js';
import type { PathGuard } from '../core/path-guard.js';

/** Minimal structural typing of the host shape — we deliberately do not
 * depend on @deepseek-ai/dsh-tools at runtime. */
export interface RegisterableToolRuntime {
  register(definition: unknown): () => void;
}

interface BookToolArgs {
  action?: unknown;
  text?: unknown;
  key?: unknown;
}

const MAX_TEXT = 120;

function clean(v: unknown): string {
  return String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
}

function fmtEntry(e: LedgerEntry): string {
  return `#${e.id} [${e.status}] ${e.date} ${e.text}`;
}

/** Everything that differs between the two books. */
interface BookLabels {
  name: string;
  header: string;
  description: string;
  /** "已登记" / "已记下" */
  addedVerb: string;
  /** "已完成" / "已复盘" */
  doneVerb: string;
  /** "当前未完成" / "待复盘" */
  listTitle: string;
  /** "未完成事项" / "待复盘条目" */
  listNoun: string;
  /** "账本" / "错题本" */
  bookName: string;
  textHint: string;
  keyHint: string;
}

/** `audit` (N16①): the chat-tool path is the MAIN path into markDone — when the
 *  archive dedupes a completion away (retry window), the row still leaves the
 *  book and without a sink the swallow is invisible. The caller (src/index.ts)
 *  wires its heartbeat.jsonl sink; without one the tool still works, just
 *  unaudited. */
function buildBookTool(guard: PathGuard, file: string, labels: BookLabels, audit?: LedgerAuditSink): unknown {
  return {
    name: labels.name,
    description: labels.description,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'list', 'done'], description: 'add=登记，list=查未完成，done=勾掉' },
        text: { type: 'string', description: labels.textHint },
        key: { type: 'string', description: labels.keyHint },
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
    // Both books write through read-modify-write on one file; never parallel.
    isConcurrencySafe: () => false,
    async execute(args: unknown): Promise<unknown> {
      const a = (args ?? {}) as BookToolArgs;
      const action = String(a.action ?? '');
      if (action === 'add') {
        const text = clean(a.text);
        if (!text) return { ok: false, message: 'add 需要非空 text' };
        const e = appendEntry(guard, file, text, Date.now(), labels.header);
        return { ok: true, message: `${labels.addedVerb} ${fmtEntry(e)}` };
      }
      if (action === 'done') {
        const key = clean(a.key);
        if (!key) return { ok: false, message: `done 需要 key（#id 或文本子串）` };
        const e = markDone(guard, file, key, Date.now(), undefined, undefined, audit);
        if (!e) return { ok: false, message: `没有找到匹配「${key}」的${labels.listNoun}（先用 list 查）` };
        return { ok: true, message: `${labels.doneVerb} ${fmtEntry(e)}` };
      }
      if (action === 'list') {
        const items = scanPending(guard, file).map(fmtEntry);
        return {
          ok: true,
          message: items.length > 0
            ? `${labels.listTitle} ${items.length} 项：\n${items.join('\n')}`
            : `${labels.bookName}里没有${labels.listNoun}`,
        };
      }
      // Unsupported action shapes should be rare (schema-enforced); stay total.
      const total = readLedger(guard, file).entries.length;
      return { ok: false, message: `未知 action，${labels.bookName}共 ${total} 条` };
    },
  };
}

const LEDGER_LABELS: BookLabels = {
  name: 'ledger',
  header: LEDGER_HEADER,
  description:
    '共享账本工具（心跳插件的待办与事项记录）。当用户提到计划、待办、承诺、想做的事，' +
    '或者某件事已经完成时，主动调用本工具登记或勾掉——不需要等用户明确说"记一下"。' +
    'action=add 登记新事项（text 必填）；action=list 查看当前未完成事项；action=done 勾掉一条（key 为 #id 或文本子串）。',
  addedVerb: '已登记',
  doneVerb: '已完成',
  listTitle: '当前未完成',
  listNoun: '未完成事项',
  bookName: '账本',
  textHint: 'action=add 时必填：事项内容（一句话）',
  keyHint: 'action=done 时必填：#id 或事项文本的唯一子串',
};

const CORRECTIONS_LABELS: BookLabels = {
  name: 'corrections',
  header: CORRECTIONS_HEADER,
  description:
    '错题本工具（记录用户对你的纠正）。当用户指出你说错了、做错了、记错了，或者纠正你的说法与做法时，' +
    '主动调用本工具记一条——不需要等用户说"记一下"。action=add 记一条纠正（text 必填，一句话写清用户纠正了什么）；' +
    'action=list 查看还没复盘的条目；action=done 勾掉一条（key 为 #id 或文本子串）——勾掉表示这条教训已经写进人设卡或长期记忆。',
  addedVerb: '已记下',
  doneVerb: '已复盘',
  listTitle: '待复盘',
  listNoun: '待复盘条目',
  bookName: '错题本',
  textHint: 'action=add 时必填：用户纠正了什么（一句话）',
  keyHint: 'action=done 时必填：#id 或纠正文本的唯一子串',
};

export function buildLedgerTool(guard: PathGuard, file: string, audit?: LedgerAuditSink): unknown {
  return buildBookTool(guard, file, LEDGER_LABELS, audit);
}

/** v2.3.0: the corrections book — same contract, `data/corrections.md`. */
export function buildCorrectionsTool(guard: PathGuard, file: string, audit?: LedgerAuditSink): unknown {
  return buildBookTool(guard, file, CORRECTIONS_LABELS, audit);
}
