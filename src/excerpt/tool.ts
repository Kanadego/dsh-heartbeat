// Excerpt book as a MODEL TOOL (v2.0.0): the agent can keep a line the moment it
// lands, instead of losing it because there is nowhere to put it.
//
// Same registration shape as the ledger tool: a PLAIN OBJECT, no import of
// @deepseek-ai/dsh-tools, registered through the plugin's ROOT context so it
// lands in the GLOBAL layer every chat agent sees. The engine room cannot
// reach it (its preset restrict({allow:['web_search']}) masks global tools).

import { appendExcerpt, readExcerpts, recentExcerpts, removeExcerpt, type ExcerptEntry } from './excerpt.js';
import type { PathGuard } from '../core/path-guard.js';

interface ExcerptToolArgs {
  action?: unknown;
  text?: unknown;
  key?: unknown;
}

const MAX_TEXT = 300;
const LIST_LIMIT = 10;

function clean(v: unknown): string {
  return String(v ?? '').replace(/\s+/g, ' ').trim();
}

function fmtEntry(e: ExcerptEntry): string {
  return `#${e.id} ${e.date} ${e.time} ${e.text}`;
}

export function buildExcerptTool(guard: PathGuard, file: string): unknown {
  return {
    name: 'excerpt',
    description:
      '你自己的摘抄本：留句子和小事的地方。想说"这句我要记下来"的时候用——他说过的话、看到的句子、' +
      '心里过了一下的小事。它和账本、心事匣都不一样：账本记的是待办和承诺（会勾掉），心事匣是留给下一跳的一句引子（只有一格、会被盖掉），' +
      '摘抄本只增不减，除非你主动 remove。写的时候把话原样留下，不用解释。' +
      'action=add 抄一条（text 必填）；action=list 翻最近十条；action=remove 抹掉一条（key 为 #id 或正文里的唯一子串）。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'list', 'remove'], description: 'add=抄一条，list=翻最近十条，remove=抹掉一条' },
        text: { type: 'string', description: 'action=add 时必填：要留下的那句话或那件小事' },
        key: { type: 'string', description: 'action=remove 时必填：#id 或正文里的唯一子串' },
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
    // Read-modify-write on one file; never parallel.
    isConcurrencySafe: () => false,
    async execute(args: unknown): Promise<unknown> {
      const a = (args ?? {}) as ExcerptToolArgs;
      const action = String(a.action ?? '');
      if (action === 'add') {
        const text = clean(a.text).slice(0, MAX_TEXT);
        if (!text) return { ok: false, message: 'add 需要非空 text' };
        const e = appendExcerpt(guard, file, text);
        return { ok: true, message: `已抄下 ${fmtEntry(e)}` };
      }
      if (action === 'remove') {
        const key = clean(a.key);
        if (!key) return { ok: false, message: 'remove 需要 key（#id 或正文里的唯一子串）' };
        const e = removeExcerpt(guard, file, key);
        if (!e) return { ok: false, message: `摘抄本里没有匹配「${key}」的一条（先用 list 翻）` };
        return { ok: true, message: `已抹掉 ${fmtEntry(e)}` };
      }
      if (action === 'list') {
        const total = readExcerpts(guard, file).entries.length;
        if (total === 0) return { ok: true, message: '摘抄本还是空的' };
        const items = recentExcerpts(guard, file, LIST_LIMIT).map(fmtEntry);
        return { ok: true, message: `摘抄本共 ${total} 条，最近 ${items.length} 条：\n${items.join('\n')}` };
      }
      // Unsupported action shapes should be rare (schema-enforced); stay total.
      const total = readExcerpts(guard, file).entries.length;
      return { ok: false, message: `未知 action，摘抄本共 ${total} 条` };
    },
  };
}
