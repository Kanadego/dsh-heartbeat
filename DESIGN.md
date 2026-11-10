# @kanadego/dsh-heartbeat — 开发者设计与维护手册

> **当前版本**：v2.2.1 · **宿主兼容**：DSH `0.2.0-rc.1` – `0.2.2-rc.1` · **平台**：Windows / Linux / macOS
>
> 本文档面向插件维护者与二次开发者，提供：**架构与核心功能全景**、**源码与磁盘文件映射**、**全量参数速查表**、以及 **审计日志（`logs/heartbeat.jsonl`）字典与排障指南**。

---

## 1. 核心架构与设计原则

### 1.1 双会话分离（Dual-Session Architecture）

心跳插件不在用户的日常聊天会话里跑后台任务，而是将**后台思考**与**前台陪伴**拆成两类会话：

1. **引擎室（Home Session / 正身会话）**
   - 插件自己创建并持有的后台专属会话，绑定内置 `kohaku-heartbeat` preset，收敛危险工具，隐藏在常规会话列表之外（通过工作区打标与归档过滤）。
   - 负责执行**闲逛搜索（Wander）**、**屏幕多模态读图（Screen Vision）**、**用户画像整合（Profile Consolidation）**、**每周回顾生成（Weekly Report）**。
   - **自动旋转（Home Rotation）**：当引擎室事件数达到 `HOME_ROTATE_EVENT_COUNT = 3000`、遇到 `CONTEXT_WINDOW_EXCEEDED`、或被用户在 UI 中手动归档时，自动丢弃旧会话并拉起新引擎室（状态全部落盘在 `dataDir`，旋转零数据丢失）。
2. **陪伴会话（Companion Sessions / 绑定会话）**
   - 用户日常聊天的会话，在 Web 面板「会话」页或通过 CLI 绑定：
     - **`observe: true`（观察源）**：心跳按游标增量读取用户发言（过滤插件自身注入的文本），送入收件箱供画像提炼。
     - **`deliver: true`（投递目标）**：当门禁放行且有话可说时，把组好的「心跳素材包」以 `user/message` 形式投递进该会话，由陪伴 Agent 决定说不说、说什么，并调用 `seed_report` 报账。

### 1.2 零闲置 Token 原则

- **门禁前置**：专注模式、安静时段、每日上限、冷却间隔、无活动省流（Token Saver）全部在纯 TypeScript 层完成判定。
- **不唤醒则零消耗**：只要本跳不需要闲逛、不需要整合画像、也没到投递时刻，连引擎室与陪伴会话的 LLM 都不会调用，整跳耗时 `< 10ms`、消耗 `0 token`。

---

## 2. 源码目录与数据落盘索引

### 2.1 源码结构（`src/`）

| 目录 / 文件 | 核心职责 |
|---|---|
| `src/index.ts` | 插件主入口：Schema 声明（`dataDir` / `installPreset`）、工作区迁移、注册 4 个 Agent 工具、挂载时间感知与状态栏中间件、懒加载 `settings` / `webui` RPC |
| `src/rpc.ts` | Web 面板与宿主的 JSON-RPC 桥（同时向 `settings` 与 `webui` 注册 `dsh-heartbeat` 通道），提供 25 个动作端点 |
| `src/client.js` | 浏览器端原生 7-Tab 面板（状态 / 会话 / 素材 / 兴趣 / 画像 / 周报 / 设置），同时挂在 `dsh-heartbeat` 与 `@kanadego/dsh-heartbeat` 两个 bundle key 下 |
| `src/core/orchestrator.ts` | 心跳主循环 `beat()`、引擎室生命周期与旋转、单飞锁与 45 分钟 Watchdog、陪伴会话投递与报账闭环 |
| `src/core/focus-store.ts` | 专注模式状态读写（内存与 `data/focus.json` 双写同步，支持 CLI 跨进程暂停） |
| `src/core/archived-sessions.ts` | 解析 DSH `storages/workspace.json` 的归档会话集合，供投递目标跳过与引擎室自动重建使用 |
| `src/core/bindings.ts` | 会话绑定表（`home` / `observe` / `deliver`）读写与目标筛选 |
| `src/core/path-guard.ts` | 路径沙箱守卫：所有读写强制校验在 `dataDir` 内，拦截 `..` 越界与外链 symlink |
| `src/core/atomic-fs.ts` | 原子写文件（先写 `data/tmp/` 临时文件再 `rename`）與跨进程目录锁（`withFileLock`） |
| `src/config/schema.ts` | `Policy` 类型定义、运行时范围校验 `assertPolicy()`、用户覆盖层 `deepMerge()` |
| `src/config/quiet-hours.ts` | 安静时段（`gate.quietHours`）与闲逛窗口（`browse.windows`）校验与用户层持久化 |
| `src/gate/gate.ts` | 硬门禁状态机（安静时段 / 每日上限 / 冷却时间 / 同会话自上次投递后是否有用户回复） |
| `src/seeds/pool.ts` | 话题素材池（增删、三层去重、评分排序、按来源配额淘汰、冷板凳与归档上限 GC） |
| `src/browse/browse.ts` | 自主闲逛调度：读取 `config/interests.yaml` + 用户覆盖层，抽签话题并拼装引擎室搜索提示词 |
| `src/sources/bilibili.ts` | B 站观看历史被动源：每 2 小时增量拉取已登录账号的观看记录并转为 `source: "bilibili"` 素材 |
| `src/env/envpulse.ts` | 桌面感知与全屏截图：采集前台窗口标题与截屏，哈希去重后由引擎室提炼五元组 |
| `src/profile/store.ts` & `consolidate.ts` | 10 分区用户画像存储（KHBV2 加密）、预算裁剪、引擎室增量整合与 `snapshots/` 快照回滚 |
| `src/notepad/` · `src/ledger/` · `src/excerpt/` | 陪伴 Agent 专属工具后端：心事匣（单格便签）、待办账本、摘抄本 |
| `src/weekly/report.ts` | 每周回顾生成、周锚点记录与历史周报保留裁剪 |
| `src/statusbar/` | `time-inject.ts`（用户轮次注入当前时间与距上次发言间隔，跳过子代理与非用户源）+ `track.ts`（记录最近活跃会话） |
| `src/vault/` | `vault.ts`（AES-256-GCM `KHBV2` 容器加解密 + 平台密钥管理）、`migrate.ts`（PBKDF2 密码流式导出/导入）、`burn-list.ts`（一键焚毁） |
| `src/cli/index.ts` & `bili-login.ts` | 运维 CLI（17 个一级子命令）与 B 站终端扫码登录实现 |

### 2.2 数据目录（`dataDir`）文件清单

默认路径：`~/.dsh/heartbeat-data/`（可在插件设置 `dataDir` 中自定义迁移）。

| 相对路径 | 加密层级 | 读写模块 | 用途说明 |
|---|---|---|---|
| `vault.key` | 平台保护 | `vault/vault.ts` | 32 字节主密钥：Windows 下为 DPAPI 密文（`KHBK1`），Linux/macOS 下为 `0600` 权限裸密钥 |
| `data/profile.json` | **KHBV2 加密** | `profile/store.ts` | 10 分区长期用户画像库 |
| `data/notepad.json` | **KHBV2 加密** | `notepad/notepad.ts` | 心事匣（留给下一跳的一句话引子與年龄计数） |
| `data/bilibili-session.json` | **KHBV2 加密** | `cli/bili-login.ts` | 扫码登录保存的 B 站 `SESSDATA` 凭据 |
| `data/inbox/YYYY-MM-DD.jsonl` | **逐行 KHBV2** | `profile/inbox.ts` | 待整合的聊天观察、屏幕五元组与闲逛摘录队列 |
| `data/weekly/YYYY-Www.md` | **KHBV2 加密** | `weekly/report.ts` | 历次生成的周报正文 |
| `data/seeds.json` | 明文 JSON | `seeds/pool.ts` | 活跃素材池（`active`）与已归档素材（`archived`） |
| `data/gate.json` | 明文 JSON | `gate/gate.ts` | 门禁状态（今日已投递次数、上次投递时间戳、正身 `agentSessionId`） |
| `data/focus.json` | 明文 JSON | `core/focus-store.ts` | 专注模式到期时间戳 `until`（未开启时文件不存在） |
| `data/cursors.json` | 明文 JSON | `core/orchestrator.ts` | 各观察会话已消费到的事件 `seq` 游标 |
| `data/bilibili-source.json` | 明文 JSON | `sources/bilibili.ts` | B 站历史源上次拉取时间 `lastPollAt` 与高水位 `lastViewAt` |
| `data/browse-state.json` | 明文 JSON | `browse/browse.ts` | 各兴趣类目上次闲逛时间与冷却状态 |
| `data/env-pulse.jsonl` | 明文 JSONL | `env/envpulse.ts` | 最近 N 小时的桌面窗口感知脉冲记录 |
| `data/heartbeat-status.json` | 明文 JSON | `core/orchestrator.ts` | 最近一跳摘要状态（供面板「状态」页读取） |
| `data/ledger.md` | 明文 Markdown | `ledger/ledger.ts` | 共享待办与承诺账本 |
| `data/excerpt.md` | 明文 Markdown | `excerpt/excerpt.ts` | 陪伴 Agent 的句子摘抄本 |
| `data/settings/bindings.json` | 明文 JSON | `core/bindings.ts` | 会话绑定表（`home` + `sessions[]`） |
| `data/settings/ui-config.json` | 明文 JSON | `config/ui-config.ts` | 面板开关项（心跳总开关、屏幕感知、空闲模式、省流模式、心跳间隔等） |
| `data/settings/policy.json` | 明文 JSON | `config/load.ts` | 用户策略覆盖层（深度合并到出厂 `config/policy.json` 之上） |
| `data/settings/interests.json` | 明文 JSON | `browse/interests-store.ts` | 用户在面板新增/删除的闲逛兴趣词条 |
| `data/snapshots/*.json` | **KHBV2 加密** | `profile/snapshot.ts` | 每次画像整合前自动保存的回滚快照（最多保留 10 份） |
| `logs/heartbeat.jsonl` | 明文 JSONL | `core/audit-log.ts` | 核心审计与错误日志（仅记事件名、原因码与耗时，绝不落盘聊天正文或 Cookie） |

---

## 3. 单跳执行流水线与核心机制

### 3.1 `beat(deps, trigger)` 完整生命周期

每次定时器到期（`interval`）、启动首跳（`startup`，延迟 15s）、或面板唤醒（`wake`）时，`src/core/orchestrator.ts` 按以下顺序执行：

```text
[1. 专注模式检查] ──(开启中)──► 记 silent(focus-mode)，更新状态卡，0 开销直接返回
       │
[2. 单飞锁 & 45min Watchdog] ──► 若上一跳未结束则直接跳过；挂载 AbortController
       │
[3. 心事匣开格] ──► 推进 beat 序号（startup 跳不推进），清理上一跳已投递但未续写的旧便签
       │
[4. 阶段 A：桌面感知 & 聊天观察]
       ├─► 若开启 screenVision：截屏 + 窗口标题 → 哈希未变则跳过；变化则调引擎室识图入 inbox
       └─► 遍历 observe 会话：按 cursors.json 增量拉取用户发言 → 写入 inbox/YYYY-MM-DD.jsonl
       │
[5. 每周回顾检查] ──► 若开启 weekly 且跨过周日 20:00 锚点 → 调引擎室汇总本周素材/账本/画像生成周报
       │
[6. 阶段 B：被动数据源 & 自主闲逛]
       ├─► B站历史源：若已登录且距上次拉取 ≥ 2h → 拉取新观看记录入素材池（无需引擎室）
       ├─► 自主闲逛（Wander）：若在 browse.windows 时间窗内且距上次闲逛 ≥ minIntervalHours → 调引擎室搜索入池
       └─► 画像整合（Consolidation）：若 inbox 积压 ≥ inboxBacklog 或距上次整合 ≥ minIntervalHours → 调引擎室更新画像
       │
[7. 阶段 C：无活动省流短路（Token Saver）]
       └─► 若开启 tokenSaver 且自上次投递后所有观察会话均无用户新消息、也没有新采集信号 → 记 silent(no-activity-since-last-delivery) 返回
       │
[8. 阶段 D：硬门禁（Gate）]
       └─► 依次检查：心跳总开关 → 安静时段（quietHours）→ 每日上限（maxDailySend）→ 冷却时间（cooldownMinutes）
           （不通过则记 silent(<reason>) 返回）
       │
[9. 阶段 E：表达投递与报账闭环]
       ├─► 过滤已归档（archived）的投递会话；检查目标会话自上次投递后是否有用户回复（无则记 silent(awaiting-user-reply)）
       ├─► 组装投递包（候选素材 Top 3 + 账本未完项 + 心事匣引子 + 空闲模式下的画像话题）
       ├─► 等待目标会话空闲（最多 10 分钟 EXPRESSION_IDLE_WAIT_MS），注入投递包
       └─► 读取陪伴 Agent 调 seed_report 的回执 → 标记已用素材、记录话题偏好、更新 gate.json 计数
```

### 3.2 关键子系统约定

- **素材池三层去重与配额（`src/seeds/pool.ts`）**
  - 入池时依次比对近 30 天活跃+归档池：① URL 完全一致（`exact`）→ ② 标题归一化一致（`normalized`）→ ③ 标题字符二元组 Jaccard 相似度 `> 0.85`（`similar`）。命中任一则拒绝入池并记 `seed_duplicate`。
  - **B 站源专属配额**：池内最多保留 **6 条**活跃 `bilibili` 素材（超出按最旧淘汰，记 `seed_retired(source_cap)`），单次投递包最多选入 **2 条**，有效期固定 **2 天**。
- **四个陪伴 Agent 工具（仅注入陪伴会话，引擎室禁用）**
  - `notepad`（心事匣）：`write` / `read` / `clear`，只有一格，写新盖旧。
  - `ledger`（待办账本）：`add` / `list` / `done`，操作 `data/ledger.md`。
  - `excerpt`（摘抄本）：`add` / `list` / `remove`，操作 `data/excerpt.md`。
  - `seed_report`（素材报账）：每次收到投递包必须调用一次（`spoken: "material" | "heartfelt" | "silent"`），用于闭环统计素材命中率与话题偏好。

---

## 4. 参数与配置去哪里查

插件参数分为三层：**宿主插件配置**、**策略配置（Policy）**、以及 **源码内部常量**。

### 4.1 第一层：宿主插件配置（`cordis.patch.yml` / 插件设置页）

定义在 `src/index.ts:36-46`：

| 参数名 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `dataDir` | `string` | `""`（即 `~/.dsh/heartbeat-data`） | 自定义数据目录绝对路径。修改后下次启动会自动将旧目录全部文件迁移至新目录（记 `data_dir_relocated`） |
| `installPreset` | `boolean` | `true` | 启动时是否自动在 `~/.dsh/agent-presets/kohaku-heartbeat/` 安装内置人设模板（已有同名目录时绝不覆盖） |

### 4.2 第二层：运行时开关（`data/settings/ui-config.json`，面板「设置」页即时生效）

定义在 `src/config/ui-config.ts`，可通过面板直接切换或调 RPC `config.set` 修改：

| 字段名 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | `boolean` | `true` | 心跳表达总开关（关闭后仍可观察和闲逛，但门禁在 `disabled` 处拦截投递） |
| `intervalMinutes` | `number` | `15` | 心跳基础间隔（分钟，范围 `1–1440`），修改后立即重设定时器 |
| `screenVision` | `boolean` | `false` | 是否启用阶段 A 的桌面截图与窗口标题感知（仅 Windows 生效） |
| `idleMode` | `boolean` | `true` | 闲着没事模式：素材池为空时，是否允许拿画像兴趣条目当话题搭话 |
| `tokenSaver` | `boolean` | `true` | 无活动省流模式：用户一直没说话且无新采集信号时，跳过后续表达评估 |

### 4.3 第三层：策略参数（`config/policy.json` 与 `data/settings/policy.json`）

- **去哪里查定义与校验**：`src/config/schema.ts`（`Policy` 接口与 `assertPolicy` 函数）
- **去哪里看默认出厂值**：仓库根目录 `config/policy.json`（只读出厂层）
- **怎么改**：在 `<dataDir>/data/settings/policy.json` 写入需要覆盖的字段（支持只写局部子字段，启动或每跳加载时通过 `deepMerge` 合并）。其中 `gate.quietHours` 和 `browse.windows` 可直接在面板「设置 / 兴趣」页修改。

| 路径 | 默认值 | 合法范围 | 作用说明 |
|---|---|---|---|
| `heartbeat.intervalMin` | `15` | `[1, 1440]` | 出厂默认心跳间隔（被 `ui-config.json` 的 `intervalMinutes` 优先覆盖） |
| `heartbeat.intervalJitterPct` | `20` | `[0, 50]` | 节律抖动百分比：每跳实际等待 `interval × (1 ± p%)` 均匀随机，防掐表机械感；设为 `0` 关闭抖动 |
| `heartbeat.idleMode` | `true` | `boolean` | 出厂默认空闲模式开关 |
| `heartbeat.archiveRotatedHome` | `true` | `boolean` | 引擎室旋转淘汰旧正身会话时，是否自动在宿主 `workspace.json` 中将其标记为归档 |
| `gate.maxDailySend` | `8` | `>= 0` | 每日最多主动搭话次数（本地自然日 00:00 重置） |
| `gate.cooldownMinutes` | `30` | `>= 0` | 两次主动搭话之间的最短冷却分钟数 |
| `gate.quietHours` | `{start:"23:30", end:"08:00"}` | `HH:MM` | 安静时段（支持跨午夜，时段内门禁返回 `quiet-hours`） |
| `browse.windows` | `09:00-11:30`, `14:00-17:30`, `20:00-22:30` | 非空 `HH:MM` 数组 | 允许触发自主闲逛的本地时间窗口 |
| `browse.minIntervalHours` | `2.5` | `> 0` | 两次自主闲逛之间的最短间隔小时数 |
| `browse.maxSeedsPerVisit` | `4` | `>= 1` | 单次闲逛最多允许入池的素材条数 |
| `seeds.maxActive` | `30` | `>= 1` | 活跃素材池容量上限 |
| `seeds.ttlDays` | `{news:2, fandom:14, scene:1, promise:30}` | `number` | 各标签素材的存活天数 |
| `seeds.coldBenchDays` | `5` | `number` | 素材连续多少天未被选中则移入冷板凳归档 |
| `seeds.archiveCap` | `100` | `>= 1` | 归档区最多保留多少条历史素材（超出按最旧裁剪） |
| `seeds.retireAfterUsed` | `2` | `>= 1` | 同一条素材被陪伴 Agent 实际使用多少次后自动归档 |
| `seeds.scoreWeights` | `{freshness:0.4, unused:0.35, confidence:0.25}` | 权重对象 | 投递前候选素材打分公式权重 |
| `profile.consolidation.minIntervalHours` | `6` | `number` | 画像整合的最短时间间隔（小时） |
| `profile.consolidation.inboxBacklog` | `20` | `number` | 收件箱积压多少条观测记录时提前触发画像整合 |
| `profile.partitionCap` | `10` | `>= 1` | 每个画像分区最多保留多少条记录 |
| `profile.maxOpsPerRun` | `5` | `>= 1` | 单次画像整合最多允许执行的增删改操作数 |
| `profile.confidenceCap` | `{chat:0.95, screen:0.5, browse:0.6}` | `0–1` | 不同来源证据写入画像时的置信度天花板 |
| `profile.volatileDays` | `7` | `>= 1` | `volatile`（短期状态）条目的过期天数 |
| `profile.stableLowActivityDays` | `60` | `>= 1` | `stable` 条目多久未命中后打上 `lowActivity` 标记 |
| `profile.psyEnabled` | `true` | `boolean` | 是否启用 `psy`（心理与情感倾向）分区 |
| `observe.maxChars` | `500` | `[20, 2000]` | 单条用户发言摘录进 inbox 的最大字符数 |
| `observe.perBeat` | `20` | `[1, 100]` | 单跳最多从单个观察会话消费多少条新用户发言 |
| `weekly.enabled` | `true` | `boolean` | 是否在每周日 20:00 后自动生成周报 |
| `weekly.keepReports` | `12` | `[1, 52]` | 最多保留最近多少周的周报文件 |
| `retention.envPulseHours` | `24` | `number` | `data/env-pulse.jsonl` 保留最近多少小时的窗口记录 |
| `retention.decisionLogDays` | `30` | `number` | `logs/heartbeat.jsonl` 保留最近多少天的审计日志 |
| `sources.bilibili.enabled` | `true`（有凭据时） | `boolean` | 设为 `false` 可在不删凭据的情况下硬关闭 B 站观看历史源 |
| `sources.bilibili.cookieFile` | `undefined` | `string` | 可选外部 Cookie 文件路径（未扫码登录时的回退凭据源） |

### 4.4 第四层：源码内部硬编码常量（调优时查这里）

| 常量名 | 当前值 | 所在文件与行号 | 说明 |
|---|---|---|---|
| `HOME_ROTATE_EVENT_COUNT` | `3000` | `src/core/orchestrator.ts:242` | 引擎室主动旋转的事件数阈值 |
| `TURN_TIMEOUT_MS` | `180_000` (3 min) | `src/core/orchestrator.ts:254` | 引擎室单轮模型调用超时时间 |
| `IDLE_WAIT_TIMEOUT_MS` | `240_000` (4 min) | `src/core/orchestrator.ts:255` | 引擎室等待空闲的超时时间 |
| `EXPRESSION_IDLE_WAIT_MS` | `600_000` (10 min) | `src/core/orchestrator.ts:262` | 向用户陪伴会话投递前等待会话空闲的最大时间 |
| `BEAT_WATCHDOG_MS` | `2_700_000` (45 min) | `src/core/orchestrator.ts:299` | 单跳卡死强制 Abort 并释放单飞锁的看门狗阈值 |
| `BILI_MIN_INTERVAL_MS` | `7_200_000` (2 h) | `src/sources/bilibili.ts:34` | B 站观看历史两次拉取的最短间隔 |
| `BILI_ACTIVE_CAP` / `DELIVERY_CAP` | `6` / `2` | `src/seeds/pool.ts:51-55` | B 站素材在活跃池中的最大条数 / 单次投递包最大条数 |
| `SIMILARITY_THRESHOLD` | `0.85` | `src/seeds/pool.ts:61` | 素材标题字符二元组 Jaccard 近似去重阈值 |
| `BUDGET_CHARS` (Profile) | `5000` | `src/profile/store.ts:36` | 用户画像总字符预算上限 |

---

## 5. 错误日志怎么看、怎么查

### 5.1 日志位置与查看方式

所有运行轨迹、门禁拦截原因、模型超时与异常全部以 **JSON Lines** 格式追加在：

```text
<dataDir>/logs/heartbeat.jsonl
```

**常用查询命令**：

```bash
# 1. 用内置 CLI 看最近 30 条日志（推荐）
node dist/cli/index.js logs --tail 30

# 2. 只看错误与失败事件
grep -E '"event":"([^"]*_failed|[^"]*_error|beat_watchdog|beat_aborted)"' ~/.dsh/heartbeat-data/logs/heartbeat.jsonl | tail -n 20

# 3. 看为什么今天一直没搭话（查所有 silent 与 spoke 事件）
grep -E '"event":"(silent|spoke|spoke_failed|spoke_deferred)"' ~/.dsh/heartbeat-data/logs/heartbeat.jsonl | tail -n 20

# 4. 查看当前工作区路径、门禁状态与策略摘要
node dist/cli/index.js status
```

### 5.2 审计日志 `event` 全量速查字典

每行 JSON 至少包含 `{"ts":"ISO8601","event":"..."}`。按生命周期分类如下：

#### A. 启动、调度与单跳控制
| `event` | 关键附加字段 | 含义与触发位置 |
|---|---|---|
| `plugin_init` | `dataDir`, `customDataDir` | 插件启动完成工作区初始化（`src/index.ts:327`） |
| `data_dir_relocated` / `_failed` | `from`, `to`, `moved` / `reason` | 修改 `dataDir` 后自动迁移旧目录数据成功或失败（`src/index.ts:337`） |
| `orchestrator_started` / `_disposed` | `intervalMin` | 调度器启动或随宿主停机卸载（`src/core/orchestrator.ts:2381`） |
| `interval_scheduled` | `baseMin`, `jitterPct`, `delayMs`, `nextAt` | 每次算好下一跳抖动延迟后记录下次触发时刻（`orchestrator.ts:2400`） |
| `beat_start` | `trigger` (`startup`/`interval`/`wake`/`retry`) | 单跳正式开始（通过专注模式与单飞锁之后，`orchestrator.ts:2225`） |
| `phase_done` | `phase` (`A`/`B`/`consolidate`/`E`), `ms` | 某阶段正常跑完及耗时（`orchestrator.ts:2303`） |
| `beat_watchdog` | `reason` | **异常**：单跳运行超过 45 分钟未结束，Watchdog 触发 `AbortController` 取消任务并释放锁（`orchestrator.ts:2219`） |
| `beat_aborted` | `reason` | 被 Watchdog 或宿主关闭信号中途取消的跳（`orchestrator.ts:2334`） |
| `beat_error` | `error` | **异常**：未捕获的单跳顶层错误（`orchestrator.ts:2341`） |

#### B. 为什么没说话？（`silent` 与门禁 / 专注 / 省流）
当发现心跳没有主动搭话时，查 `"event":"silent"` 的 `reason` 字段即可定位：

| `silent` 的 `reason` 值 | 含义 |
|---|---|
| `focus-mode` | 正处于专注模式暂停期内（附带 `until` 到期时间） |
| `disabled` | 面板「设置」里关闭了「启用心跳主循环」总开关 |
| `quiet-hours` | 当前本地时间在安静时段（`gate.quietHours`）内 |
| `daily-limit` | 今日主动搭话次数已达 `gate.maxDailySend` 上限 |
| `cooldown` | 距上次主动搭话未满 `gate.cooldownMinutes` 分钟 |
| `no-activity-since-last-delivery` | 开启了无活动省流（`tokenSaver`），且自上次投递后用户无新发言、后台也无新采集信号 |
| `awaiting-user-reply` | 上次投递到该陪伴会话后，用户还没有回过话（防单方面刷屏） |
| `nothing-to-say` | 候选素材池为空，且未开启 `idleMode`（或画像也为空） |
| `model-declined` | 投递包已送达陪伴会话，陪伴 Agent 调 `seed_report(spoken:"silent")` 主动选择本跳保持安静 |

#### C. 投递与陪伴会话异常（`deliver_*` / `spoke_*`）
| `event` | 关键附加字段 | 含义与排障指引 |
|---|---|---|
| `delivered` / `spoke` | `sessionId`, `deliveryId`, `spoken`, `seedIds` | 投递包已送达陪伴会话，且陪伴 Agent 完成表达与报账（`orchestrator.ts:1835`） |
| `deliver_target_skipped` | `sessionId`, `reason: "archived"` | 该绑定会话已在 DSH 中被归档，自动跳过（v2.2.0+，`orchestrator.ts:1656`） |
| `spoke_deferred` | `sessionId`, `reason` | 目标陪伴会话正忙（如用户在跑超长回合），等待 10 分钟仍未空闲，本跳延后到下一跳重试 |
| `spoke_failed` | `reason` | **投递失败**，常见 `reason`：<br>• `no deliver-bound session`：未绑定任何投递会话<br>• `all deliver targets archived`：绑定的投递会话全部被归档了<br>• `deliver session could not be resumed`：目标会话文件损坏或不存在 |
| `report_missing` | `sessionId`, `deliveryId` | 陪伴 Agent 收到了投递包并回复了文字，但**漏调了 `seed_report` 工具** |

#### D. 引擎室（Home Session）生命周期与旋转
| `event` | 关键附加字段 | 含义与排障指引 |
|---|---|---|
| `agent_reuse_live` / `agent_resume_ok` / `agent_create_ok` | `sessionId` | 引擎室复用内存实例 / 从磁盘恢复 / 初次创建成功 |
| `agent_resume_failed` / `agent_resume_permanent` | `sessionId`, `error` | 引擎室恢复失败（若匹配 `SessionFormatUnsupportedError` 则直接判定永久损坏并重建） |
| `home_rotate_start` / `home_rotate_done` | `oldSessionId`, `newSessionId`, `reason` | 引擎室触发自动旋转（`reason`: `event-count>=3000` / `context-overflow` / `archived-in-workspace`） |
| `home_rotate_failed` | `reason`, `error` | **异常**：引擎室旋转创建新会话失败，检查默认模型路由是否可用 |
| `beat_agentless` | `reason` | **异常**：宿主无法创建或恢复引擎室 Agent，本跳降级为纯本地运行 |

#### E. 素材池、闲逛、B 站源与画像整合
| `event` | 关键附加字段 | 含义与排障指引 |
|---|---|---|
| `seed_added` / `seed_retired` | `id`, `source`, `tag` / `reason` | 素材入池 / 淘汰（`reason`: `ttl` 过期、`used_cap` 用满、`cold_bench` 冷板凳、`active_cap` 超池上限、`source_cap` 超 B 站 6 条上限） |
| `seed_duplicate` | `reason` (`exact`/`normalized`/`similar`), `matchedId` | 采集到的素材因与近 30 天内已有素材重复被拦截 |
| `wander_parse_error` | `reason`, `rawHead` | 引擎室闲逛返回的 JSON 格式不合法，未能解析出素材 |
| `bili_login` | `outcome` (`0`=成功) | CLI 扫码登录 B 站完成 |
| `consolidation` / `consolidation_failed` | `ops`, ` inboxConsumed` / `reason` | 画像整合成功或失败（失败时自动保持原画像不变） |
| `weekly_generated` / `weekly_llm_failed` | `week`, `file` / `reason` | 周报生成成功，或引擎室 LLM 调用失败回退为确定性统计模板 |

---

## 6. 高频故障排查速查表（Troubleshooting）

| 现象 | 第一步查什么 | 根因判据与修复办法 |
|---|---|---|
| **心跳完全不说话** | `node dist/cli/index.js logs --tail 30` 看最新 `silent` 或 `spoke_failed` | • `reason:"no deliver-bound session"` → 去面板「会话」页勾选至少一个「允许投递」<br>• `reason:"all deliver targets archived"` → 之前绑定的会话被归档了，换绑当前活跃会话<br>• `reason:"awaiting-user-reply"` → 上次心跳说话后你还没在那个会话里回话<br>• `reason:"focus-mode"` → 专注模式没关，跑 `node dist/cli/index.js focus off` |
| **左侧会话栏冒出很多心跳后台会话** | 查 `logs/heartbeat.jsonl` 中的 `home_rotate_start` 与 `home_rotate_archive` | • 确认 `policy.heartbeat.archiveRotatedHome` 为 `true`（默认开启）<br>• 若旧正身会话被手动归档，v2.2.1 起会自动检测 `archived-in-workspace` 并静默切换新正身 |
| **B 站观看历史一直没进素材池** | 在面板「素材」页看 B 站状态，或查 `data/bilibili-source.json` | • 未登录或凭据过期 → 在面板点「扫码登录」或运行 `node dist/cli/index.js bili login`<br>• 距上次拉取未满 2 小时（`BILI_MIN_INTERVAL_MS = 2h`）→ 属正常节流<br>• 刚看的视频与 30 天内素材重名 → 查日志是否有 `seed_duplicate` |
| **子代理（Subagent）被塞了时间提示词** | 查日志 `time_inject_skipped` / `time_injected` | • v2.2.0 起 `src/statusbar/time-inject.ts` 会自动识别子代理会话与非用户触发轮次并跳过（记 `time_inject_skipped`） |
| **面板打不开或显示空白** | 浏览器控制台看是否有 RPC 报错；查日志 `rpc_registered` | • 插件使用双 bundle key（`dsh-heartbeat` 与 `@kanadego/dsh-heartbeat`）挂载面板；若刚改完源码，需先执行 `npm run build` 并重启 DSH |
| **换电脑 / 重装后加密文件读不出** | 运行 `node dist/cli/index.js vault status` | • `vault.key` 绑定本机（Windows DPAPI）。跨机迁移必须在旧机用面板「设置 → 导出加密备份」或 `heartbeat migrate export --out backup.hbvault --passphrase <口令>`，再在新机导入 |
