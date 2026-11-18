# @kanadego/dsh-heartbeat — 开发者设计与维护手册

> **当前版本**：v2.3.0 · **宿主兼容**：DSH `0.2.2-rc.1` – `0.2.2-rc.4` · **平台**：Windows / Linux / macOS
>
> 本文档面向插件维护者与二次开发者，提供：**架构与核心功能全景**、**源码与磁盘文件映射**、**参数速查表**、以及 **审计日志（`logs/heartbeat.jsonl`）字典与排障指南**。文中参数名、常量、事件名均以源码为准，并尽量给出「文件:行号」方便跳转；行号会随源码漂移，抽查时以「名字 + 文件」grep 为准。

---

## 1. 核心架构与设计原则

### 1.1 双会话分离（Dual-Session Architecture）

心跳插件不在用户的日常聊天会话里跑后台任务，而是将**后台思考**与**前台陪伴**拆成两类会话：

1. **引擎室（Home Session / 正身会话）**
   - 插件自己创建并持有的后台专属会话，sessionId 存在加密的 `gate.json` 里。它挂内置预设 `heartbeat`（定义名「心跳模式」），工具白名单收敛到只有 `web_search`，外加宿主自动探测到的 `compress` / `decompress` / `acp_status`（常量 `ENGINE_ROOM_EXTRA_TOOLS`），再叠加配置项 `extraTools`。没有 shell、没有文件工具、没有子代理。
   - 负责执行**闲逛搜索（Wander）**、**屏幕多模态读图（Screen Vision）**、**用户画像整合（Profile Consolidation）**、**每周回顾生成（Weekly Report）**，以及投递前的**决策回合**（从候选素材里挑出这一跳真要说的 ≤3 条）。
   - **自动旋转（Home Rotation）**：引擎室事件数达到 `HOME_ROTATE_EVENT_COUNT`（3000）、遇到 `CONTEXT_WINDOW_EXCEEDED`、或被用户在 UI 中手动归档时，自动丢弃旧会话并拉起新引擎室。旧正身默认在宿主 `workspace.json` 里标记归档（`policy.heartbeat.archiveRotatedHome`），侧边栏不会越堆越多。状态全部落盘在 `dataDir`，旋转零数据丢失。旋转发生在 beat 开头，做完这一拍就歇（记 `silent`，reason `home rotated, next beat starts fresh`），下一拍用新引擎室。
2. **陪伴会话（Companion Sessions / 绑定会话）**
   - 用户日常聊天的会话，在 Web 面板「会话」页或通过 CLI `bind add` 绑定。绑定表是 `settings/bindings.json`，每条带 `observe` / `deliver` 两个开关；表里**没有 home 字段**，正身身份只存在 `gate.json`：
     - **`observe: true`（观察源）**：心跳按游标增量读取用户发言（过滤插件自身注入的文本），把首句（≤ `policy.observe.maxChars`）送入收件箱供画像提炼。只看活着的会话，不主动说话。
     - **`deliver: true`（投递目标）**：当门禁放行且有话可说时，把组好的「心跳素材包」以 `user/message`（来源 kind `heartbeat`）形式投递进该会话，由陪伴 Agent 决定说不说、说什么，并调用 `seed_report` 报账。
   - v2.3.0 起，观察与投递都受**会话闸门**保护：归档的、子代理的、坏掉的会话会被跳过，连续判坏满 3 拍自动解绑（详见 §3.2 与 §5.2-C）。

### 1.2 零闲置 Token 原则

- **门禁前置**：专注模式、安静时段、忙碌窗口、前台正在打字、每日上限、冷却间隔、无活动省流（Token Saver）全部在纯 TypeScript 层完成判定（`evaluateGate`），不调模型；投递前还会 `canSendLive` 复查一次。
- **不唤醒则不做表达评估**：专注模式与 token-saver 在碰模型之前就短路返回；素材池为空且没开 `idleMode` 时直接 `silent(no candidates)`，不投递、不看图、不跑决策回合。
- 一句实话：维护（maintenance）、采集（collect）、闲逛（wander）排在门禁前面，闲逛到期或画像整合到期时引擎室仍会调模型。所以「零闲置」指的是「用户不在 / 没什么可说时不做表达评估」，不是「每一拍都零成本」。

---

## 2. 源码目录与数据落盘索引

### 2.1 源码结构（`src/`）

| 目录 / 文件                                           | 核心职责                                                                                                                                                                                                                                  |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                                        | 插件主入口：Config schema 声明、工作区初始化、账本归档首跑迁移、预设运行时注册 + 文件系统自装、注册 5 个 Agent 工具（心事匣带声明层 `when`）、启动 orchestrator、B 站源定时器、时间注入与状态栏、安装 RPC                                 |
| `src/rpc.ts`                                          | Web 面板与宿主的 RPC 桥：精确路由 `POST /api/heartbeat`（`RPC_ROUTE_PATH`，`src/rpc.ts:70`），共 33 个动作端点；宿主闸门缺失时只开 5 个只读端点（`status` / `config.get` / `sessions.list` / `bindings.get` / `weekly.list`）             |
| `client.js`（仓库根）                                 | 浏览器端原生 7-Tab 面板（状态 / 会话 / 素材 / 兴趣 / 画像 / 周报 / 设置），通过 `plugins.bundle.config` 插槽同时挂在 `dsh-heartbeat` 与 `@kanadego/dsh-heartbeat` 两个 bundle key 下（需 DSH 0.2.1+）；挂载时强制重探测宿主能力，只升不降 |
| `src/core/orchestrator.ts`                            | 心跳主循环 `beat()`、引擎室生命周期与旋转、单飞锁与 45 分钟 Watchdog、陪伴会话投递与报账闭环                                                                                                                                              |
| `src/core/material.ts`                                | 候选组装、素材包提示词、沉默/对账纯函数（`reconcileReply` / `deliveryVerdict`）、沉默 allowlist 常量 `TURN_END_SILENCE_KIND`                                                                                                              |
| `src/core/session-gate.ts`                            | v2.3.0 会话闸门：archived / subagent / broken 三态判定、60 秒裁决缓存、三振解绑、振数账本                                                                                                                                                 |
| `src/core/runtime.ts`                                 | 运行时单例：活开关引用（statusbar / idleMode / tokenSaver / visionEngine / concludeSilentTurn 等）与当前投递编号 `currentDeliveryId`                                                                                                      |
| `src/core/focus-store.ts`                             | 专注模式状态读写（内存与 `focus.json` 双来源取或，支持 CLI 跨进程暂停，重启仍在）                                                                                                                                                         |
| `src/core/archived-sessions.ts`                       | 解析 DSH `storages/workspace.json` 的归档会话集合，供投递目标跳过与引擎室自动重建使用（fail-open）                                                                                                                                        |
| `src/core/bindings.ts`                                | 会话绑定表（`observe` / `deliver`）读写与目标筛选                                                                                                                                                                                         |
| `src/core/paths.ts`                                   | dataDir 解析：环境变量 `HEARTBEAT_DATA_DIR` > 配置 `dataDir` > 默认 `$DSH_HOME/heartbeat-data`；旧包内目录搬迁入口                                                                                                                        |
| `src/core/data-relocate.ts`                           | 一次性把数据搬出包目录：备份 → staging → sha256 校验 → rename → 删除，任一步失败保留原目录继续用                                                                                                                                          |
| `src/core/path-guard.ts`                              | 路径沙箱守卫：所有读写强制校验在 `dataDir` 内，拦截 `..` 越界与外链 symlink                                                                                                                                                               |
| `src/core/atomic-fs.ts`                               | 原子写文件（**同目录**临时文件 + fsync + rename）；首建竞争 `atomicCreateFileSync`（hardlink EEXIST，wx 兜底）；shred/burn。跨进程文件锁 `withFileLock` 在 `src/core/file-lock.ts`                                                        |
| `src/core/preset-definition.ts` / `preset-install.ts` | `heartbeat` 预设定义（compaction 组 + 唯一模型工具 tool-web，刻意无 persona 行）与文件系统自装                                                                                                                                            |
| `src/core/ps.ts`                                      | 异步 PowerShell runner：非 Windows 立即返回「探测失败」降级，不 spawn                                                                                                                                                                     |
| `src/core/time-window.ts`                             | HH:MM 窗口算术（跨午夜、左闭右开）与本地日键 `localDayKey`                                                                                                                                                                                |
| `src/config/schema.ts` / `load.ts`                    | `Policy` 类型定义、运行时范围校验 `assertPolicy()`、用户覆盖层 `deepMerge()`；工厂/用户两层加载（fail-closed）                                                                                                                            |
| `src/config/ui-config.ts`                             | 运行时开关文件 `ui.json` 的净化与范围校验                                                                                                                                                                                                 |
| `src/config/quiet-hours.ts`                           | 面板安静时段输入的严格 HH:MM 校验与三态解析                                                                                                                                                                                               |
| `src/gate/gate.ts`                                    | 分寸闸门状态机（安静时段 / 忙碌窗口 / 正在打字 / 每日上限 / 冷却），`sent.json` 记账                                                                                                                                                      |
| `src/gate/busy-rules.ts`                              | `busy-rules.json` 进程分类（busy/idle 表 + 全屏游戏判定，只有工厂层）                                                                                                                                                                     |
| `src/seeds/pool.ts`                                   | 话题素材池（增删、三层去重、评分排序、来源/类目/全局三维配额淘汰、冷板凳与归档上限 GC）                                                                                                                                                   |
| `src/seeds/report.ts`                                 | `seed_report` 工具 + 报账环 + 报账锁（delivery_id 校验）+ 静默收尾请求                                                                                                                                                                    |
| `src/browse/browse.ts`                                | 自主闲逛调度：读取兴趣工厂层 + 用户覆盖层，抽签话题并拼装引擎室搜索提示词；补货裁决                                                                                                                                                       |
| `src/browse/interests-edit.ts`                        | 兴趣用户层编辑（首次编辑原样继承工厂，整体替换）                                                                                                                                                                                          |
| `src/browse/preference.ts`                            | 话题偏好统计（半衰期衰减）                                                                                                                                                                                                                |
| `src/sources/bilibili.ts`                             | B 站观看历史被动源：自带 2 小时定时器（独立于 beat）增量拉取已登录账号的观看记录并转为 `source: "bilibili"` 素材                                                                                                                          |
| `src/screen/screenpulse.ts`                           | 桌面感知与全屏截图：采集前台窗口与截屏，加密落盘 `screen.jpg` / `screen.json` / `screen.capture`                                                                                                                                          |
| `src/screen/vision.ts`                                | 双引擎读图路由（native / modlens / auto）与错误文本清洗（scrub 截图路径）                                                                                                                                                                 |
| `src/env/envpulse.ts`                                 | 空闲/锁屏探测 + presence 判定，落盘 `envpulse.json` 快照与 `logs/envpulse.jsonl` 脉冲流                                                                                                                                                   |
| `src/profile/store.ts` / `consolidate.ts`             | 4 分区用户画像：journal 是唯一权威（明文），`profile.json` 是可重建的加密物化视图；引擎室增量整合（LLM 提名、代码裁决）                                                                                                                   |
| `src/profile/digest.ts` / `snapshot.ts`               | 处境摘要（字符预算 `BUDGET_CHARS`）与 journal 折叠快照（阈值 `SNAPSHOT_THRESHOLD`）                                                                                                                                                       |
| `src/notepad/` · `src/ledger/` · `src/excerpt/`       | 陪伴 Agent 专属工具后端：心事匣（单格便签）、账本与错题本（live-only + 归档）、摘抄本                                                                                                                                                     |
| `src/weekly/report.ts`                                | 每周回顾生成（7 天滚动锚点）、周锚点记录与历史周报保留裁剪                                                                                                                                                                                |
| `src/statusbar/`                                      | `time-inject.ts`（用户轮次注入当前时间与距上次发言间隔，跳过子代理与非用户源）+ `track.ts`（双轨状态栏，只在投递会话渲染）+ `store.ts`（状态卡）                                                                                          |
| `src/vault/`                                          | `vault.ts`（AES-256-GCM `KHBV2` 容器加解密 + 平台密钥管理）、`migrate.ts`（scrypt 口令流式导出/导入）、`burn-list.ts`（一键焚毁）                                                                                                         |
| `src/cli/index.ts` / `bili-login.ts`                  | 运维 CLI（18 个一级子命令，B 站扫码登录 `bili` 是其中之一）与 B 站终端扫码登录实现                                                                                                                                                        |

### 2.2 数据目录（`dataDir`）文件清单

默认路径：`$DSH_HOME/heartbeat-data`。优先级：环境变量 `HEARTBEAT_DATA_DIR` > 插件配置 `dataDir` > 默认。v1.9.1 及更早写在 `<packageRoot>/data` 的数据，首跑自动搬出；**显式配置的目录永远赢、不会被自动搬迁**。启动时创建 `settings/ logs/ tmp/ exports/` 四个子目录。下表路径都是 `dataDir` 的直接相对路径，没有 `data/` 前缀。

加密约定：**KHBV2 = AES-256-GCM**（进程内主密钥）；读取兼容旧 KHBV1（DPAPI，仅 Windows），写入一律 KHBV2。`loadJson/saveJson`、`loadEncryptedText/saveEncryptedText` 走加密；`readText/writeText` 走明文。

| 相对路径                                 | 加密层级         | 读写模块                                     | 用途说明                                                                                           |
| ---------------------------------------- | ---------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `vault.key`                              | 平台保护         | `vault/vault.ts`                             | 32 字节主密钥：Windows 下为 DPAPI 密文（KHBV1），Linux/macOS 下为 `0600` 权限裸密钥                |
| `gate.json`                              | **KHBV2 加密**   | `core/orchestrator.ts`                       | 正身会话 sessionId（机器本地，不随口令迁移走）                                                     |
| `sent.json`                              | **KHBV2 加密**   | `gate/gate.ts`                               | 今日已投递列表（ts / kind / summary≤80），门禁计数与冷却的依据                                     |
| `focus.json`                             | 明文 JSON        | `core/focus-store.ts`                        | 专注模式 `{until,minutes,since,via}`，重启仍在                                                     |
| `cursors.json`                           | 明文 JSON        | `core/orchestrator.ts`                       | 各观察会话已消费到的事件 `seq` 游标（version:2）                                                   |
| `seeds.jsonl`                            | **KHBV2 整文件** | `seeds/pool.ts`                              | 活跃素材池与已归档素材                                                                             |
| `seed_report.jsonl`                      | **KHBV2 整文件** | `seeds/report.ts`                            | 报账环（最多 `REPORT_KEEP = 400` 条）                                                              |
| `notepad.json`                           | **KHBV2 加密**   | `notepad/store.ts`                           | 心事匣（留给下一跳的一句话引子与年龄计数）                                                         |
| `preference.json`                        | **KHBV2 加密**   | `browse/preference.ts`                       | 话题偏好统计                                                                                       |
| `browse.json`                            | **KHBV2 加密**   | `browse/browse.ts`                           | 各兴趣上次闲逛时间、当日次数与冷却状态                                                             |
| `bilibili-session.json`                  | **KHBV2 加密**   | `cli/bili-login.ts`                          | 扫码登录保存的 B 站 `SESSDATA` 凭据 `{sessdata,savedAt}`                                           |
| `bilibili-source.json`                   | **KHBV2 加密**   | `sources/bilibili.ts`                        | B 站历史源 `{lastFetchAt,bvids[]}`（拉取节流与去重高水位）                                         |
| `profile.json`                           | **KHBV2 加密**   | `profile/store.ts`                           | 4 分区画像物化视图（投影，可从 journal 重建）                                                      |
| `profile_journal.jsonl`                  | **明文 JSONL**   | `profile/store.ts`                           | 画像唯一权威，append-only                                                                          |
| `profile_snapshot.json`                  | **KHBV2 加密**   | `profile/snapshot.ts`                        | journal 折叠快照                                                                                   |
| `profile_journal.archive-*.jsonl`        | 明文 JSONL       | `profile/snapshot.ts`                        | 快照轮换出的历史分片                                                                               |
| `profile_inbox.jsonl`                    | **KHBV2 整文件** | `profile/inbox.ts`                           | 待整合的聊天观察、屏幕描述与闲逛摘录队列                                                           |
| `profile_rhythm.json`                    | 明文 JSON        | `rhythm/rhythm.ts`                           | presence 直方图（30 天滚动）                                                                       |
| `envpulse.json`                          | 明文 JSON        | `env/envpulse.ts`                            | 最新环境快照（空闲/锁屏/presence）                                                                 |
| `screen.json` / `screen.jpg`             | **KHBV2 加密**   | `screen/screenpulse.ts`                      | 前台窗口列表 / 截图                                                                                |
| `screen.capture`                         | 明文             | `screen/screenpulse.ts`                      | 本拍截图时间戳 `captured_at`（判断截图是否新鲜）                                                   |
| `ledger.md` / `ledger-done.md`           | 明文 Markdown    | `ledger/ledger.ts`                           | 账本活页 / 归档（live-only，done 行摘进归档）                                                      |
| `corrections.md` / `corrections-done.md` | 明文 Markdown    | `ledger/ledger.ts`                           | 错题本活页 / 归档                                                                                  |
| `excerpts.md`                            | 明文 Markdown    | `excerpt/excerpt.ts`                         | 陪伴 Agent 的句子摘抄本                                                                            |
| `time-inject-state.json`                 | 明文 JSON        | `statusbar/time-inject.ts`                   | 时间注入节流状态                                                                                   |
| `weekly/report-YYYY-MM-DD.json`          | **KHBV2 加密**   | `weekly/report.ts`                           | 历次生成的周报                                                                                     |
| `weekly/state.json`                      | 明文 JSON        | `weekly/report.ts`                           | 周报锚点 `{lastGeneratedAt}`                                                                       |
| `settings/bindings.json`                 | 明文 JSON        | `core/bindings.ts`                           | 会话绑定表 `{bindings:[{sessionId,deliver,observe,addedAt}]}`                                      |
| `settings/ui.json`                       | 明文 JSON        | `config/ui-config.ts`                        | 运行时开关（间隔 / 上限 / 时间注入 / 状态栏 / 空闲 / 省流 / 看图引擎 / 静默收尾）                  |
| `settings/policy.json`                   | 明文 JSON        | `config/load.ts`                             | 用户策略覆盖层（深度合并到出厂 `config/policy.json` 之上）                                         |
| `settings/interests.json`                | 明文 JSON        | `browse/interests-edit.ts`                   | 用户闲逛兴趣词条（整体替换工厂层）                                                                 |
| `settings/vision.json`                   | 明文 JSON        | `screen/vision.ts`                           | 看图 `{engine,provider,prompt}` 覆盖                                                               |
| `settings/state.json`                    | 明文 JSON        | `core/session-gate.ts` / `ledger/archive.ts` | 会话闸门坏会话计数 `brokenStrikes`（满 3 拍解绑、成功清零）+ 账本归档首跑迁移标记                  |
| `settings/status.json`                   | 明文 JSON        | `statusbar/store.ts`                         | 最近一跳状态卡 `{at,scene,note≤30}`（供面板「状态」页读取）                                        |
| `logs/heartbeat.jsonl`                   | 明文 JSONL       | `core/audit-log.ts`                          | 核心审计与错误日志（仅记事件名、原因码、ID 与耗时，绝不落盘聊天正文、窗口标题、截图路径或 Cookie） |
| `logs/envpulse.jsonl`                    | 明文 JSONL       | `env/envpulse.ts`                            | 环境脉冲流（event `pulse`，与审计日志不同文件）                                                    |
| `logs/consolidation.txt`                 | 明文             | `profile/consolidate.ts`                     | 上次画像整合的 ISO 时间                                                                            |
| `tmp/`                                   | 明文瞬态         | 各模块                                       | 解密窗口 / 下载暂存，用完即 burn                                                                   |
| `exports/`                               | 明文             | `vault/migrate.ts` / `profile/store.ts`      | 画像导出 `profile-export-*.md` / 口令迁移容器 `heartbeat-memory-*.hbmig`                           |

> 口令迁移（`migrate export/import`）只搬记忆类文件；`gate.json`、`screen.*`、`settings/*`、`vault.key` 不在迁移清单里——它们机器本地或可重建（`src/vault/migrate.ts` 的 `MIGRATE_FILES`）。

---

## 3. 单跳执行流水线与核心机制

### 3.1 `beat(deps, trigger)` 完整生命周期

触发方式有四种：定时器到期（`interval`，带抖动）、启动首跳（`startup`，延迟 15s，不消耗心事匣序号）、省流恢复（`wake`）、引擎室获取失败的延迟重试（`retry`，退避 60s×2^n、上限 30min）。`src/core/orchestrator.ts` 的 `beat()`（:2639）按以下顺序执行：

```text
[1. 专注模式检查] ──(内存 OR focus.json 开启中)──► 记 silent(focus-mode)+until，状态卡 away，0 开销返回
       │
[2. 单飞锁 & 45min Watchdog] ──► 上一跳未结束则跳过；挂载 AbortController（BEAT_WATCHDOG_MS）
       │
[3. 心事匣开格] ──► 推进 beat 序号（startup 跳不推进），丢掉「展示过但没被续写」的旧便签（notepad_dropped）
       │
[4. 引擎室获取 ensureAgent] ──► 复用活实例 / resume / create
       ├─ 瞬态失败 → agent_deferred，本拍降级 agentless（只跑维护+采集）
       └─ 永久损坏（SessionFormatUnsupportedError 等）→ 重建
       │
[5. 旋转检查] ──► 上下文溢出标志 > 事件数≥3000 > 正身被归档 → rotateHome，
       本拍 silent(home rotated, next beat starts fresh) 返回
       │
[6. 无活动省流短路 Token Saver] ──► 开关开 + 绑定会话无未读用户消息 +（锁屏 OR 空闲≥1800s）
       → silent(token-saver)，改 3min 廉价唤醒探测；否则继续：
       │
[7. 维护 maintenance（≤10min）] ──► 池 GC、日志修剪（envpulse 48h / heartbeat 30d）、
       journal 折叠（≥5000）、一次性 KHBV1→KHBV2 升级、画像整合到期
       （inbox 积压≥inboxBacklog 或 距上次≥minIntervalHours 且有积压）→ 引擎室整合回合
       │
[8. 每周回顾 weekly] ──► enabled 且距锚点≥7 天 → 收集事实 → 引擎室周报回合
       （LLM 失败回落确定性模板）→ 保存 + 按 keepReports 修剪 → toast（安静时段跳过）
       │
[9. 采集 collect（≤5min）] ──► 每拍截屏+窗口（Windows PowerShell，加密落盘；非 Windows 降级）
       → 空闲探测+窗口分类+presence → recordPresence
       → 遍历 observe 会话（过会话闸门，按 cursors.json 增量，首句≤maxChars 入收件箱，受 perBeat 限）
       │
[10. 自主闲逛 wander（≤15min）] ──► 在 browse.windows 窗口内 + 当日次数 + minInterval + focus 冷却
       → 引擎室 web_search 回合 → 代码侧 addSeed(noMerge) + completeWander
       │
[11. 补货 refill_wander（≤15min）] ──► topic 存量≤4 且当日<2 次 → 绕过窗口/间隔，保留 3 天冷却
       │
[12. 表达 expression] ──► 分寸闸门 runGate（安静时段→忙碌窗口→正在打字→日上限→冷却）
       ├─ SILENT → silent(<reason>) 返回；无引擎室 → spoke_failed(no heartbeat agent)
       ├─ 处境摘要 digest → 组装候选 assembleCandidates（topic 随机 4 + chat 最新证据 2，互补≤6，B 站软上限 2）
       ├─ 空包 → idleMode? 画像 3 话题兜底(idle_fallback) : silent(no candidates)
       ├─ 看图 runScreenVision（只在「这一拍要说话」的路径上跑）
       ├─ 决策回合（引擎室，输出 {seed_ids,doing}，选≤3）；无 seed_ids / 无匹配 → expression_dropped
       └─ deliverPackage：
            投递目标（排除正身、去重）→ 会话闸门预检 → 全被拒：no_deliver_target + spoke_failed(no deliver target)
            逐候选拉起（活或 resume；resume 失败计 unreachable 振）→ 拉起后再过闸门 → 无活目标则声音回落正身(spoke_fallback)
            生成 deliveryId → 组装素材包（doing 行+声明+心事匣+素材≤3+心声可选+沉默指令+编号+报账指令）
            canSendLive 复查 → 表达回合（等目标空闲≤10min EXPRESSION_IDLE_WAIT_MS；超时但有正文 spoke_late / 无正文 spoke_deferred）
            读报账环 pickReport（编号匹配 > 匿名最新）→ reconcileReply 按事实对账 → deliveryVerdict 判沉默
            confirmSend 无条件记账 → surfaceSeed → 偏好记账或 report_missing → toast → spoke + delivered
       │
[13. 收尾] ──► 写状态卡（scene + note≤30）；顶层 catch：中止记 beat_aborted(stage,why)，其余记 beat_error
```

### 3.2 关键子系统约定

- **素材池：三层去重 + 三维配额**（`src/seeds/pool.ts`）
  - 去重比对范围是活跃池 + 近 30 天归档（归档最多 `DEDUP_ARCHIVE_MAX` 50 条）。三层依次判：① 文本完全一致（`exact`）；② NFKC 归一化（小写、去标点）后一致（`normalized`）；③ 字符二元组 **Dice** 相似度超过 `SEED_SIMILARITY_THRESHOLD`（0.85）判 `similar`。命中任一即拒入池，记 `seed_duplicate`。
  - 短文本保护：归一化后不足 `DEDUP_SIMILAR_MIN_CHARS`（12 字）跳过相似度层——短标题全是共享二元组，会误判。
  - 配额三维依次裁：来源（`SEED_SOURCE_CAPS`，bilibili 6）→ 类目（`SEED_CATEGORY_CAPS`，topic 16 / chat 14）→ 全局（`seeds.maxActive` 30）。同话题可合并，`noMerge` 豁免。
  - 退役原因：consumed / expired / cold_bench / pool_cap / source_cap / completed。chat 类用一次即退役。
  - B 站源专属：活跃池最多 6 条，单次投递包最多 `BILI_TOPIC_SOFT_CAP`（2 条），有效期 `BILI_SEED_TTL_DAYS`（2 天）。
- **五个陪伴 Agent 工具**（全局注册，引擎室被预设掩掉）
  - `notepad`（心事匣，开关 `notepadTool`）：actions `write` / `read` / `clear`，只有一格，写新盖旧；同文本保持不变，年龄不重置。单条上限 `MAX_NOTE_CHARS`（160 字）。只在投递会话可见——声明层用宿主 `when` 限定，执行层再兜底拒收（`notepad_blocked`）。
  - `ledger`（账本）与 `corrections`（错题本）：同一开关 `ledgerTool`，actions `add` / `list` / `done`，单条上限 `MAX_TEXT`（120 字）。`done` 把行从活页摘进归档（见下）。
  - `excerpt`（摘抄本，开关 `excerptTool`）：工具 actions `add` / `list` / `remove`。`open` 只有 CLI 有，不在工具 schema 里。
  - `seed_report`（素材报账，开关 `seedReportTool`）：必填 `spoken`（`material` / `heartfelt` / `silent`）与 `delivery_id`，素材需 `seed_ids`。沉默可带 `reason`，枚举 `不想说话` / `素材不搭` / `在忙或刚聊过`。超时 15s。
- **会话闸门**（v2.3.0，`src/core/session-gate.ts`）
  - 三种拒收理由：`archived`（在 workspace.json 归档集合里）；`subagent`（header.origin 是 subagent，或 delegationDepth>0，或前 8 条事件含 subagent/descriptor）；`broken`（严格读返回 null，或最后一轮 turn/end 带显式 reason:null）。
  - 裁决缓存 60 秒（`SESSION_GATE_TTL_MS`），同一拍的观察与投递只记一条 `session_skipped`。
  - `broken` 与 `unreachable`（真尝试 resume 但拉不起来）共享振数账本 `brokenStrikes`（在 settings/state.json）。累计满 `BROKEN_STRIKES_TO_REMOVE`（3 拍）自动解绑；任何一次完整通过（含被动复查）清零。解绑只动 bindings.json，记 `binding_auto_removed` / `binding_auto_remove_failed`。
  - 另有一套 `checkDeliverySession` 供心事匣的 `when` 与执行层兜底共用：先过闸门再查绑定，返回 `not-bound` / `not-deliver` / 闸门 reason。这套不计振、不记审计。
- **报账锁**（v2.3.0，`src/seeds/report.ts`）
  - `delivery_id` 必填，且必须等于当前素材包编号。重复检查与追加在同一个 `withFileLock` 临界区里做。
  - 拒收四理由：`unknown delivery`（编号不符，提示文案**不回显**活编号，只进审计）；`duplicate delivery`（同号已报过，可回显——调用方本就持有该号）；`lock timeout`（仅 `FileLockTimeoutError`，临界区没跑）；`write failed`（临界区跑过但内部抛错）。
  - 后两者审计后把错误抛给宿主，都不入账。
- **事实沉默与对账**（v2.3.0，`src/core/material.ts`）
  - `reconcileReply` 按**事实**判沉默：正文空，或只有沉默行（「本轮沉默」——剥掉 think 块/工具标签后每非空行都是沉默行），即沉默。报账只作参考。
  - 只有回合结束 kind 是 `completed`（`TURN_END_SILENCE_KIND`）才允许事实沉默；失败型 kind 一律走 `spoke_failed`。报账口径与事实不符记 `spoken_mismatch`。
- **静默收尾**（v2.3.0 实验，默认关）
  - `ui.json` 的 `concludeSilentTurn` 打开后，沉默指令改为零正文。
  - `seed_report` 报沉默且编号匹配 → 调宿主 `exec.concludeTurn()` 请求收尾，记 `conclude_silent_requested`；宿主无此 API 或抛错记 `conclude_silent_failed`。
  - `turn_concluded` 要过四道闸：开关开、label `expression`、kind `completed`、本轮真请求过收尾。否则仍记故障线 `turn_extraction_empty`。
- **账本与错题本归档**（v2.3.0，`src/ledger/ledger.ts` / `archive.ts`）
  - 两本都 live-only。`markDone` 把行从活页摘走、追加进 `<book>-done.md`（同格式、重打 done 日期）。**先归档再改写活页**，崩溃安全。
  - 归档去重四理由：`same-stamp`；`retry-window`（10 分钟内重试，`RETRY_WINDOW_MS`）；`retry-window-extended`（+60 分钟墙钟宽限 `RETRY_WALL_GRACE_MS`，防夏令会把 10 真实分钟拉成 70 墙钟分钟）；`future-stamp`（章在 now 之后 24h 内，`FUTURE_GRACE_MS`）。命中记 `book_done_deduped`。
  - 首跑迁移把活页里的 done 行搬进归档：标记在 settings/state.json，备份 `<book>.md.bak-<时间戳>`，记 `ledger_done_migrated` / `corrections_done_migrated`。CLI 用 `ledger/corrections done` 与 `ledger/corrections open --done`。
- **原生看图**（v2.3.0，`src/screen/vision.ts`）
  - 引擎三值 `native` / `modlens` / `auto`。优先级：插件配置 `visionEngine` > 面板卡 > settings/vision.json > `auto`。
  - `native`：走 `attachments.saveImage` → `createUserMessage` 图像块 → followup，和用户贴图同一条路。先探 `inputModalities`，探测失败记 `vision_modality_probe_failed` 并按不支持处理。
  - `auto`：原生优先，失败回落 modlens，`screen_vision` 带清洗后的 `nativeError`。`modlens`：运行时解析 `@liustack/modlens` CLI，provider 默认 `openai`，超时 `VISION_TIMEOUT_MS`（120s）。
  - 错误文本清洗（`scrubShotPath`）：截图路径与 basename → `<screenshot>`；按深到浅把根归一化为 `<data-tmp>` / `<data>` / `<tmp>` / `<home>`；外来绝对路径 → `<path>`；最后截到 `VISION_ERROR_MAX`（160 字）。明文截图窗口用完即 burn。
  - 看图失败 → 无图、无窗口标题、无 doing。中止多数抛 `BeatAbortedError`（stage `vision`）→ `beat_aborted`；路由读完图之后的中止抛普通 Error → `beat_aborted` 且 stage `unknown`、带 error。无论哪种都不记 `screen_vision ok:false`。
- **心事匣与状态栏收口**（v2.3.0）
  - 心事匣只在投递会话可用（声明层 `when` + 执行层兜底）。宿主不支持 `when` 时工具照常注册，记 `${name}_tool_when_unsupported`（如 `notepad_tool_when_unsupported`）。
  - 状态栏只在投递会话渲染：每次「切进某原因」记一次 `statusbar_skipped`，翻转记 `statusbar_track`。
  - 时间注入仍是 step===1 + 用户回合起源 + 节流，子代理跳过（`time_inject_skipped`，reason `subagent`）。时间行本身不受投递闸门影响。

---

## 4. 参数与配置去哪里查

插件参数分四层，优先级从低到高：**工厂 policy < 用户 policy < ui.json < 宿主插件 Config**（`src/index.ts:231`、`src/config/ui-config.ts:6`）。

### 4.1 第一层：宿主插件配置（`cordis.patch.yml` / 插件设置页）

Config schema 定义在 `src/index.ts:129`。包内 `cordis.patch.yml` 只 insert 一行 `id: heartbeat`，预设改为运行时注册（不再声明 preset 行，避免 peer 闭包双实例）。要钉死数据目录，在 **profile 自己的** `cordis.patch.yml` 里按 id 覆盖 `config.dataDir`。

| 参数名           | 类型      | 默认值                                | 说明                                                                                                                      |
| ---------------- | --------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `dataDir`        | `string`  | `""`（即 `$DSH_HOME/heartbeat-data`） | 自定义数据目录绝对路径。显式目录永远赢，**不自动搬迁**（搬迁只针对旧包内目录，记 `data_dir_relocated`）                   |
| `intervalMin`    | `number`  | `0`                                   | 0 = 用策略层（工厂 60）；非 0 直接覆盖心跳间隔                                                                            |
| `maxDailySend`   | `number`  | `0`                                   | 0 = 用策略层（工厂 10）                                                                                                   |
| `agentPreset`    | `string`  | `"heartbeat"`                         | 引擎室挂的预设 id                                                                                                         |
| `installPreset`  | `boolean` | `true`                                | 启动时是否文件系统自装预设到 `$DSH_HOME/.agent-presets/heartbeat/`（已有同名目录绝不覆盖，除非 `preset install --force`） |
| `timeInjectMin`  | `number`  | 可选                                  | 缺省回落 25；0 = 关注入                                                                                                   |
| `timeZone`       | `string`  | `""`                                  | 空 = 系统本地时区                                                                                                         |
| `statusbar`      | `boolean` | 可选（缺省关）                        | 状态栏开关，`=== true` 才开                                                                                               |
| `idleMode`       | `boolean` | 可选（缺省关）                        | 空闲模式开关                                                                                                              |
| `tokenSaver`     | `boolean` | 可选（缺省关）                        | 无活动省流开关                                                                                                            |
| `ledgerTool`     | `boolean` | `true`                                | 账本 + 错题本工具（同一开关）                                                                                             |
| `seedReportTool` | `boolean` | `true`                                | 报账工具                                                                                                                  |
| `notepadTool`    | `boolean` | `true`                                | 心事匣工具                                                                                                                |
| `excerptTool`    | `boolean` | `true`                                | 摘抄本工具                                                                                                                |
| `extraTools`     | `string`  | `""`                                  | 引擎室额外工具（逗号分隔）                                                                                                |
| `visionEngine`   | `string`  | `""`                                  | 空 = 回落面板卡 / vision.json / auto                                                                                      |

设置页改配置会重载插件。

### 4.2 第二层：运行时开关（`settings/ui.json`，面板「设置」页）

定义在 `src/config/ui-config.ts`，可通过面板直接切换或调 RPC `config.set` 修改。**没有 `enabled` 总开关，也没有 `screenVision` 开关**——截图每拍都采，看图只在「要说话」的路径上跑。

| 字段名               | 类型      | 默认值  | 说明                                                                         |
| -------------------- | --------- | ------- | ---------------------------------------------------------------------------- |
| `intervalMin`        | `number`  | 工厂 60 | 心跳基础间隔（分钟，范围 `[1,1440]`），修改后立即重设定时器                  |
| `maxDailySend`       | `number`  | 工厂 10 | 每日主动搭话上限（范围 `[1,50]`）                                            |
| `timeInjectMin`      | `number`  | 回落 25 | 时间注入节流分钟（范围 `[0,1440]`，0 = 关）                                  |
| `statusbar`          | `boolean` | 关      | 状态栏开关                                                                   |
| `idleMode`           | `boolean` | 关      | 闲着没事模式：素材池为空时，是否允许拿画像兴趣条目当话题搭话                 |
| `tokenSaver`         | `boolean` | 关      | 无活动省流：用户离开（锁屏或空闲≥1800s）且绑定会话无未读消息时，跳过表达评估 |
| `visionEngine`       | `string`  | `""`    | 看图引擎，取值 `""` / `auto` / `native` / `modlens`                          |
| `concludeSilentTurn` | `boolean` | `false` | 实验性静默收尾开关（见 §3.2）                                                |

`config.set` 还识别 `psyEnabled` / `quietStart` / `quietEnd` 三个键，但它们写的是**策略用户层**（`settings/policy.json`），不是 ui.json（`src/rpc.ts:488`，记 `ui_config_set`）。除 intervalMin 立即生效外，其余下一拍生效。

### 4.3 第三层：策略参数（`config/policy.json` 与 `settings/policy.json`）

- **去哪里查定义与校验**：`src/config/schema.ts`（`Policy` 接口与 `assertPolicy` 函数）。
- **去哪里看默认出厂值**：仓库根目录 `config/policy.json`（只读出厂层）。
- **怎么改**：在 `<dataDir>/settings/policy.json` 写入需要覆盖的字段（支持只写局部子字段，加载时通过 `deepMerge` 合并）。其中 `gate.quietHours` 可直接在面板「设置」页修改，闲逛窗口在「兴趣」页修改。

| 路径                                     | 默认值                                        | 合法范围          | 作用说明                                                                                 |
| ---------------------------------------- | --------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------- |
| `heartbeat.intervalMin`                  | `60`                                          | `[1,1440]`        | 出厂默认心跳间隔（被 ui.json / Config 优先覆盖）                                         |
| `heartbeat.intervalJitterPct`            | `20`                                          | `[0,50]`，可选    | 节律抖动百分比：每跳实际等待 `interval × (1 ± p%)` 均匀随机，防掐表机械感；设 0 关闭抖动 |
| `heartbeat.idleMode`                     | `false`                                       | `boolean`         | 出厂默认空闲模式开关                                                                     |
| `heartbeat.archiveRotatedHome`           | `true`                                        | `boolean`         | 引擎室旋转淘汰旧正身时，是否自动在宿主 workspace.json 标记归档                           |
| `gate.maxDailySend`                      | `10`                                          | `>= 0`            | 每日最多主动搭话次数（本地自然日 00:00 重置，`localDayKey`）                             |
| `gate.cooldownMinutes`                   | `30`                                          | `>= 0`            | 两次主动搭话之间的最短冷却分钟数                                                         |
| `gate.quietHours`                        | `{start:"01:00", end:"08:00"}`                | `HH:MM`           | 安静时段（支持跨午夜、左闭右开，时段内门禁返回 `quiet hours`）                           |
| `browse.windows`                         | `11:00-15:00`, `17:00-21:00`                  | 非空 `HH:MM` 数组 | 允许触发自主闲逛的本地时间窗口                                                           |
| `browse.minIntervalHours`                | `4`                                           | `> 0`             | 两次自主闲逛之间的最短间隔小时数                                                         |
| `browse.maxSeedsPerVisit`                | `4`                                           | `>= 1`            | 单次闲逛最多允许入池的素材条数                                                           |
| `seeds.maxActive`                        | `30`                                          | `>= 1`            | 活跃素材池容量上限                                                                       |
| `seeds.ttlDays`                          | `{news:3, fandom:14, scene:60, promise:90}`   | `number`          | 各标签素材的存活天数                                                                     |
| `seeds.coldBenchDays`                    | `21`                                          | `number`          | 素材连续多少天未被选中则移入冷板凳归档                                                   |
| `seeds.archiveCap`                       | `50`                                          | `>= 1`            | 归档区最多保留多少条历史素材（超出按最旧裁剪，记 `seed_archive_trimmed`）                |
| `seeds.retireAfterUsed`                  | `2`                                           | `>= 1`            | 同一条素材被实际使用多少次后自动归档                                                     |
| `seeds.scoreWeights`                     | `{freshness:0.4, unused:0.3, confidence:0.3}` | 权重对象          | 投递前候选素材打分公式权重                                                               |
| `profile.consolidation.minIntervalHours` | `12`                                          | `number`          | 画像整合的最短时间间隔（小时）                                                           |
| `profile.consolidation.inboxBacklog`     | `30`                                          | `number`          | 收件箱积压多少条观测记录时提前触发画像整合                                               |
| `profile.partitionCap`                   | `50`                                          | `>= 1`            | 每个画像分区最多保留多少条记录                                                           |
| `profile.maxOpsPerRun`                   | `10`                                          | `>= 1`            | 单次画像整合最多允许执行的增删改操作数                                                   |
| `profile.confidenceCap`                  | `{chat:0.6, screen:0.4, browse:0.4}`          | `0–1`             | 不同来源证据写入画像时的置信度天花板                                                     |
| `profile.volatileDays`                   | `14`                                          | `>= 1`            | volatile（短期状态）条目的过期天数                                                       |
| `profile.stableLowActivityDays`          | `180`                                         | `>= 1`            | stable 条目多久未命中后打上 lowActivity 标记                                             |
| `profile.psyEnabled`                     | `false`                                       | `boolean`         | 是否启用 psy（心理与情感倾向）分区                                                       |
| `observe.maxChars`                       | `80`                                          | `[20,2000]`       | 单条用户发言摘录进收件箱的最大字符数                                                     |
| `observe.perBeat`                        | `10`                                          | `[1,100]`         | 单跳最多从单个观察会话消费多少条新用户发言                                               |
| `weekly.enabled`                         | `true`                                        | `boolean`         | 是否自动生成周报（7 天滚动锚点，首份在装机一周后）                                       |
| `weekly.keepReports`                     | `3`                                           | `[1,52]`          | 最多保留最近多少份周报文件                                                               |
| `retention.envPulseHours`                | `48`                                          | `number`          | `logs/envpulse.jsonl` 保留最近多少小时的脉冲记录                                         |
| `retention.decisionLogDays`              | `30`                                          | `number`          | `logs/heartbeat.jsonl` 保留最近多少天的审计日志                                          |
| `sources.bilibili.enabled`               | 可选（有凭据即开）                            | `boolean`         | 设 false 可在不删凭据的情况下硬关闭 B 站观看历史源                                       |
| `sources.bilibili.cookieFile`            | 可选                                          | `string`          | 可选外部 Cookie 文件路径（未扫码登录时的回退凭据源）                                     |

> 兴趣文件（`config/interests.json` / `settings/interests.json`）里的 `_schedule` 在重叠处覆盖 `policy.browse`，由 `resolveSchedule` 读取。键有 `windows`、`min_interval_hours`、`max_seeds_per_focus`、`daily_sessions`（默认 0）、`focus_per_session`（默认 1）、`focus_cooldown_days`（默认 3）。
>
> `config/busy-rules.json` 的 `rules` 只有工厂层，缺键回落工厂值：`focus_stable_seconds` 15、`idle_away_seconds` 1200、`idle_floor_seconds` 30、`visible_window_cap` 20。

### 4.4 第四层：源码内部硬编码常量（调优时查这里）

| 常量名                                          | 当前值               | 所在文件与行号                  | 说明                                                   |
| ----------------------------------------------- | -------------------- | ------------------------------- | ------------------------------------------------------ |
| `HOME_ROTATE_EVENT_COUNT`                       | `3000`               | `src/core/orchestrator.ts:254`  | 引擎室主动旋转的事件数阈值                             |
| `IDLE_WAIT_TIMEOUT_MS`                          | `240_000` (4 min)    | `src/core/orchestrator.ts:267`  | 引擎室回合等待空闲的默认超时（agentTurn 默认值，:993） |
| `EXPRESSION_IDLE_WAIT_MS`                       | `600_000` (10 min)   | `src/core/orchestrator.ts:274`  | 向陪伴会话投递前等待会话空闲的最大时间                 |
| `BEAT_WATCHDOG_MS`                              | `2_700_000` (45 min) | `src/core/orchestrator.ts:311`  | 单跳卡死强制 Abort 并释放单飞锁的看门狗阈值            |
| `MAINTENANCE_TIMEOUT_MS`                        | `600_000` (10 min)   | `src/core/orchestrator.ts:350`  | 维护阶段超时                                           |
| `COLLECT_TIMEOUT_MS`                            | `300_000` (5 min)    | `src/core/orchestrator.ts:351`  | 采集阶段超时                                           |
| `WANDER_TIMEOUT_MS`                             | `900_000` (15 min)   | `src/core/orchestrator.ts:352`  | 闲逛/补货阶段超时                                      |
| `TOKEN_SAVER_IDLE_SECONDS`                      | `1800` (30 min)      | `src/core/orchestrator.ts:2533` | 省流判定的空闲阈值                                     |
| `TOKEN_SAVER_WAKE_MS`                           | `180_000` (3 min)    | `src/core/orchestrator.ts:2542` | 省流期间的廉价唤醒探测间隔                             |
| `SESSION_GATE_TTL_MS`                           | `60_000` (60 s)      | `src/core/session-gate.ts:32`   | 会话闸门裁决缓存时长                                   |
| `BROKEN_STRIKES_TO_REMOVE`                      | `3`                  | `src/core/session-gate.ts:33`   | 坏会话/拉不起来累计满几拍自动解绑                      |
| `REPORT_KEEP`                                   | `400`                | `src/seeds/report.ts:44`        | 报账环最多保留条数                                     |
| `RETRY_WINDOW_MS`                               | `600_000` (10 min)   | `src/ledger/ledger.ts:90`       | 归档去重的重试窗口                                     |
| `RETRY_WALL_GRACE_MS`                           | `3_600_000` (60 min) | `src/ledger/ledger.ts:103`      | 重试窗口的墙钟宽限（防 DST）                           |
| `FUTURE_GRACE_MS`                               | `86_400_000` (24 h)  | `src/ledger/ledger.ts:108`      | 未来章按重试处理的宽限                                 |
| `SEED_CATEGORY_CAPS`                            | topic 16 / chat 14   | `src/seeds/pool.ts:44`          | 类目配额                                               |
| `SEED_SOURCE_CAPS`                              | bilibili 6           | `src/seeds/pool.ts:51`          | 来源配额                                               |
| `SEED_SIMILARITY_THRESHOLD`                     | `0.85`               | `src/seeds/pool.ts:93`          | 字符二元组 **Dice** 近似去重阈值（不是 Jaccard）       |
| `BILI_TOPIC_SOFT_CAP`                           | `2`                  | `src/core/material.ts:53`       | 单次投递包最多选入的 B 站素材条数                      |
| `BUDGET_CHARS`                                  | `6000`               | `src/profile/digest.ts:28`      | 处境摘要总字符预算上限                                 |
| `SNAPSHOT_THRESHOLD`                            | `5000`               | `src/profile/snapshot.ts:24`    | journal 折叠快照的行数阈值                             |
| `VISION_TIMEOUT_MS`                             | `120_000` (2 min)    | `src/screen/vision.ts:54`       | 看图回合超时                                           |
| `VISION_ERROR_MAX`                              | `160`                | `src/screen/vision.ts:187`      | 看图错误文本清洗后的截断长度                           |
| `BILI_FETCH_INTERVAL_MS`                        | `7_200_000` (2 h)    | `src/sources/bilibili.ts:77`    | B 站观看历史两次拉取的最短间隔                         |
| `BILI_SEED_TTL_DAYS`                            | `2`                  | `src/sources/bilibili.ts:74`    | B 站素材有效期                                         |
| `REFILL_TOPIC_THRESHOLD` / `REFILL_MAX_PER_DAY` | `4` / `2`            | `src/browse/browse.ts:288`      | 补货触发存量阈值 / 当日补货上限                        |
| `WEEKLY_INTERVAL_MS`                            | `604_800_000` (7 d)  | `src/weekly/report.ts:16`       | 周报滚动锚点间隔                                       |

> `TURN_TIMEOUT_MS`（`src/core/orchestrator.ts:266`）虽有声明但当前未被引用——引擎室回合实际走 `IDLE_WAIT_TIMEOUT_MS`，表达回合走 `EXPRESSION_IDLE_WAIT_MS`，故不把它列为生效超时。

---

## 5. 错误日志怎么看、怎么查

### 5.1 日志位置与查看方式

所有运行轨迹、门禁拦截原因、模型超时与异常全部以 **JSON Lines** 格式追加在 `<dataDir>/logs/heartbeat.jsonl`；环境脉冲流在另一个文件 `logs/envpulse.jsonl`（event `pulse`）。维护阶段自动修剪（envpulse 48h / heartbeat 30d），也可手动清理。

**常用查询命令**（CLI 没有 `logs --tail`，看最近几条用 shell 的 `tail`）：

```bash
# 1. 查看当前工作区路径与策略摘要
node dist/cli/index.js status

# 2. 预览 / 执行日志保留清理
node dist/cli/index.js logs cleanup --dry-run
node dist/cli/index.js logs cleanup

# 3. 看最近 30 条审计
tail -n 30 ~/.dsh/heartbeat-data/logs/heartbeat.jsonl

# 4. 只看错误与失败事件
grep -E '"event":"([^"]*_failed|[^"]*_error|beat_watchdog|beat_aborted)"' ~/.dsh/heartbeat-data/logs/heartbeat.jsonl | tail -n 20

# 5. 看为什么今天一直没搭话
grep -E '"event":"(silent|spoke|spoke_failed|spoke_deferred)"' ~/.dsh/heartbeat-data/logs/heartbeat.jsonl | tail -n 20
```

### 5.2 审计日志 `event` 速查字典

每行 JSON 至少包含 `{"ts":"ISO8601","event":"..."}`。按生命周期分类如下；行号指审计发出语句那一行（单行调用行或多行调用的 `event:` 字段行，差 1–2 行），漂移时以事件名 + 文件 grep 为准。

#### A. 启动、调度与单跳控制

| `event`                                  | 关键附加字段                                                | 含义与触发位置                                                                                                                                                                                                                                                     |
| ---------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `plugin_init`                            | `dataDir`                                                   | 插件启动完成工作区初始化（`src/index.ts:459`）                                                                                                                                                                                                                     |
| `data_dir_relocated`                     | `from`, `to`, `files`, `bytes`, `warnings`, `leftovers`     | 旧包内数据搬出成功（`src/index.ts:469`）                                                                                                                                                                                                                           |
| `data_dir_relocate_failed`               | `stage`, `problems`                                         | 搬迁失败，保留原目录继续用（`src/index.ts:484`）                                                                                                                                                                                                                   |
| `preset_register` / `preset_install`     | —                                                           | 预设运行时注册 / 文件系统自装（`src/index.ts:321` / `:351`）                                                                                                                                                                                                       |
| `rpc_registered`                         | `route`                                                     | RPC 路由装好（`src/rpc.ts:760`）                                                                                                                                                                                                                                   |
| `rpc_host_gate_missing`                  | —                                                           | 宿主闸门缺失，只开只读端点（`src/rpc.ts:711`）                                                                                                                                                                                                                     |
| `orchestrator_started`                   | `intervalMin`                                               | 调度器启动（`src/core/orchestrator.ts:2859`）                                                                                                                                                                                                                      |
| `orchestrator_disposed`                  | `beatCancelled`                                             | 随宿主停机卸载（`src/core/orchestrator.ts:2922`）                                                                                                                                                                                                                  |
| `interval_changed`                       | `intervalMin`                                               | 间隔被改（`src/core/orchestrator.ts:95`）                                                                                                                                                                                                                          |
| `interval_scheduled`                     | `intervalMin`, `jitterPct`, `delayMs`                       | 算好下一跳抖动延迟（仅在间隔变化时记，`src/core/orchestrator.ts:2878`）                                                                                                                                                                                            |
| `beat_start`                             | `trigger`（startup/interval/wake/retry）                    | 单跳正式开始（通过专注模式与单飞锁之后）                                                                                                                                                                                                                           |
| `phase_done`                             | `phase`（maintenance/collect/wander/refill_wander）         | 某阶段正常跑完（`src/core/orchestrator.ts:2763`）。wander / refill_wander 既是这里的 phase 取值，也各自发出同名审计事件（见 E 组）                                                                                                                                 |
| `beat_watchdog`                          | `reason`                                                    | **异常**：单跳超过 45 分钟未结束，Watchdog 触发 Abort 并释放锁（`src/core/orchestrator.ts:2679`）                                                                                                                                                                  |
| `beat_aborted`                           | `stage`, `why`（普通 Error 撞已中止 signal 时另带 `error`） | 被 Watchdog 或宿主关闭信号中途取消的跳（beat() 顶层 catch，`src/core/orchestrator.ts:2799`）                                                                                                                                                                       |
| `beat_error`                             | `error`                                                     | **异常**：未捕获的单跳顶层错误（上下文溢出会打标触发旋转）                                                                                                                                                                                                         |
| `beat_agentless`                         | —                                                           | 宿主无法创建/恢复引擎室，本跳降级纯本地运行                                                                                                                                                                                                                        |
| `token_saver_resumed`                    | `via`, `heldMin`（wake 路径另带 `checks`）                  | 省流恢复（`src/core/orchestrator.ts:2577` wake / `:2755` interval）                                                                                                                                                                                                |
| `status_written` / `status_write_failed` | `scene` / `error`                                           | 状态卡写盘成功 / 失败（`src/core/orchestrator.ts:2508` / `:2510`）                                                                                                                                                                                                 |
| `turn_concluded`                         | `label`, `kind`, `window`                                   | 回合正常收尾（completed）但取不到 assistant 文本，且四重门控全过：① 静默收尾开关开；② label `expression`；③ 结束 kind 是 `TURN_END_SILENCE_KIND`（=completed）；④ 本轮真发起过 conclude。此时零正文是预期形态，记这条而非故障线（`src/core/orchestrator.ts:1047`） |
| `turn_extraction_empty`                  | `label`, `window`（有终止错误时附 `turnError`）             | 回合取不到正文的故障线：开关关、非 expression、失败 kind、没发起 conclude 时仍记这条（`src/core/orchestrator.ts:1057`）                                                                                                                                            |

#### B. 为什么没说话？（`silent` 与门禁 / 专注 / 省流）

当发现心跳没有主动搭话时，查 `"event":"silent"` 的 `reason` 字段即可定位。主要取值如下（注意状态卡 note 的措辞与审计 reason 不完全相同，例如审计记 `token-saver`，状态卡 note 记 `token-saver（你不在，心跳挂起）`）：

| `silent` 的 `reason` 值                                    | 含义                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `focus-mode`                                               | 正处于专注模式暂停期内（附带 `until` 到期时间，`src/core/orchestrator.ts:2652`）                                                                                                                                                                                                                                                                                                                                                                                                              |
| `token-saver`                                              | 开了无活动省流，用户离开（锁屏或空闲≥1800s）且绑定会话无未读消息（`src/core/orchestrator.ts:2748`）                                                                                                                                                                                                                                                                                                                                                                                           |
| `home rotated, next beat starts fresh`                     | 引擎室刚旋转，本拍歇一拍（`src/core/orchestrator.ts:2737`）                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `no candidates`                                            | 候选素材池为空，且未开 idleMode（或画像也为空，`src/core/orchestrator.ts:2361`）                                                                                                                                                                                                                                                                                                                                                                                                              |
| `quiet hours`                                              | 当前本地时间在安静时段（`gate.quietHours`）内（`src/gate/gate.ts:79`）                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `busy window (<why>)`                                      | 前台是忙碌进程或全屏游戏（`src/gate/gate.ts:81`）                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `master actively typing (front=<cls>)`                     | 主人正在前台打字（`src/gate/gate.ts:84`）                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `daily cap reached (<cap>)`                                | 今日主动搭话次数已达 `gate.maxDailySend` 上限（`src/gate/gate.ts:87`）                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `cooldown <N>min left`                                     | 距上次主动搭话未满 `gate.cooldownMinutes`（`src/gate/gate.ts:93`）                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `正文为空`                                                 | **v2.3.0 事实判定**：这一轮回复正文空（没有任何可见文字）且回合正常收尾（completed），按沉默记账，不花额度。silent 行恒带 `turnEndKind`（silent 分支只在 completed 下进入），报过账时另带 `reportedSpoken`。**同现说明**：开关关（或本轮没发起 conclude）时，零正文会同时记 `turn_extraction_empty`（故障线）和这条 silent，此时 reason 带后缀 `正文为空（回合无输出）`；**收尾路径不带后缀**（开关开且已发起 conclude，零正文是预期形态）。源码 `src/core/orchestrator.ts:2116` 注释引用本句 |
| `正文只有沉默行`                                           | 正文只有「本轮沉默」那类沉默声明行，按沉默记账（不与故障线同现，无后缀）                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `按事实记沉默(报账 spoken=X,正文为空)` / `…正文只有沉默行` | 报了账但正文空着：以**事实**为准记沉默，括号里是 Agent 自报口径，供对账（`src/core/material.ts:494` 的 `deliveryVerdict`）                                                                                                                                                                                                                                                                                                                                                                    |
| `报账沉默:<reason>`                                        | 报账说 silent 且正文也确实没有可发声内容，`<reason>` 是 Agent 给的原因；无 reason 时记 `报账沉默:未说明`。同现后缀规则与 `正文为空` 一致                                                                                                                                                                                                                                                                                                                                                      |

失败型回合不进 silent，走 `spoke_failed`：`target turn blocked` / `target turn failed` / `target turn aborted` / `target turn interrupted` / `target turn hit max tokens` / `target turn forked` / `target turn <未知kind>`（只有 completed 才可能是事实沉默）；`turn end unknown`（窗口里看不到 turn/end，无法区分「模型没说话」和「结束事件没扫到」，**只在 spoke_failed 侧**）；`non-Chinese output discarded`（正文有内容但全被中文闸滤掉，同样只在 spoke_failed 侧）。

#### C. 投递与陪伴会话（`deliver_*` / `spoke_*`）

| `event`                                                     | 关键附加字段                                                                                    | 含义与排障指引                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `delivered`                                                 | `sessionId`（≠正身才记）                                                                        | 投递包已送达陪伴会话（`src/core/orchestrator.ts:2243`）                                                                                                                                                                                                                                                         |
| `spoke`                                                     | `text≤80`, `seeds`, `profile_ids`, `source`, `spoken`（报账时另带 `reason` / `reportedSpoken`） | 陪伴 Agent 完成表达（`src/core/orchestrator.ts:2237`）                                                                                                                                                                                                                                                          |
| `deliver_target_preset`                                     | `sessionId`, `policy`                                                                           | 投递目标预设掩码（`src/core/orchestrator.ts:1742`）                                                                                                                                                                                                                                                             |
| `deliver_target_live`                                       | `sessionId`                                                                                     | 复用活投递会话（:1751）                                                                                                                                                                                                                                                                                         |
| `deliver_target_resumed`                                    | `sessionId`, `model`                                                                            | resume 成功（:1763）                                                                                                                                                                                                                                                                                            |
| `deliver_target_resume_failed`                              | `sessionId`, `error`                                                                            | resume 失败，计 unreachable 振（:1784）                                                                                                                                                                                                                                                                         |
| `deliver_target_released` / `deliver_target_release_failed` | `sessionId`（失败另带 `error`）                                                                 | 释放 resume 来的会话成功 / 失败（:1774 / :1777）                                                                                                                                                                                                                                                                |
| `session_skipped`                                           | `sessionId`, `reason`（archived/subagent/broken）                                               | 会话闸门拦下这个会话（v2.3.0，发出在 `src/core/session-gate.ts:296`）；裁决有 60 秒缓存，同一拍只记一条                                                                                                                                                                                                         |
| `binding_auto_removed`                                      | `sessionId`, `reason`（archived/subagent/broken/unreachable）                                   | 闸门判定绑定作废，已从 settings/bindings.json 自动摘掉（归档与子代理首次即摘；broken 与 unreachable 要连续 3 拍。unreachable = 真尝试拉起但拉不起来，`src/core/orchestrator.ts:1498`）                                                                                                                          |
| `binding_auto_remove_failed`                                | `sessionId`, `error`                                                                            | **异常**：摘绑定写盘失败，绑定还在，下一拍重试（`src/core/orchestrator.ts:1501`，注意无 d）                                                                                                                                                                                                                     |
| `no_deliver_target`                                         | `targets`（sessionId 逗号串）                                                                   | 绑定都在但全部过不了闸门（v2.3.0，`src/core/orchestrator.ts:1968`）；紧跟一条 `spoke_failed: no deliver target`                                                                                                                                                                                                 |
| `spoke_fallback`                                            | —                                                                                               | 无活投递目标，声音回落引擎室（`src/core/orchestrator.ts:2010`）                                                                                                                                                                                                                                                 |
| `spoke_deferred`                                            | `reason`（target session busy）                                                                 | 目标会话正忙，等 10 分钟仍未空闲，本跳延后（`src/core/orchestrator.ts:2094`）                                                                                                                                                                                                                                   |
| `spoke_late`                                                | —                                                                                               | 超时但有正文 / 二次复查失败（`src/core/orchestrator.ts:2100`）                                                                                                                                                                                                                                                  |
| `spoke_failed`                                              | `reason`                                                                                        | **投递失败**，常见 reason：`no deliver target`（绑定全被闸门拒）、`no voice agent`（无活目标且回落失败）、`no heartbeat agent`（无引擎室）、闸门 reason、以及 §B 列的失败型回合 reason                                                                                                                          |
| `report_missing`                                            | `offered`                                                                                       | 陪伴 Agent 回复了文字但**漏调 seed_report**（`src/core/orchestrator.ts:2226`）                                                                                                                                                                                                                                  |
| `report_read_failed`                                        | `error`                                                                                         | 读报账环失败（`src/core/orchestrator.ts:2135`）                                                                                                                                                                                                                                                                 |
| `report_rejected`                                           | `reason`（unknown delivery / duplicate delivery / lock timeout / write failed）                 | **v2.3.0 报账锁**：delivery_id 缺失/不符/已报过，拒收不入账。lock timeout = 跨进程锁取不到（临界区没跑，只认 FileLockTimeoutError）；write failed = 临界区跑过但内部抛错。两者审计后抛给宿主。不符的拒收文案绝不回显活编号（活编号只在这条审计里）；重复报账回显的是调用方自己刚填的号（`src/seeds/report.ts`） |
| `spoken_mismatch`                                           | `reported`, `actual`                                                                            | 报账口径与实际正文不符（v2.3.0）：reported 是 Agent 自报 spoken，actual 是从正文区出的事实（`src/core/orchestrator.ts:2147`）                                                                                                                                                                                   |
| `conclude_silent_requested` / `conclude_silent_failed`      | `deliveryId`（失败另带 `reason`: no-host-api/threw、`error`）                                   | 开着静默收尾且 silent 报账通过编号校验后，seed_report 调宿主 concludeTurn() 请求收尾（这是「已请求」，最终态以 turn/end 为准，`src/seeds/report.ts:378` / `:370` / `:381`）                                                                                                                                     |
| `decision_deferred`                                         | `reason`                                                                                        | 决策轮超时推迟（字段是 reason，`src/core/orchestrator.ts:2401`）                                                                                                                                                                                                                                                |
| `expression_dropped`                                        | `why`（匹配失败时另带 `requested`）                                                             | 素材丢弃：`no seed_ids from the decision turn` / `seed_ids matched no active material`（`src/core/orchestrator.ts:2424` / `:2442`）                                                                                                                                                                             |
| `expression_dropped_streak`                                 | `consecutive`, `why`                                                                            | 连续 ≥3 拍丢弃告警（`src/core/orchestrator.ts:2472`）                                                                                                                                                                                                                                                           |
| `idle_fallback`                                             | —                                                                                               | 空包走画像话题兜底                                                                                                                                                                                                                                                                                              |
| `statusbar_skipped` / `statusbar_track`                     | `sessionId`, `reason`                                                                           | 非投递会话不渲染状态栏 / 状态翻转（v2.3.0，`src/statusbar/track.ts`）                                                                                                                                                                                                                                           |
| `time_inject_skipped`                                       | `sessionId`, `reason`（subagent）                                                               | 子代理会话不注入时间（发出在 `src/statusbar/time-inject.ts:216`）                                                                                                                                                                                                                                               |
| `time_injected`                                             | `sessionId`, `intervalMin`                                                                      | 时间注入（`src/statusbar/time-inject.ts:247`）                                                                                                                                                                                                                                                                  |
| `notepad_blocked`                                           | `sessionId`                                                                                     | 心事匣在投递闸门之外的会话被调用，执行层兜底拒收（v2.3.0，声明层已用 when 隐藏）                                                                                                                                                                                                                                |
| `notepad_dropped`                                           | —                                                                                               | 丢掉「展示过但没被续写」的旧便签                                                                                                                                                                                                                                                                                |
| `preference_record_failed`                                  | `error`                                                                                         | 偏好记账失败（`src/core/orchestrator.ts:2188`）                                                                                                                                                                                                                                                                 |

#### D. 引擎室（Home Session）生命周期与旋转

| `event`                                          | 关键附加字段                                           | 含义与排障指引                                                                                                                                                           |
| ------------------------------------------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `agent_reuse_live`                               | `sessionId`                                            | 复用内存活实例（`src/core/orchestrator.ts:830`）                                                                                                                         |
| `agent_resume_start` / `agent_resume_ok`         | `sessionId`（ok 另带 `model`）                         | 开始 / 完成从磁盘恢复（:836 / :840）                                                                                                                                     |
| `agent_resume_failed` / `agent_resume_permanent` | `sessionId`, `error`                                   | 恢复瞬态失败 / 永久损坏（匹配 SessionFormatUnsupportedError 则判永久并重建，:844 / :871）                                                                                |
| `agent_create_start` / `agent_create_ok`         | `sessionId`, `model`（ok 另带 `selfHealed` / `fresh`） | 开始 / 完成新建（:890 / :878 / :884 / :895）                                                                                                                             |
| `agent_deferred`                                 | `sessionId`, `reason`                                  | 瞬态获取失败，延迟退避重试（:863）                                                                                                                                       |
| `agent_acquire_failed`                           | `error`                                                | 获取失败（:900）                                                                                                                                                         |
| `agent_cache_discarded`                          | `reason`                                               | 缓存句柄不可用，作废重取（:806）                                                                                                                                         |
| `home_rotate_start` / `home_rotate_done`         | `from`, `to`, `reason`                                 | 触发 / 完成自动旋转（reason 取自 homeRotatePending：`size threshold (N events ≥ 3000)` / `context overflow: <error>` / `home session archived (<homeId>)`，:688 / :705） |
| `home_rotate_failed`                             | `error`                                                | **异常**：旋转创建新会话失败，检查默认模型路由（只有 error，:2734）                                                                                                      |
| `home_rotate_archive`                            | `ok`, `sessionId`, `why`（失败另带 `error`）           | 旧正身归档成败（:740 / :744 / :745 / :749）                                                                                                                              |
| `home_reset`                                     | `oldSessionId`                                         | 引擎室重置（:417）                                                                                                                                                       |
| `tool_policy`                                    | `policy`                                               | 引擎室工具白名单生效（:672 / :798）                                                                                                                                      |

#### E. 素材池、闲逛、B 站源与画像整合

| `event`                                        | 关键附加字段                                                                                                                   | 含义与排障指引                                                                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `seed_added`                                   | `id`, `kind`（added/merged）, `tag`, `source`, `category`, `confidence`（合并另带 `mergedFrom`）                               | 素材入池（`src/seeds/pool.ts`）                                                                                              |
| `seed_retired`                                 | `reason`                                                                                                                       | 淘汰：consumed 用满 / expired 过期 / cold_bench 冷板凳 / pool_cap 超池上限 / source_cap 超来源上限 / completed 主动归档      |
| `seed_duplicate`                               | `id`（匹配到的已有素材）, `reason`（exact/normalized/similar）, `similarity`                                                   | 与活跃或近 30 天归档素材重复被拦截（发出在 `src/seeds/pool.ts:330` / `:335` / `:341`）                                       |
| `seed_archive_trimmed`                         | `count`, `ids`（≤50）                                                                                                          | 归档区超 archiveCap 按最旧裁剪（`src/seeds/pool.ts:500`）                                                                    |
| `seed_restored` / `seed_deleted`               | `id`                                                                                                                           | 恢复 / 删除（`src/seeds/pool.ts:590` / `:602`）                                                                              |
| `wander` / `refill_wander`                     | `focus`, `registered`                                                                                                          | 闲逛 / 补货完成入池（事件名动态取自 `opts.label`，`src/core/orchestrator.ts:1860`；它们同时也是 `phase_done` 的 phase 取值） |
| `wander_parse_error`                           | `label`, `error`                                                                                                               | 引擎室闲逛返回的 JSON 不合法，未解析出素材（`src/core/orchestrator.ts:1857`）                                                |
| `bili_login`                                   | `outcome`                                                                                                                      | CLI 扫码登录 B 站完成（`src/cli/index.ts:920`）                                                                              |
| `consolidation`                                | `runId`, `applied`, `rejected`, `volatileExpired`, `lowActivityMarked`, `chatSeeds`, `inboxKept`（冲突另带 `inboxConflicted`） | 画像整合成功（`src/profile/consolidate.ts:368`）                                                                             |
| `consolidation_failed`                         | `runId`, `error`                                                                                                               | 整合失败，自动保持原画像不变（`src/profile/consolidate.ts:298`）                                                             |
| `inbox_locked`                                 | `runId`, `drained`, `reason`                                                                                                   | 收件箱锁冲突（`src/profile/consolidate.ts:362`）                                                                             |
| `profile_schema_fallback`                      | `source`, `reason`                                                                                                             | 画像 schema 回落（`src/profile/consolidate.ts:251`）                                                                         |
| `profile_snapshot` / `profile_snapshot_failed` | `why`, `lines` 等                                                                                                              | journal 折叠快照成功 / 失败（`src/profile/snapshot.ts:106` / `:109`）                                                        |
| `observed`                                     | `sessionId`, `added`, `cursor`                                                                                                 | 观察成功（`src/core/orchestrator.ts:1591`）                                                                                  |
| `observe_error`                                | `sessionId`, `error`                                                                                                           | 观察失败（:1597）                                                                                                            |
| `cursor_format_discarded`                      | —                                                                                                                              | 游标格式作废                                                                                                                 |
| `weekly_anchored`                              | —                                                                                                                              | 周报锚点建立（`src/core/orchestrator.ts:1622`）                                                                              |
| `weekly_skipped`                               | `reason`（agentless beat）                                                                                                     | 周报跳过（:1626）                                                                                                            |
| `weekly_generated`                             | `source`, `chars`                                                                                                              | 周报生成（:1650）                                                                                                            |
| `weekly_llm_failed` / `weekly_failed`          | `error`                                                                                                                        | 周报 LLM 失败回落模板 / 周报失败（:1640 / :1666）                                                                            |
| `weekly_pruned`                                | `keep`, `removed`                                                                                                              | 周报按 keepReports 修剪（:1654）                                                                                             |
| `weekly_anchor_corrupt`                        | `file`, `bytes`                                                                                                                | 周报锚点损坏（`src/weekly/report.ts:65`）                                                                                    |
| `pulse`                                        | —                                                                                                                              | 环境脉冲（**在 `logs/envpulse.jsonl`**，发出在 `src/env/envpulse.ts:133`）                                                   |

#### F. 账本 / 错题本归档（v2.3.0）

| `event`                                              | 关键附加字段                                                             | 含义与排障指引                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `book_done_deduped`                                  | `id`?, `archive`, `rowDate`, `rowTime`, `doneDate`, `doneTime`, `reason` | 一次完成把行从活页摘走后，归档按去重规则**没有**追加新行——这次完成在归档里少一行，只有本审计可查。<br>reason 四值：<br>• `same-stamp`：章与归档行完全相同（崩溃重放）。<br>• `retry-window`：归档后 10 分钟内重试。<br>• `retry-window-extended`：墙钟宽限——夏令时会把 10 真实分钟拉成 70 墙钟分钟，同 id+text 在 70 墙钟分钟内的真实二次完成也会被吞。<br>• `future-stamp`：归档行的章在 now 之后 24h 内，按重试处理。<br>字段：id 只在插件生成的 6 位十六进制 id 上落盘，手写 id 不进审计（隐私）；rowDate/rowTime 是被吞行在归档里自己的章，doneDate/doneTime 是本次重试的新章。<br>发出在 `src/ledger/ledger.ts:360`。 |
| `ledger_done_migrated` / `corrections_done_migrated` | `count`, `found`                                                         | 首启迁移把活页里的 done 行搬进归档：count 是**实际新增**的归档行数（崩溃重放为 0），found 是迁移前书里持有的 done 行数，供 0-of-N 对账（`src/ledger/archive.ts:153`）                                                                                                                                                                                                                                                                                                                                                                                                             |
| `book_done_migration_failed`                         | —                                                                        | 首跑迁移失败（`src/index.ts:223`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

> **已知限制**：去重窗口按设计单边覆盖。时区**向西**移动时新章落在归档章之前，由 future-stamp 兜住；时区**向东**移动时 now 领先归档章最多约 14 个墙钟小时，与「数小时后的真实重做」不可区分，因此不扩窗——同一次完成可能归档两行，周报可能多计 1（源码注释明示，测试钉住此现状）。

#### G. 屏幕视觉（v2.3.0）

| `event`                        | 关键附加字段                                                           | 含义与排障指引                                                                                                                                                                                                                                                                    |
| ------------------------------ | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `screen_vision`                | `ok`, `engine`, `summary`（失败带 `error`，auto 回退带 `nativeError`） | 桌面截屏识别结果，由 orchestrator 发出（`src/core/orchestrator.ts:2320`；vision.ts 只做引擎路由）。engine 是实际出结果的引擎（native/modlens，auto 回退成功也记 modlens）；nativeError 保留原生读失败原因（已 scrub 截图路径、截 160 字）。**绝不记画面、窗口标题原文或截图路径** |
| `vision_engine_invalid`        | `source`, `value`                                                      | 引擎取值不在 auto/native/modlens 内，被忽略并按 auto 处理；按 source:value 去重，写盘失败下拍重试（发出在 `src/index.ts:86`）                                                                                                                                                     |
| `vision_modality_probe_failed` | `provider`, `model`, `error`                                           | auto 先探宿主是否支持图片输入失败，本拍按「不支持原生」处理走 ModLens 回退（由 orchestrator 发出，`src/core/orchestrator.ts:1136`）                                                                                                                                               |

> 看图被中止不记 `screen_vision ok:false`：多数抛 BeatAbortedError（stage vision）→ beat_aborted；路由读完图之后的中止抛普通 Error（`src/screen/vision.ts:640`）→ beat_aborted 且 stage unknown、带 error（见 §3.2）。

#### H. 面板、配置与维护操作

| `event`                                                                                      | 关键附加字段                                             | 含义与排障指引                                                                                                                                          |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ui_config_set`                                                                              | `keys`                                                   | 面板改设置（`src/rpc.ts:496`）                                                                                                                          |
| `interests_edit` / `interests_edit_failed`                                                   | `action`, `detail`                                       | 兴趣编辑成功 / 失败（`src/rpc.ts:143`）                                                                                                                 |
| `${name}_tool_when_unsupported` / `${name}_tool_registered` / `${name}_tool_register_failed` | 失败带 `error`                                           | 工具注册路径三态：声明层 when 不被宿主支持 / 注册成功 / 注册失败（动态拼名，如 notepad_tool_when_unsupported，`src/index.ts:573` / `:578` / `:580`）    |
| `focus_paused` / `focus_resumed`                                                             | `via:'cli'`（paused 另带 `minutes`, `until`）            | 专注暂停 / 恢复，**只有 CLI 发**（`src/cli/index.ts:874` / `:868`）；RPC 的 focus.pause/resume（`src/rpc.ts:355` / `:370`）不写审计，面板操作不留这条痕 |
| `migrate_export`                                                                             | `files`                                                  | 口令导出（`src/rpc.ts:617`）                                                                                                                            |
| `migrate_import`                                                                             | `restored`, `backedUp`, `skipped`, `rolledBack`, `error` | 口令导入（`src/rpc.ts:642`）                                                                                                                            |
| `retention`                                                                                  | —                                                        | CLI logs cleanup（`src/cli/index.ts:488`）                                                                                                              |
| `vault_upgraded` / `vault_upgrade_failed`                                                    | `file` / `reason`                                        | KHBV1→KHBV2 升级成功 / 失败（`src/core/orchestrator.ts:1311` / `:1314`，注意后者无 d）                                                                  |

> burn 的 `BURN_EVENT` 写进 `profile_journal.jsonl`（`src/vault/burn-list.ts:200`，字段 burned/missing/settingsPreserved），**不在** heartbeat.jsonl。

---

## 6. 高频故障排查速查表（Troubleshooting）

| 现象                                               | 第一步查什么                                                                            | 根因判据与修复办法                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **心跳完全不说话**                                 | `tail -n 30 <dataDir>/logs/heartbeat.jsonl` 看最新 `silent` 或 `spoke_failed` 的 reason | • `no deliver target`：绑定全被会话闸门拒了，查 `binding_auto_removed` / `session_skipped`，去面板「会话」页重新 `bind add` 当前活跃会话<br>• `quiet hours` / `daily cap reached` / `cooldown` / `busy window` / `master actively typing`：分寸闸门拦截，属正常<br>• `focus-mode`：专注模式没关，跑 `node dist/cli/index.js focus off`<br>• `token-saver`：用户离开（锁屏/空闲），回来即恢复<br>• `no candidates`：素材池空且 idleMode 关，开 idleMode 或等闲逛入池<br>• `home rotated`：刚旋转，等下一拍 |
| **绑定莫名消失**                                   | 查 `binding_auto_removed` 的 reason                                                     | archived / subagent 首次即摘；broken / unreachable 连续 3 拍才摘。重新 `bind add` 即可，振数会清零                                                                                                                                                                                                                                                                                                                                                                                                        |
| **报账被拒（report_rejected）**                    | 看 reason                                                                               | `unknown delivery`：delivery_id 要原样抄素材包里的编号；`duplicate delivery`：同号已报过；`lock timeout` / `write failed`：跨进程锁或写盘问题，错误已抛给宿主                                                                                                                                                                                                                                                                                                                                             |
| **沉默回合既有 turn_extraction_empty 又有 silent** | 看 `concludeSilentTurn` 开关与 `conclude_silent_requested`                              | 开关关 / 本轮没真请求收尾 → 走故障线，reason 带（回合无输出）后缀；四道闸全过才是 `turn_concluded`（收尾路径不带后缀）                                                                                                                                                                                                                                                                                                                                                                                    |
| **归档有重复行 / 周报计数偏多**                    | 查 `book_done_deduped` 的 reason                                                        | retry-window / retry-window-extended / future-stamp 去重；东移时区单边窗口限制可能多归档一行、周报多计 1（已知限制，见 §5.2-F）                                                                                                                                                                                                                                                                                                                                                                           |
| **左侧会话栏冒出很多心跳后台会话**                 | 查 `home_rotate_start` 与 `home_rotate_archive`                                         | • 确认 `policy.heartbeat.archiveRotatedHome` 为 true（默认开启）<br>• `home_rotate_archive ok:false` 说明归档失败（workspaceRegistry 不可用等），旧正身没被归档                                                                                                                                                                                                                                                                                                                                           |
| **B 站观看历史一直没进素材池**                     | 面板「素材」页看 B 站状态，或查 `bilibili-source.json`                                  | • 未登录或凭据过期 → 面板点「扫码登录」或 `node dist/cli/index.js bili login`<br>• 距上次拉取未满 2 小时（`BILI_FETCH_INTERVAL_MS`）→ 正常节流<br>• 刚看的视频与池内素材重名 → 查 `seed_duplicate`；超 6 条来源上限 → `seed_retired(source_cap)`；TTL 仅 2 天                                                                                                                                                                                                                                             |
| **看图失败 / 编造屏幕内容**                        | 查 `screen_vision ok:false` 的 error / nativeError                                      | • `vision_engine_invalid`：引擎值非法，被按 auto 处理<br>• `vision_modality_probe_failed`：宿主不支持图片输入，走 modlens<br>• modlens 未装 / provider 配置错 → 修 `settings/vision.json` 或换 engine                                                                                                                                                                                                                                                                                                     |
| **子代理（Subagent）被塞了时间提示词**             | 查 `time_inject_skipped` / `time_injected`                                              | `src/statusbar/time-inject.ts` 会识别子代理会话并跳过（记 time_inject_skipped，reason subagent）；没跳过查该闸门                                                                                                                                                                                                                                                                                                                                                                                          |
| **面板打不开或显示空白 / 只读**                    | 浏览器控制台看 RPC 报错；查 `rpc_registered` / `rpc_host_gate_missing`                  | • 双 bundle key（dsh-heartbeat 与 @kanadego/dsh-heartbeat）需 DSH 0.2.1+ 的 plugins.bundle.config 插槽<br>• 只读「—」态：宿主不支持应用内改设置，改 `settings/policy.json` 后重启；晚注册 connection 的宿主切走再切回设置页（挂载重探测，只升不降）<br>• 刚改完源码需 `npm run build` 并重启 DSH                                                                                                                                                                                                          |
| **换电脑 / 重装后加密文件读不出**                  | 运行 `node dist/cli/index.js vault status`                                              | • vault.key 绑定本机（Windows DPAPI），KHBV1 不跨机<br>• 跨机迁移用 `node dist/cli/index.js migrate export [file]`（口令走 stdin 两行）再在新机 `migrate import <file>`（口令 stdin 一行）；没有 --out / --passphrase 旗标                                                                                                                                                                                                                                                                                |
| **引擎室哑火 / beat_error**                        | 查 `agent_resume_permanent` / `agent_deferred` / `beat_watchdog`                        | 上下文溢出会触发旋转；瞬态失败延迟退避 60s×2^n（上限 30min）；永久损坏自动重建                                                                                                                                                                                                                                                                                                                                                                                                                            |