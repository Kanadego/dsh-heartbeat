# AGENTS.md — @kanadego/dsh-heartbeat

> Quick-reference guide for AI coding agents working in or operating `@kanadego/dsh-heartbeat` (v2.2.1).
> For full parameter tables and audit log event dictionaries, read `DESIGN.md`.

---

## 1. What This Project Is

`@kanadego/dsh-heartbeat` is a proactive companion plugin for **DeepSeek Harness (DSH)**. It runs a background timer loop (`beat()`) that separates **background autonomous thinking** from **foreground user conversation**:

1. **Engine Room (`home` session)**: A hidden background DSH session bound to the built-in `kohaku-heartbeat` preset. It performs web wandering (`browse`), desktop screenshot vision (`envpulse`), user profile consolidation (`profile`), and weekly report generation (`weekly`). It automatically rotates when event count reaches `3000`, hits `CONTEXT_WINDOW_EXCEEDED`, or is archived in `workspace.json`.
2. **Companion Sessions (`observe` / `deliver` bindings)**: User-facing chat sessions.
   - `observe: true`: Heartbeat incrementally reads new user messages into an encrypted inbox.
   - `deliver: true`: When the pace gate opens, Heartbeat injects a candidate material package into the session so the companion agent can proactively speak and report back via `seed_report`.
3. **Zero Idle Token Guarantee**: Focus mode, quiet hours, daily cap, cooldown, and token-saver checks all run in pure TypeScript before any LLM call. A gated beat finishes in `< 10ms` with `0` token cost.

---

## 2. How to Use It

### 2.1 As the Companion Agent (4 Injected Tools)

When a session has `deliver: true`, the companion agent receives 4 tools (blocked inside the Engine Room):

| Tool | Actions | Purpose & Rules |
|---|---|---|
| `seed_report` | `spoken: "material" \| "heartfelt" \| "silent"` | **Mandatory on every heartbeat delivery package.** Pass `delivery_id` verbatim; if `spoken="material"`, pass used `seed_ids` (e.g. `["s3"]`). |
| `ledger` | `add` · `list` · `done` | Shared todo & promise tracker (`data/ledger.md`). Register plans/todos proactively when mentioned by the user. |
| `notepad` | `write` · `read` · `clear` | Single-slot sticky note (`data/notepad.json`, encrypted) left for the next beat's self. Writing overwrites the previous note; unread notes expire after delivery. |
| `excerpt` | `add` · `list` · `remove` | Personal quote & moment scrapbook (`data/excerpt.md`). Append-only unless explicitly removed. |

### 2.2 Operational CLI (`node dist/cli/index.js <verb>`)

```bash
node dist/cli/index.js status                        # Workspace paths, gate state, policy summary
node dist/cli/index.js logs --tail 30                # Tail recent audit log entries (logs/heartbeat.jsonl)
node dist/cli/index.js focus <minutes> | focus off   # Pause/resume beats across processes (data/focus.json)
node dist/cli/index.js sessions                      # List DSH sessions + current home/observe/deliver bindings
node dist/cli/index.js bind <sessionId> [--deliver] [--observe] | bind --clear <id>
node dist/cli/index.js seeds list | add <text> | archive <id> | gc
node dist/cli/index.js bili login                    # Terminal QR login for Bilibili watch-history source
node dist/cli/index.js profile verify | rebuild      # Verify or rebuild encrypted 10-partition user profile
node dist/cli/index.js vault status | upgrade        # Inspect or upgrade KHBV2 AES-256-GCM containers
```

---

## 3. Build, Verify & Test Commands

Run all commands from repo root (`D:/AIagent/dsh-heartbeat-v2`):

```bash
npm run typecheck      # tsc --noEmit (TypeScript strict check)
npm run build          # tsup -> dist/index.js + dist/cli/index.js
npm run check:client   # node --check client.js (syntax check for browser bundle)
npm run check:panel    # node scripts/panel-smoke.mjs (7-tab Web UI smoke test)
npm test               # node --import tsx --test "tests/*.test.ts"
```

- **Always run `npm run typecheck && npm run build && npm run check:client && npm test` before committing code changes.**
- `client.js` at the repository root is the shipped browser client entry (dual-registered under `dsh-heartbeat` and `@kanadego/dsh-heartbeat`). Note: `src/client.js` and root `client.js` — check which file is imported/packaged (`"./client": "./client.js"` in `package.json`).

---

## 4. Codebase Map & Key Invariants

- `src/index.ts` — Cordis plugin entry (`inject: ['agents']` only; `settings` and `webui` are injected lazily so missing optional services never block boot).
- `src/core/orchestrator.ts` — `beat()` state machine, single-flight lock + 45-min watchdog `AbortController`, Engine Room rotation (`HOME_ROTATE_EVENT_COUNT = 3000`), companion delivery & `seed_report` accounting.
- `src/core/archived-sessions.ts` — Reads DSH `storages/workspace.json` to skip archived delivery targets and auto-rotate an archived Engine Room session.
- `src/rpc.ts` & `client.js` — 25 JSON-RPC endpoints backing the 7-tab Web UI (状态 / 会话 / 素材 / 兴趣 / 画像 / 周报 / 设置).
- `src/config/schema.ts` & `config/policy.json` — Factory defaults + user override deep-merge (`<dataDir>/data/settings/policy.json`).
- `src/vault/vault.ts` — `KHBV2` AES-256-GCM encryption for `profile.json`, `notepad.json`, `bilibili-session.json`, `inbox/*.jsonl`, `weekly/*.md`, and `snapshots/*.json`.

### Hard Invariants (Do Not Break)

1. **Path Guard Everywhere**: Every file read/write inside `dataDir` must go through `PathGuard` (`src/core/path-guard.ts`) and atomic write helpers (`src/core/atomic-fs.ts`).
2. **Audit Privacy**: `logs/heartbeat.jsonl` records event names, reason codes, IDs, and durations only — **never** log raw chat messages, profile text, or cookies/SESSDATA.
3. **Cross-Platform Safety**: `os` supports `win32`, `linux`, and `darwin`. Any PowerShell helper (`src/core/ps.ts`) must degrade gracefully to a no-op on non-Windows platforms; CLI entry guards must use `pathToFileURL(path.resolve(process.argv[1])).href`.
4. **Host Restart Requirement**: When linked into a DSH profile, changes to `dist/` or `client.js` require the user to restart DSH (DSH does not self-restart).
