// Ledger as a MODEL TOOL (v1.8.0): the chat agents can record / list / check
// off ledger items themselves, so a todo mentioned in conversation lands in
// the shared ledger without the user commanding anyone to "write it down".
//
// Registration is host-side (`ToolRuntime.register`, 0.2.0-rc.2 verified):
// the definition is built as a PLAIN OBJECT here — `parameters` is a raw JSON
// Schema per ToolSchema (dsh-llm), so we do not import `defineTool` and the
// module carries zero new runtime dependencies. `ToolRuntime.register` is the
// only host entry point (looked up dynamically by the caller); on a host
// without it the caller audits and moves on, nothing else is affected.
//
// Scope: registration happens through the plugin's ROOT context, which lands
// the tool in the GLOBAL layer — every agent sees it. The engine room is
// unaffected: its preset restrict({allow:['web_search']}) masks global tools,
// so the heartbeat's own turns cannot touch the ledger.

import {
  appendEntry,
  markDone,
  readLedger,
  scanPending,
  type LedgerEntry,
} from './ledger.js';
import type { PathGuard } from '../core/path-guard.js';

/** Minimal structural typing of the host shape — we deliberately do not
 * depend on @deepseek-ai/dsh-tools at runtime. */
export interface RegisterableToolRuntime {
  register(definition: unknown): () => void;
}

interface LedgerToolArgs {
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

export function buildLedgerTool(guard: PathGuard, file: string): unknown {
  return {
    name: 'ledger',
    description:
      '共享账本工具（心跳插件的待办与事项记录）。当用户提到计划、待办、承诺、想做的事，' +
      '或者某件事已经完成时，主动调用本工具登记或勾掉——不需要等用户明确说"记一下"。' +
      'action=add 登记新事项（text 必填）；action=list 查看当前未完成事项；action=done 勾掉一条（key 为 #id 或文本子串）。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'list', 'done'], description: 'add=登记，list=查未完成，done=勾掉' },
        text: { type: 'string', description: 'action=add 时必填：事项内容（一句话）' },
        key: { type: 'string', description: 'action=done 时必填：#id 或事项文本的唯一子串' },
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
    // Ledger writes go through read-modify-write on one file; never parallel.
    isConcurrencySafe: () => false,
    async execute(args: unknown): Promise<unknown> {
      const a = (args ?? {}) as LedgerToolArgs;
      const action = String(a.action ?? '');
      if (action === 'add') {
        const text = clean(a.text);
        if (!text) return { ok: false, message: 'add 需要非空 text' };
        const e = appendEntry(guard, file, text);
        return { ok: true, message: `已登记 ${fmtEntry(e)}` };
      }
      if (action === 'done') {
        const key = clean(a.key);
        if (!key) return { ok: false, message: 'done 需要 key（#id 或文本子串）' };
        const e = markDone(guard, file, key);
        if (!e) return { ok: false, message: `没有找到匹配「${key}」的未完成事项（先用 list 查）` };
        return { ok: true, message: `已完成 ${fmtEntry(e)}` };
      }
      if (action === 'list') {
        const items = scanPending(guard, file).map(fmtEntry);
        return { ok: true, message: items.length > 0 ? `当前未完成 ${items.length} 项：\n${items.join('\n')}` : '账本里没有未完成事项' };
      }
      // Unsupported action shapes should be rare (schema-enforced); stay total.
      const total = readLedger(guard, file).entries.length;
      return { ok: false, message: `未知 action，账本共 ${total} 条` };
    },
  };
}
