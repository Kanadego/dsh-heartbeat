# dsh-heartbeat · 设计与维护手册

> **这份手册写给维护这套代码的人。** 它回答四件事：
>
> · **它是怎么跑起来的** —— §2 运行框架
> · **每块代码在哪、在干什么** —— §4 模块实现
> · **想调什么该改哪儿** —— §6 参数位置速查
> · **出问题怎么查** —— §7 诊断手册
>
> 有一节要优先看：**§3 宿主集成契约**。这个插件跑在 DSH 宿主进程里，与宿主之间那层约定没有类型系统兜底，只能靠文档记着——**升级 DSH 之前，把 §3 从头到尾过一遍。**
>
> 面向用户的说明（装什么、能干什么、每个参数什么意思）在 `README.md`；本文只讲实现与维护，不重复它的内容。

---

## 1. 快速事实卡

| 项 | 值 |
|---|---|
| 形态 | DSH cordis 插件 = 宿主进程内服务（定时器 / 编排 / 探针）+ web 设置卡片 + 独立 CLI |
| 宿主 | DSH 0.2.0-rc.2 实测运行；0.1.7-rc.2 / 0.2.0-rc.1 / 0.2.0-rc.2 已验收；0.1.5-rc.2 兼容。≤ 0.1.1-rc.2 请用 v1.0（v1.1 起依赖 `snapshotEvents()` 与 agent 预设机制） |
| 适配声明 | peer 依赖 `@deepseek-ai/dsh-llm`：`^0.1.1-rc.2 \|\| ^0.1.5-rc.2 \|\| ^0.1.7-rc.1 \|\| ^0.2.0-rc.1`。`@deepseek-ai/dsh-settings` 是**运行时真依赖**，必须留在 `dependencies`（原因见 §3.1） |
| 平台 | **Windows 专属**：PowerShell 探针、DPAPI 加解密、WinRT toast；`package.json` 声明 `os: ["win32"]` |
| 技术栈 | TypeScript（strict、`noUncheckedIndexedAccess`）、ESM、tsup 构建、Node ≥ 22.19 |
| 产物 | `dist/index.js`（插件入口）、`dist/cli/index.js`（CLI）、`dist/index.d.ts`（类型）、`client.js`（前端卡片，手写、不参与构建） |
| 测试 | node:test + tsx，**282 个**（约 90 秒）；CI 在 windows-latest 上跑 `npm ci` → `typecheck` → `test` |
| 运行数据 | `dataDir`，默认 `<包根>/data`；可在 profile 的插件配置里按插件 id 覆盖 |
| 心跳节律 | 出厂 20 分钟一拍（设置页 / CLI 可调）；沉默拍**零模型调用** |
| 主循环 | `src/core/orchestrator.ts` 的 `beat()` |
| 代码规模 | 50 个 `.ts` 文件；核心是 `orchestrator.ts`（约 1730 行）与 `rpc.ts` |

---

## 2. 运行框架

### 2.1 一次心跳的生命周期

定时器每 `heartbeat.intervalMin` 分钟触发一次 `beat()`；宿主启动后 15 秒先来第一拍。`beat()` 里的顺序是固定的：

```
取引擎室 agent（复用 / resume / create 三态，失败走退避重试）
  ↓
家轮换检查 —— 上下文溢出被标记，或引擎室事件数 ≥ 3000 → 换个新会话当引擎室
  ↓
省 token 闸 —— 人离开 ≥ 30 分钟或锁屏 → 整拍挂起（连维护相都不跑）
  ↓
① 维护 maintenancePhase          超时 10 min
     素材池 gc · 日志按龄裁剪 · 判断画像该不该合并 · 收件箱健康检查
①′ 周报 weeklyPhase（到期才跑，走同一套模型轮次）
② 采集 collectPhase              超时 5 min
     截图 + 前台窗口（加密落盘）→ 视觉识别 → 空闲秒数与窗口类别 → 记一笔作息
     末尾顺带观察绑定会话（observeBoundSessions）
②′ 闲逛 wanderPhase              超时 15 min
     开窗 + 间隔 + 焦点冷却都过了，才调 web_search 攒素材；结果由代码入池
②″ 补货闲逛 refillWanderPhase     超时 15 min（素材告急才跑，可与正常闲逛同拍叠加）
  ↓
③ 表达 expressionPhases
     闸门（零模型）→ 拼处境摘要 + 挑素材 → 引擎室反刍 → 素材包投递给目标会话 → 归账
  ↓
收尾：写状态文件、落审计、清看门狗
```

几个理解要点：

- **沉默拍不花钱。** 闸门（静默时段 / 忙时窗口 / 在场联动 / 每日上限 / 冷却）全部在**调模型之前**判完，判定结果只落一行 `silent` 审计，带 reason。
- **表达轮的决策权在目标会话的 agent**，不在引擎室。引擎室只负责"备料"——把素材各压成一句话，输出机器 JSON；真正说不说、说哪条、要不要附一句真心话，由收到素材包的那个会话 agent 决定。它说出口的话，落在用户读的那个会话里。
- **素材由代码入池。** 闲逛搜到什么、几时入池、什么时候退休，全由 `seeds/pool.ts` 按策略算，模型不碰登记。
- **agent 拿不到时数据照样跑。** 引擎室获取失败的那一拍走"无 agent 分支"：维护与采集照跑，只是不表达，并留一条 `beat_agentless`，同时排一个退避重试。

### 2.2 单飞、超时与看门狗

| 机制 | 值 | 作用 |
|---|---|---|
| 拍级单飞 | 模块状态 `beating` | 同一时刻只允许一拍在跑，重入直接返回 |
| 合并单飞 | `consolidating` 锁 | 画像合并同一时刻只跑一次 |
| 相超时 | 维护 10 min / 采集 5 min / 闲逛 15 min | 单相卡死不拖垮整拍（`withTimeout` 包装） |
| 拍看门狗 | `BEAT_WATCHDOG_MS = 45 min` | 超时只把 `beating` 放回并记 `beat_watchdog`，**不补拍** |
| 单次模型轮次 | `TURN_TIMEOUT_MS = 180 s` | `agentTurn` 的兜底超时 |
| 等会话空闲 | `IDLE_WAIT_TIMEOUT_MS = 240 s` | `whenIdle()` 的上限，超时按轮次各自降级 |
| 获取退避 | 60 s × 2ⁿ，上限 30 min | 引擎室拿不到时的重试阶梯，成功即复位 |

### 2.3 三个进程

1. **宿主进程内的插件** —— 定时器、编排、探针 spawn、模型轮次，全在这里。
2. **PowerShell 子进程** —— `idle.ps1` / `frontwin.ps1` / `screenpulse.ps1` / `notify.ps1` / `vault.ps1`，都是短命进程、按需拉起，统一走 `core/ps.ts`（永不 reject，超时与异常都归一成返回值）。
3. **CLI**（`dist/cli/index.js`）—— 独立进程，直接读写 `data/`。它**改不了运行中宿主的内存状态**：间隔这类 live 参数以设置页 / RPC 为准，CLI 写进文件的值要重启后才生效。

### 2.4 目录地图

```
src/
├── index.ts              插件入口：apply() —— 装配一切
├── rpc.ts                卡片与宿主之间的数据通道
├── client.js             （包根）web 设置卡片，手写
├── core/                 地基
│   ├── orchestrator.ts   ★ 主循环 beat() 与各个相
│   ├── paths.ts          dataDir 解析与工作区初始化
│   ├── path-guard.ts     路径白名单守卫
│   ├── atomic-fs.ts      原子写与粉碎删除
│   ├── audit-log.ts      JSONL 审计的读写与裁剪
│   ├── file-lock.ts      跨进程文件锁
│   ├── ps.ts             PowerShell 调用收口
│   ├── time-window.ts    HH:MM 窗口判定
│   ├── runtime.ts        运行时单例
│   ├── bindings.ts       会话绑定
│   ├── material.ts       素材组装与归账（纯函数，好测）
│   └── preset-install.ts 随包预设的安装与校验
├── config/               三层配置的加载与校验
├── vault/                DPAPI 加密、焚毁、换机迁移
├── gate/                 分寸闸门
├── seeds/                素材池与投递报账
├── profile/              用户画像（收件箱 / 存储 / 白名单 / 合并 / 处境摘要 / 快照）
├── screen/               截图与视觉识别
├── env/                  空闲状态、窗口类别、时间语义
├── rhythm/               作息直方图
├── browse/               闲逛裁决、兴趣编辑、偏好加权
├── statusbar/            状态数据源、时间注入、状态栏轨道
├── weekly/               周报
├── ledger/               账本
└── notify/               Windows 通知
assets/                   PowerShell 探针 + 随包预设模板
config/                   出厂配置（policy / busy-rules / interests / profile-schema）
scripts/                  会话修复等一次性工具
tests/                    282 个测试
```

`message-source.d.ts` 是给宿主消息类型打的补丁声明，不参与运行。

---

## 3. 宿主集成契约（★ 升级 DSH 前必读）

这一节记的是**插件与 DSH 之间的约定**。它们没有类型系统兜底：宿主换了实现，插件只在运行时炸，或者更糟——不炸，只是静默失效。每条都标注了**坏了是什么样**，方便升级后按症状反查。

编号（C1…C24）是稳定的，代码注释和提交信息里会引用它们。**升级宿主后，逐条复查，并用 §7 的诊断表验证。**

### 3.1 装载与配置

**C1 · 插件装载**
包主入口导出 `{name, inject, Config(schemastery), apply(ctx, config)}`；`package.json` 的 `dsh.bundle.patch` 指向随包的 `cordis.patch.yml`。`dsh plugin --profile X add <pkg>` = pnpm 安装 + 自动把声明了 `dsh.bundle` 的依赖记进 `dsh.profile.bundles`。

**C2 · effect 语义**
`ctx.effect(fn, label)` 的 `fn` **立即执行**；`fn` 的**返回值**才是 fiber 卸载时调用的清理函数。

```ts
ctx.effect(() => {
  const timer = setInterval(tick, ms);   // 立即执行
  return () => clearInterval(timer);     // 卸载时执行
}, 'heartbeat: timer');
```

把清理逻辑直接写进 `fn` 本身 = 插件刚装上就把自己拆了。症状：`orchestrator_started` 后面紧跟 `orchestrator_disposed`，心跳一声不响。

**C8 · settings 的三代 API**
心跳做特性探测，三代并存：

| 宿主 | 形态 | 心跳走哪条路 |
|---|---|---|
| 0.1.1 / 0.1.2 | 包内自由函数 `installSettingsSection(ctx, ns, …)` | 兜底分支 |
| 0.1.5 | 宿主 `settings` 服务的 `installSection(...)`，且插件 `inject` 必须声明 `'settings'` | 服务法 |
| 0.1.7 起 | `installSection` 与客户端 `settingsScope` 一并删除；设置改由 profile 的插件配置承载（插件页自动表单，编辑即插件重载） | `describe` 存在即跳过注册，`sectionSource = () => config` |

两条硬规矩：① `@deepseek-ai/dsh-settings` **必须在 `dependencies`**——挪到 peer 会让 profile 里的实体包被清掉，表现为"节律配置保存不生效 + 重启回默认"；② client 侧 **inject 不得声明 `settingsScope`**——0.1.7 下整个客户端 bundle 会卡在 pending，web 报 "Failed to load plugins"。

**C10 · `file:` 安装是复制**
`file:` 协议安装 = 目录拷贝，不是链接。改完源码必须把 `dist` 重拷进 profile 的 `node_modules` 副本（或重跑 `dsh plugin add`），否则跑的一直是旧代码。**排查任何"改了没反应"之前，先确认这一步做了**（§9）。

### 3.2 agent 与模型

**C3 · agent 获取的三态**
会话 live（UI 开着或已 resume）→ `ctx.agents.get(sessionId)` 直接取裸 agent；持久化但空闲 → `agents.resume({resumeSessionId, setup})`；全新 → `agents.create({sessionId, meta:{cwd}, setup})`。

- `create` 对已持久化的 id 报 `already owns this identity`；`resume` 对 live 会话报 `while it is live`。
- 0.1.2 起必须显式传 `agentOptions`（见 C12），并在 `setup` 里挂预设（见 C13）。
- `setup` 可以是 async：工厂会 await 它，抛错即回滚创建。

**C4 · 句柄要解包**
`agents.create/resume` 返回 `AgentHandle{ agent, dispose }`，裸 agent 在 `.agent` 上。

**C5 · 模型轮次与事件**
`agent.followup(createUserMessage({...}))` 发起一轮，`await agent.whenIdle()` 等它跑完；助手文本从事件流里 `type` 含 `assistant` 的事件提取。

- 0.1.2 **移除了 `Session.events`**：改读 `snapshotEvents(fromSeq?, toSeqExclusive?)` + `seq`。插件侧封了 `sessionEvents()` / `sessionEventCount()` 做兼容回退，别在业务代码里直接摸 `session.events`。
- 所有写进会话的消息**必须经宿主 `createUserMessage` 严格工厂**。手写消息对象会缺 message id，宿主加载该会话时报 `session event at seq N lacks an identified message`——用户的会话直接打不开（修复工具见 §13）。

**C6 · 工具限制**
`agentCtx.get('tools').restrict({ allow: ['web_search'] })`，在 `setup(agentCtx)` 钩子里调用，按 agent 作用域终身生效。

- 只能点名**继承层**里的工具。agent 自身层注册的只进 `knownNames`、不进 `restrictableNames`，所以**没有预设的裸 agent 连 `web_search` 都点不了名**（报 `names unknown global tool "web_search"`）——这也是为什么预设是必需的（C13）。
- `tools.schemas()` 不传 scope 拿到的是**全局视图**，不能拿来判断预设挂上没有。判据是同一行审计里的 `restrict=ok`。

**C12 · 模型路由必须显式传**
0.1.2 起 `agents.create/resume` 的 `agentOptions` 默认 `{}`，宿主**不再代填部署默认**。不传 → `options.model === undefined` → 内置 persona 插值失败，**每一轮**都在起点抛：

```
prompt variable "{{model}}" has no value for this assembly (section "deployment:persona")
```

插件侧的 `defaultAgentOptions(ctx)` 读 `ctx.get('agentDefaultModel').currentSelection()` 拿默认路由。

**投递目标的 resume 同样必须带它**——这是踩过最狠的一次：漏传时插件只记一句 `spoke_failed: non-Chinese output discarded`（空文本被兜底闸拦下），而报错实际出现在**用户自己的会话里**，因为宿主会把这个没有模型路由的 agent 当成该会话的 live agent 继续复用。投递一结束就 `handle.dispose()` 把 agent 还回去（审计 `deliver_target_released`），宿主会在用户下次打开该会话时按自己的组合重建。

**C13 · agent 预设**
`agents.create/resume` 发布的是**裸 agent**：不加入任何预设时，工具、提示段、技能目录全部按**空全局层**解析——部署预设里的 `web_search` 因此完全不存在，闲逛相只能返回空数组。

修法：在 `setup(agentCtx)` 里 `await agentCtx.get('agentPresets').mount(agentCtx, id)`（async；要求 `scopeOf(agentCtx)` 有效；id 缺省用 `defaultId`）。

- 预设目录布局（≤0.1.5）：`<dshHome>/.agent-presets/<id>/{agent.cordis.yml, preset.yml}`，id 需匹配 `[a-z0-9][a-z0-9-]*`。
- 0.1.7 起宿主**不再加载文件系统用户根**，预设改为**组合声明行**（`@deepseek-ai/dsh-agent-preset`，与官方 `preset-standard` 同机制）。包内置 `preset-heartbeat` 行，内容 = `compaction` 组 + `tool-web`（`fetch:false`），**故意没有 persona 行**——人格沿用部署 persona。
- `list()` 每次调用都重新 readdir（无缓存），所以运行期新建的预设目录对下一次 `mount()` 立即可见，不需要重启宿主。

**C18 · 随包预设的自动安装（≤0.1.5 的文件系统路径）**
插件启动时取 `agentPresets.roots`（公开 getter）里 `trust === 'user'` 的那一项当目标根——不猜 `~/.dsh`，也不依赖 `@deepseek-ai/dsh-home-paths`（那个包不在 profile 的 node_modules 里，import 不到）。`installBundledPreset()` 的四种结果：

| 结果 | 含义 |
|---|---|
| `created` | 目录/文件缺失，已建 |
| `repaired` | 目录在但缺 `agent.cordis.yml`，已补 |
| `exists` | 已有 composition 文件，**一个字节都没动**（手改过的自定义预设是安全的） |
| `restored` | 只有 `--force` 才会走到，覆盖 |
| `skipped-disabled` / `skipped-no-root` / `skipped-custom-id` | `installPreset:false` / roster 里没有 user 根 / `agentPreset` 不是 `heartbeat` |

### 3.3 事件、会话与持久化

**C7 · pre-step 注入**
```ts
ctx.on('agent/pre-step', async ({ agent, turn, step, signal }, next) => {
  const result = await next();
  return { kind: 'enter', messages: [...注入的消息] };
}, { prepend: true });
```
waterfall：`await next()` 之后返回 `{kind:'enter', messages}` 是**追加式**注入，不碰已有前缀。

门控信号：**step === 1 且末事件是 `agent/inbox/spliced`** = 用户发起的轮次；**step > 1 且 `step/end`** = 任务中途。日常会话的时间注入与状态栏就靠这个区分。

**C11 · 会话持久化布局**
`~/.dsh/sessions/<cwd-slug>/<sessionId>/session.jsonl.zstd`（zstd 可用 `node:zlib` 解）。会话 flush 是**惰性**的——活跃会话的内容可能只在内存里，磁盘上看不到。

**C14 · 事件形态：reasoning 块会骗人**
`assistant/message` 的 `content` 是**块数组**：`[{type:'reasoning', text:…}, {type:'text', text:…}]`。reasoning 块**同样带 `text` 字段**，所以按 `typeof c.text === 'string'` 过滤会把思考草稿和正文无分隔地拼在一起（`…{"speak":false}{"speak":false}`），JSON 解析必崩：

```
SyntaxError: Unexpected non-whitespace character after JSON at position 15
```

**读模型输出必须排除 reasoning 块。** 流式事件里另有 `{type:'block-start', blockType:'reasoning'}` 和 `block-end.block.type` 可以判。

**C17 · 会话标题**
0.1.2 起标题按**每会话一条记录**存放：`~/.dsh/storages/session_projcache/sessions/<sessionId>.json` 的 `rows.title.val`。非 `session-` 前缀的记录（子代理会话）要跳过；旧的单文件聚合 `session_projcache.json` 只作兼容回退。

**C19 · 0.1.5 事件改名**
`assistant/chunk` 更名 `assistant/attempt`（载荷 `{turn, step, stream: AssistantStreamRecord[]}`，失败/重试/取消的尝试整段嵌入）；新增 surface 事件 `system/message`。

对插件的影响面：`terminalTurnError()` 兼容扫两种事件；`assistantText()` 不受影响（`assistant/message` 仍带 `message`，attempt 事件没有 content，会被空文本自然跳过）；观察相按事件类型过滤、游标按 `seq` 索引，插入新事件类型无影响。

**C20 · 0.1.5 持久层重构（会话格式 v3）**
持久层拆成中立的 `dsh-session-persistence` + 独立后端 `dsh-session-persistence-jsonl`（产物仍是每会话一个只追加的 `.jsonl.zstd`）。`SESSION_FORMAT_VERSION` 从 0 跳到 **3**，旧版本头被直接拒绝；宿主内置**代际迁移**——保留历史代文件（`session.jsonl.zstd` = v0），首次访问时解码-迁移-校验后发布当前代，**源文件只读不改**。

**升级宿主前必须备份 `~/.dsh/sessions`。** 迁移后的目录是多代文件布局，`scripts/repair-session.mjs` 的手册要按新布局复查（修复工具只应再碰 v0 历史代）。

### 3.4 前端与数据通道

**C9 · client 契约**
`package.json` 里 `dsh.client: { platform: 'web' }` + exports `"./client"`。client 模块是 `window.__ModuleLoader__.load({ id, factory })`，**factory 必须返回带 `apply` 的对象**（client 侧也跑 cordis，同样校验）。

```js
ctx.slots.inject('settings.section', function* () {
  yield ctx.slots.register({ name: 'settings.section', id, order, label, inject }, ReactComponent);
});
```

client 侧能 inject 的服务：`slots / locale / sessions / remote`（`settingsScope` 见 C8 的警告）。

**C15 · client 模块的身份**
client 模块的注册 id **必须严格等于包名**：宿主 `resolveSource()` → `locatePkgJson()` 向上找 `package.json` 并要求 `name === expectedPackageName`，不匹配返回 null，该包被从 client 组合里**静默剔除**——**没有任何报错**，host 半照跑、数据照写，只是设置页整块消失。

三处必须一致：`package.json.name`、`cordis.patch.yml` 里 insert 行的 `name`、`client.js` 的 `load({id})`。

**C16 · 前端 bundle 缓存**
client bundle 由宿主**启动时**读入内存并按内容打 immutable 缓存（组合 URL 形如 `/plugins/??ids/client.js&rev`），内部**没有 fs.watch**（热重载只在 dev 模式有）。改完 `client.js` 刷新页面无效，**必须重启 DSH**。

**C21 · RPC 走 `/api` 精确路由**
0.1.5 的 cordis 严格服务解析下，**自定义 `rpc.handle` 通道整体不可用**：cordis `Service` 把 `this.ctx` 固定在提供方自己的上下文里（`dsh-client-connection` 的模块 inject 没有 `webServer`），于是通道内部的 `webServer.register(route)` 必然抛 `cannot get property "webServer" without inject`——**调用方怎么 inject 都救不了**。

正解：`connection.fetch.register()` 在 `/api` 下注册精确 Fetch 路由，只写 connection 内部的注册表、不碰别的服务，两代通用。信封与 `/api` 同构（`client-request` / `server-response`），端点名走 `payload.endpoint`；客户端 `rpc.call('/api', 'heartbeat', { endpoint, … })`。

**鉴别法**：405 = 路由没注册（请求落到了静态资源的 fallback 座位）；404 = 路由在但端点名不匹配；401 / 403 = `/api` 的认证拦截。心跳注册成功会留一行 `rpc_registered route=/api/heartbeat`。

**C22 · 兴趣与时段卡片的编辑口径**
权威文件仍是 `interests.json`，`loadInterests` 的语义是"用户层**整体取代**出厂层"。卡片编辑走 `interests.list / add / remove / setWindows` 四个端点。

- **首次成功变更时把出厂文件逐字节复制进用户层**，此后用户层即唯一权威——出厂文件更新不再自动跟上。
- 读取与**失败的校验**都是只读的，绝不顺手创建用户层（否则"看一眼卡片"就接管了出厂配置）。
- 窗口校验：HH:MM、同日起始 < 结束、1–6 个、两两不重叠（裁判取第一个命中窗口，重叠会静默改变优先级）。
- 兴趣条目：trim + 折叠空白、≤ 60 字、大小写不敏感去重、≤ 32 条。
- `_comment` 等未知顶层键保存时保留。

**C24 · RPC 通道的宿主闸门**
插件注册的 `/api/heartbeat`**自身不做鉴权**，靠宿主 `/api` 前缀路由在 dispatch 前调 `connection.admit(req)` → `requestRejection(req)`（Host/Origin fence + 32 字节浏览器认证 secret）把守。

插件在注册时自检宿主 `connection` 上有没有这两个钩子：缺失就写审计 `rpc_host_gate_missing`，并让 `DESTRUCTIVE_ENDPOINTS`（`seeds.delete` / `migrate.import` / `bindings.remove` / `config.set` / `profile.export` / `interests.remove`）一律返回 `forbidden`（fail-closed），只读端点照常服务。

**升级 DSH 后如果动了 `src/rpc.ts`，先确认这两个钩子还在。** 都不在 = 通道退化成"任何能 POST 到本机端口的人都算数"。

### 3.5 视觉桥

**C23 · ModLens 视觉识别**
截图描述走宿主 profile 里的 `@liustack/modlens` CLI（与插件同在 profile 的 node_modules 树里，**运行时向上解析** `dist/main.js`，不存绝对路径；解析不到 = 视觉静默关闭）。

```
node main.js -i <解密后的截图> -o <tmpJson> -p <provider> --timeout <ms>
```

- **必须用 `-p` 钉死 provider**：默认链会先探测 Antigravity CLI 的登录态，未配置时干转约 97 秒才 exit 1。默认 `-p openai`，`data/settings/vision.json` 的 `{provider, prompt}` 可以覆盖。
- 输出 JSON 取 `result.summary`（宽容解析 `result.summary` / `summary` / `ocr.full_text`）。
- 异步 spawn（同步会冻结宿主事件循环）；stderr 截 4000 字进 `screen_vision` 审计行。
- 截图的"解密 → 使用 → 焚毁"复用 screenpulse 的 `unlockShot` / `burnUnlocked`。

### 3.6 升级 DSH 的复查顺序

1. **先备份** `~/.dsh/sessions`（C20 会动用户数据）。
2. 看两类审计行：`tool_policy`（工具面是否完整）与 `beat_error`（有没有结构性抛错）。它们比"看 UI 有没有动静"定位快得多。
3. 逐条过本节的 C1–C24，重点看历史上最爱变的几条：**C2**（effect 语义）、**C4**（句柄形状）、**C5**（事件读取）、**C8**（settings 三代）、**C9/C15**（client 契约与身份）、**C12**（模型路由）。

---

## 4. 模块实现

### 4.1 core/ —— 地基

| 文件 | 干什么 | 要动它时注意 |
|---|---|---|
| `paths.ts` | dataDir 解析 + 包定位 | 优先级：env `HEARTBEAT_DATA_DIR` > 插件配置 `dataDir` > `<包根>/data`；`initWorkspace` 幂等建目录 |
| `path-guard.ts` | 路径白名单守卫 | 先把路径 realpath 规范化（目标不存在时：realpath 最深的存在祖先 + 回拼缺失的尾巴），再与规范化后的 dataDir 做**大小写不敏感、带分隔符边界**的前缀比对。必测向量：`..` 穿越 / 符号链接 / 8.3 短名 / 大小写 / UNC |
| `atomic-fs.ts` | 原子写 | 同目录随机 tmp + rename（Windows 上是替换写）；`shredFileSync` 覆写 N 次后删除 |
| `audit-log.ts` | JSONL 审计 | `appendAuditLine` / `readAuditLines`（坏行保留为标记）/ `pruneAuditFile`（按龄裁剪，原子重写）。**写入永不抛**，失败只落 stderr——审计故障不该拖垮业务 |
| `file-lock.ts` | 跨进程文件锁 | `withFileLock(target, fn)`：锁文件 `${target}.lock`，`O_EXCL` 创建 + 写 pid；15 秒判死锁、3 秒轮询等待、超时 **fail-open 照常执行**（锁防的是并发损坏，不是授权）。宿主插件与 CLI 是两个进程、会同写 `seeds.jsonl` 与 `profile_inbox.jsonl`，所有"读-改-写"路径都过它 |
| `ps.ts` | PowerShell 调用收口 | `runPowerShell` / `runPowerShellFile`，**永不 reject**（超时、非零退出、异常一律归一成返回值） |
| `time-window.ts` | HH:MM 窗口判定 | `parseHhMm` / `minutesOfDay` / `inHhMmWindow`（半开区间，支持跨夜）。静默窗与闲逛窗口共用同一份实现 |
| `runtime.ts` | 运行时单例 | paths / guard / policy / UI 开关的统一读取口；测试用 `resetRuntimeForTest` |
| `bindings.ts` | 会话绑定 | 读写 `data/settings/bindings.json`；`deliverTargets` / `observeTargets` 两个过滤器 |
| `material.ts` | 素材组装与归账 | 纯函数、好测：`assembleCandidates`（组候选）、`buildMaterialPrompt`（素材包三段式）、`buildRuminationPrompt`（反刍备料）、`reconcileDelivery`（归账） |
| `preset-install.ts` | 随包预设的安装与校验 | 见 C18 |

### 4.2 orchestrator.ts —— 主循环

全项目最大的文件（约 1730 行），但结构很直白：**一坨模块状态 + 一堆相函数 + 一个 `beat()`**。

模块级状态（都在 `startOrchestrator` 的 disposer 里清干净——宿主可能因为一次配置编辑重载插件，残留状态会被新实例当成自己的）：

| 状态 | 用途 |
|---|---|
| `beating` / `beatCancel` | 拍级单飞，以及取消正在跑的那一轮模型 |
| `beatWatchdog` | 45 分钟看门狗 |
| `agentPromise` | 引擎室 agent 的缓存 Promise |
| `homeRotatePending` | 家轮换的待办理由（溢出标记或尺寸阈值） |
| `lastBeat` / `droppedStreak` | 最近一拍的结果、连续丢弃计数 |
| `deferredRetries` / `retryTimer` | 获取失败时的退避阶梯 |
| `reschedule` | 改间隔时重排定时器 |

几个值得先记住的函数：

- `ensureAgent()` —— 引擎室的三态获取，含"看起来还活着吗"的探测与自愈。
- `agentTurn()` —— 跑一轮并抽文本：排除 reasoning 块、过滤工具收尾标签、取最后一个含中文的行。踩过多次坑的地方（C14）。
- `expressionPhases()` —— 闸门 → 备料 → 反刍 → 投递 → 归账，全在这一段里。
- `spokeTextSince()` —— 投递超时之后回到事件流里确认"到底说没说出口"，这是记账的兜底锚点。

**家轮换**：引擎室会话会越聊越长，长到上下文溢出就没法用了。两条触发路径——`agentTurn` 撞上上下文溢出错误时主动标记，或者事件数达到 `HOME_ROTATE_EVENT_COUNT = 3000`。轮换时把旧会话归档（可关）、建一个新的当引擎室，**本拍不表达**，等下一拍。

### 4.3 config/ —— 三层配置

从低到高：

1. **出厂层** `config/policy.json`（包内只读）
2. **用户文件层** `data/settings/policy.json`（`deepMerge` 覆盖，非法即 fail-closed）
3. **UI 层** `data/settings/ui.json`（设置卡片写的六个字段：`intervalMin` / `maxDailySend` / `timeInjectMin` / `statusbar` / `idleMode` / `tokenSaver`）
4. **组合条目覆盖** profile 的 `cordis.patch.yml` 里 `id: heartbeat` 的 config（`intervalMin` / `maxDailySend` / `dataDir` 等，0 = 不覆盖）

> **只有 UI 层这六个字段支持热改**——设置卡片一保存就生效，不用重启。**其余参数只有出厂层与用户文件层两条路**，改完要重启。这是刻意的：经常要拧的旋钮做成热的，结构性参数做成冷的。

`assertPolicy` 是唯一的校验入口——非法配置直接 fail-closed，不给半残策略。`ui-config.ts` 单独管 UI 层那六个字段的读写与消毒。

### 4.4 vault/ —— 加密与焚毁

- **`assets/vault.ps1`**：DPAPI（CurrentUser）整文件加解密，`KHBV1` ASCII 头；脚本保持 **ASCII-only**（避开 PowerShell 5.1 的代码页坑）。
- **`vault.ts`**：`loadJson` / `saveJson`（密文自动识别、明文兼容读）、`encryptFile` / `decryptFile`、`loadEncryptedText` / `saveEncryptedText`（素材池、收件箱、journal 用）、`readText` / `writeText`（账本这类明文）。**明文临时窗只落 `data/tmp/`**；所有路径先过守卫；加密失败 fail-closed。
- **`burn-list.ts`**：**焚毁清单的单一事实源**（曾经两份硬编码漂移、漏掉文件）。burn = 预演 / `--yes` 执行（覆写 ×3 + 删除）/ `--all` 连设置一起清；卸载时的 `--purge` 复用同一套清除核心。焚毁后会重建 journal 并写一条 `BURN_EVENT`。
- **`migrate.ts`**：换机迁移的导出 / 导入。导入是**两阶段**的——先全部落成 `.incoming-<时间戳>`，再统一改名，失败整体回滚；被替换的原文件留 `.bak-migrate-<时间戳>`。

### 4.5 gate/ —— 分寸闸门

判定顺序（`evaluateGate` 是纯函数，全部可单测）：

```
静默时段 → 忙时窗口类别 → 在场联动 → 每日上限 → 冷却 → 放行
```

- 忙时窗口用 live 前台探针优先，快照太旧就不采信（年龄阈值可配，见 §6）。
- `confirmSend` **只在投递成功后调用**——失败不计数、不留冷却。这条语义是刻意的：一次没送出去的尝试不该消耗当天的额度。
- 配置读失败 → 最保守的 SILENT（fail-closed）。
- `canSend()` 是 `confirmSend` 与"投递前预检"共用的判定，抽出来是为了两边不再各写一遍、慢慢走偏。

### 4.6 seeds/ —— 素材池

- 存储 `data/seeds.jsonl`（DPAPI），一行一条。字段：`{id, text, topic, tag, source, category, confidence, protected, used, bornAt, expiresAt, lastUsedAt, lastEvidenceAt, status, retireReason}`。
- **两个品类**：`topic` 与 `chat`，各有容量上限；品类满只在自己池内按淘汰分挤人。
- **四条淘汰规则**（`gcPool` + 入库时的容量挤出）：过期（按品类的 TTL 阶梯）、用尽（`retireAfterUsed`）、冷板凳（久未被选中）、容量挤出。淘汰 = **归档**（`--archived` 能翻回来），不删除。
- 综合分 = 新鲜度 0.4 + 未用 0.3 + 置信度 0.3（手写与画像来源有额外保护）。
- 同题合并：内容取最新、`used` 累计、证据时间取最大。
- `isConsumed()` 是"这条素材算不算已经说过了"的唯一谓词，被"选中投递"和"回收"两处共用——以前两处各写一份，语义会漂。
- `report.ts` 是**投递报账**：陪伴 agent 每次收到素材包都要调一次 `seed_report` 工具报账，落 `data/seed_report.jsonl`（DPAPI）。没报账的投递由引擎室兜底，并记一条 `report_missing`。

### 4.7 profile/ —— 用户画像

| 文件 | 职责 |
|---|---|
| `types.ts` | 四个分区（interest / projects / comm / psy）的条目结构：双时间戳 + evidence + 时效档位；操作只有四种：ADD / UPDATE / INVALIDATE / NOOP |
| `schema.ts` | 白名单：分区 → topic → sub_topic 逐级限定，sub_topic 级还能规定"允许哪些档位 + 默认档"。**白名单外一概不收**。文件坏了走三级降级（用户层 → 出厂层 → 无白名单），并留 `profile_schema_fallback` |
| `store.ts` | 守卫逐条裁决（白名单 / evidence 强制且 ref 必须存在 / 置信度按来源封顶 / psy 门控 / 分区容量 / UPDATE 升级要二次确认 / INVALIDATE 的归属）+ 确定性老化（volatile 14 天失效、stable 180 天标"低活跃"但不删）+ **journal 唯一权威**（ADD 回写 id 保证重放一致；`verify` 只报不修；`rebuild` 原子替换，撕裂尾会显式报告） |
| `inbox.ts` | 观察收件箱：去重键 `kind + ref`（同一条观察重复投递只算一次）、note 截断到 120 字、**合并失败时收件箱保留** |
| `consolidate.ts` | 合并：触发（积压 ≥ 30 条，或距上次 ≥ 12 小时且积压不为 0）→ 排水分组 → 拼裁决提示词 → 调模型 → 守卫 → 应用 + 落 journal + 排水（**成功才清**）。单飞锁防重入，模型调用由编排器注入 |
| `digest.ts` | 处境摘要：三个切面（作息 + 沟通 + 窗口类别 / 高置信话题 top N / 高置信兴趣），控制在 800 token 预算内；stable 但久未验证的条目会标"久未验证" |
| `snapshot.ts` | journal 快照：累积到阈值就把当前状态定格，缩短重放路径 |

**隐私边界**：送进模型的只有条目字段（四个分区、含 psy）与 ≤1 句观察引语——**不送对话原文、不送证据全量**。

### 4.8 感知层：screen / env / rhythm

- **`screen/`** —— `screenpulse.ps1` 采前台窗口、焦点、可见窗口列表与全屏原图；落在 `data/tmp` 的明文裸件**立刻加密**成 `screen.json` / `screen.jpg` 再焚掉裸件。`unlockShot` 用毕即焚。可见窗口上限读 `busy-rules.json` 的 `rules.visible_window_cap`。
- **`vision.ts`** —— 见 C23。
- **`env/`** —— `idle.ps1` 只输出空闲秒数；`presenceOf` 分三档（< 30 秒算活跃、看窗口类别 / 30–1200 秒 present / ≥ 1200 秒 away）。两档阈值读 `busy-rules.json` 的 `rules.idle_floor_seconds` 与 `rules.idle_away_seconds`，代码里的常量只作 fallback。`timeflow.ts` 是纯时间语义（时段名、节日表）。
- **`rhythm/`** —— hour × weekday 的在场直方图，30 天滚动 + 指数衰减（τ ≈ 10 天）。**衰到 1e-3 以下归零；峰值要同时过"强度 ≥ 0.25"与"≥ 最高值的 5%"两道门。** 指数衰减永远不会真正到零，不设这两道门，一次偶发熬夜会被永久报成作息。纯统计、无内容，明文。

### 4.9 browse/ —— 闲逛与兴趣

- **闲逛裁决**（`adviseWander`）：窗口 + 最小间隔 + 焦点冷却三道闸，过了才调模型；**结果由代码入池**并 `completeWander` 登记节流（模型不碰登记）。
- `resolveSchedule()` 是六个排程参数的统一出口：**用户层 `interests.json` 的 `_schedule` 优先，policy 里的 `browse.*` 作编译默认**。
- `interests-edit.ts` 独占卡片编辑逻辑，口径见 C22。
- `preference.ts` 是话题偏好加权：从报账记录里学"哪些话题值得再聊"，权重有夹逼区间、半衰期衰减和硬地板。

### 4.10 statusbar/ —— 状态栏与时间注入

- **`store.ts`**：每拍派生一个场景（`quiet-hours > just-spoke > wandering > busy > present > away`），写 `data/settings/status.json`（明文，**不含任何时间词**——这是设计红线，状态栏不该泄露"现在几点"）。`StatusReader` 按 mtime 缓存，供注入轨的热路径读。
- **`time-inject.ts`**：自研时间注入。门控 = step 1 且用户发起，且距上次注入超过 `timeInjectMin` 分钟；节流状态按会话存在 `data/time-inject-state.json`，重启不丢。
- **`track.ts`**：状态栏的两条轨道。读得到宿主系统提示的模型走 `heartbeat:status` 这个系统 section；其余模型在 pre-step 的时间消息尾部追加一行。**轨道钉在轮次起点**（step 1 时重钉），中途能力翻转不会把同一轮劈开。

> **渲染纯性红线**：宿主对"逐字节相同"的文本零提交。所以渲染层不放高频变化的字段——note 只进状态文件与 UI，不进 section 文本。

### 4.11 weekly/ —— 周报

`collect.ts` 汇总一周的事实（开口次数、素材使用、账本待跟进、画像变化、报账统计），`report.ts` 交给模型写成人话，落 `data/weekly/report-<日期>.json`。触发锚点在 `data/weekly/state.json`——**文件缺失与文件损坏要分开处理**（损坏会记 `weekly_anchor_corrupt` 并用文件 mtime 兜底，否则一个坏文件会让周报永远不再生成）。

### 4.12 ledger/ 与 notify/

- **`ledger.ts`**：唯一账本，Markdown 行格式 `- [YYYY-MM-DD HH:MM][open|done][#id] 文本`；**手写乱行原样保留**（人可读是设计目标）。`pendingOlderThan` 供"待办挂太久了"的跟进时机用。`tool.ts` 把它注册成模型可调用的工具。
- **`notify.ts`**：AUMID 自注册（HKCU + 开始菜单快捷方式，不需要管理员）。**只提示"有新消息"，不承载正文。**

### 4.13 rpc.ts 与 client.js

RPC 是卡片与宿主之间的唯一通道（协议细节见 C21）。端点用一张注册表描述，统一包一层错误归一与审计：

| 分组 | 端点 |
|---|---|
| 状态 | `status`（带插件版本、当前场景、cap / 冷却摘要） |
| 会话 | `sessions.list`、`bindings.get` / `add` / `remove` |
| 素材 | `seeds.list` / `archive` / `restore` / `delete` |
| 画像 | `profile.digest` / `profile.export` |
| 账本 | `ledger.open`（让宿主拉起编辑器） |
| 配置 | `config.get` / `config.set` |
| 兴趣 | `interests.list` / `add` / `remove` / `setWindows` |
| 周报 | `weekly.list` / `weekly.get` |
| 维护 | `migrate.export` / `migrate.import` |

`client.js` 是七个分区的卡片：状态（30 秒轮询，默认展开）/ 会话绑定 / 素材池 / 兴趣范围 / 画像（只读）/ 账本 / 节律配置。**每个分区独立报错**，一个分区挂了不影响别的。

### 4.14 cli/

`dist/cli/index.js` 是独立进程的运维入口，命令清单见 §7.3。结构是 `main()` + 一张 `VERBS` 表 + 每个 verb 一个函数。它直接读写 `data/`，所以**改不了运行中宿主的内存状态**——想改间隔请走设置页。

---

## 5. 数据文件字典

下面所有路径都相对 **dataDir**（默认在包根下的 `data/`，可被环境变量或插件配置覆盖，见 §1）。

> **怎么判断一个文件是不是密文**：文件头是 ASCII 的 `KHBV1` 就是走 DPAPI 加密的；能直接 `type` 出人话就是明文。想知道某处该用哪种，看它调的是哪一对函数——`loadEncryptedText` / `saveEncryptedText`、`encryptFile` / `decryptFile`、`loadJson` / `saveJson` 都进加密通道；`readText` / `writeText` 是明文。

### 5.1 素材与偏好

| 文件 | 内容 | 谁在写 |
|---|---|---|
| `seeds.jsonl` | 素材池，一行一条（活跃区） | `seeds/pool.ts` |
| `seeds.*`（归档区） | 被淘汰的素材，`seeds --archived` 可查、`restore` 可捞回 | 同上 |
| `seed_report.jsonl` | 投递报账流水，环形保留最近 400 条 | `seeds/report.ts` |
| `preference.json` | 话题偏好权重（30 天半衰期，权重夹 0.5–2，14 天硬地板） | `browse/preference.ts` |

### 5.2 用户画像

| 文件 | 内容 | 谁在写 |
|---|---|---|
| `profile.json` | 画像物化视图（四个分区的全部条目） | `profile/store.ts` |
| `profile_journal.jsonl` | 操作流水，**重放它才是恢复真相的路径** | 同上 |
| `profile_journal.archive-*` | 轮转出去的历史流水 | 同上（快照时） |
| `profile_snapshot.json` | journal 轮转基线 | `profile/snapshot.ts` |
| `profile_inbox.jsonl` | 观察收件箱（待合并的**观察**） | `profile/inbox.ts` |
| `profile_rhythm.json` | 作息直方图（纯统计，不含内容） | `rhythm/rhythm.ts` |
| `logs/rebuild-report.txt` | 上一次 `profile rebuild` 的校验报告 | 同上 |

### 5.3 感知与在场

| 文件 | 内容 | 谁在写 |
|---|---|---|
| `screen.json` | 前台窗口、进程、标题、焦点、可见窗口列表（**密文**） | `screen/screenpulse.ts` |
| `screen.jpg` | 屏幕截图（**密文**，视觉识别用完即从明文区焚毁） | 同上 |
| `envpulse.json` | 环境温度计快照（空闲秒数、窗口类别、在场景） | `env/envpulse.ts` |
| `settings/status.json` | 状态栏场景（明文，**不含时间词**） | `statusbar/store.ts` |
| `settings/vision.json` | 视觉识别的 provider 与提示词覆盖 | 用户手改 |

### 5.4 状态、节流与闸门

| 文件 | 内容 | 谁在写 |
|---|---|---|
| `sent.json` | 表达记录（已送出的内容、时间戳），冷却与每日上限都看它 | `gate/gate.ts` |
| `cursors.json` | 观察游标：每个绑定会话看到哪了（`{version: 2, cursors: {…}}`） | `core/orchestrator.ts` |
| `time-inject-state.json` | 时间注入的节流状态（按会话记上次注入时刻） | `statusbar/time-inject.ts` |
| `gate.json` | 正身会话 id（DPAPI 加密；**改它必须重启 DSH**） | `core/orchestrator.ts` |
| `browse.json` | 闲逛状态（上次闲逛时刻、焦点冷却、当日次数、refill 次数） | `browse/browse.ts` |
| `weekly/state.json` | 周报的触发锚点 | `weekly/report.ts` |
| `weekly/report-<日期>.json` | 已生成的周报正文 | 同上 |

### 5.5 配置（三层，详见 §4.3 与 §6）

| 路径 | 层级 | 说明 |
|---|---|---|
| `config/policy.json` | **出厂层**（包内只读） | 全部默认参数 |
| `data/settings/policy.json` | 用户文件层 | 深合并覆盖出厂层；写错了 fail-closed |
| `data/settings/ui.json` | UI 层 | 设置卡片写的六项（`intervalMin` / `maxDailySend` / `timeInjectMin` / `statusbar` / `idleMode` / `tokenSaver`） |
| `data/settings/interests.json` | 兴趣层 | 首次编辑时从出厂层复制过来，此后**整体取代**出厂层 |
| `data/settings/profile-schema.json` | 白名单层 | 同上，整体取代出厂层 |
| `data/settings/bindings.json` | 会话绑定 | 陪伴 / 观察目标的名单 |

### 5.6 日志

| 文件 | 内容 | 保留 |
|---|---|---|
| `logs/heartbeat.jsonl` | 主审计流（**排障第一现场**，见 §7） | 30 天 |
| `logs/envpulse.jsonl` | 环境探针逐次记录 | 48 小时 |
| `logs/consolidation.txt` | 上次画像合并的时间戳 | — |

审计是 **JSONL，一行一个事件**，字段至少含 `ts`（UTC ISO）与 `event`。裁剪由 `pruneAuditFile` 按龄做（原子重写），在维护相里跑。

### 5.7 临时区与导出区

| 路径 | 说明 |
|---|---|
| `tmp/` | **唯一的明文临时窗**：加解密中间件、截图裸件、CLI 的临时产物都在这里，用完即焚 |
| `exports/` | `migrate export` 的产物（换机迁移包） |

`tmp/` 里的东西随时可以被删；除它之外，任何明文出现都是 bug。

---

## 6. 参数位置速查

**先看 §4.3 的三层结构**：能热改的只有设置卡片那六个字段，其余都是"改文件 + 重启"。下面按"改哪儿"分组。

### 6.1 热参数 —— 设置卡片（落 `data/settings/ui.json`）

| 字段 | 含义 | 取值 |
|---|---|---|
| `intervalMin` | 心跳间隔（分钟） | 1–1440 |
| `maxDailySend` | 每日开口上限（条） | 1–50 |
| `timeInjectMin` | 时间注入节流（分钟；0 = 关闭） | 0–1440 |
| `statusbar` | 是否接管状态栏 | 布尔 |
| `idleMode` | 闲人模式（更少打扰） | 布尔 |
| `tokenSaver` | 用户离开或锁屏时暂停心跳 | 布尔 |

保存即生效，不重启。**越界的值会被丢弃而不是夹逼**（写成 `0` 就等于没写），范围表在 `src/config/ui-config.ts:25-29`。

### 6.2 冷参数 —— `data/settings/policy.json`（或出厂 `config/policy.json`）

深合并覆盖，改完重启。字段名就是 `config/policy.json` 里的点号路径：

| 路径 | 含义 | 出厂值 |
|---|---|---|
| `heartbeat.intervalMin` | 心跳间隔（分钟） | 20 |
| `heartbeat.idleMode` | 闲人模式 | false |
| `heartbeat.archiveRotatedHome` | 家轮换时归档旧会话 | true |
| `gate.maxDailySend` | 每日开口上限 | 3 |
| `gate.cooldownMinutes` | 两次开口之间的最小间隔 | 30 |
| `gate.quietHours.start` / `.end` | 静默时段 | 01:00 / 08:00 |
| `browse.windows` | 闲逛窗口 | 11:00–15:00、17:00–21:00 |
| `browse.minIntervalHours` | 两次闲逛的最小间隔 | 4 |
| `browse.maxSeedsPerVisit` | 一次闲逛最多入池几条 | 2 |
| `seeds.maxActive` | 活跃素材池上限 | 30 |
| `seeds.ttlDays.*` | 分品类保质期（天）：news / fandom / scene / promise | 3 / 14 / 60 / 90 |
| `seeds.coldBenchDays` | 多久没被选中算冷板凳 | 21 |
| `seeds.archiveCap` | 归档区上限 | 50 |
| `seeds.retireAfterUsed` | 用几次退休 | 2 |
| `seeds.scoreWeights.*` | 淘汰分权重：freshness / unused / confidence | 0.4 / 0.3 / 0.3 |
| `profile.consolidation.minIntervalHours` | 两次合并的最小间隔 | 12 |
| `profile.consolidation.inboxBacklog` | 积压多少条强制合并 | 30 |
| `profile.partitionCap` | 每个分区的条目上限 | 50 |
| `profile.maxOpsPerRun` | 一次合并最多应用几条操作 | 10 |
| `profile.confidenceCap.*` | 各来源置信度封顶：chat / screen / browse | 0.6 / 0.4 / 0.4 |
| `profile.volatileDays` | volatile 条目的有效期（天） | 14 |
| `profile.stableLowActivityDays` | stable 条目多久没验证标"低活跃" | 180 |
| `profile.psyEnabled` | 是否启用 psy 分区 | false |
| `observe.maxChars` | 一条观察摘录多少字 | 80 |
| `observe.perBeat` | 每拍每会话最多观察几条 | 10 |
| `weekly.enabled` | 是否生成周报 | true |
| `retention.envPulseHours` | 环境探针日志保留（小时） | 48 |
| `retention.decisionLogDays` | 主审计保留（天） | 30 |

### 6.3 忙时规则 —— `data/settings/busy-rules.json`（出厂 `config/busy-rules.json`）

| 路径 | 含义 | 出厂值 |
|---|---|---|
| `rules.focus_stable_seconds` | 前台快照超过多久就不采信 | 15 |
| `rules.idle_away_seconds` | 空闲多久算"离开" | 1200 |
| `rules.idle_floor_seconds` | "活跃"与"在场"的分界 | 30 |
| `rules.visible_window_cap` | 一次采集合几个可见窗口 | 20 |
| `busy.groups` / `idle.groups` | 进程名到分类的规则 | 见出厂文件 |

> 这四个阈值以前是硬编码的，v1.9.1 起真读了；代码里的常量只作 fallback。`busy` 与 `idle` 两组缺任意一组，整块配置会退回出厂值——**只改 `rules` 的话，其余三块要一起带上。**

### 6.4 闲逛排程 —— `data/settings/interests.json` 的 `_schedule`

| 字段 | 含义 | 出厂值 |
|---|---|---|
| `windows` | 闲逛窗口（**优先于** `browse.windows`） | noon 11:00–15:00、evening 17:00–21:00 |
| `daily_sessions` | 每天最多几次（0 = 不限） | 2 |
| `focus_per_session` | 一次考察几个焦点 | 1 |
| `max_seeds_per_focus` | 每个焦点最多入池几条 | 2 |
| `focus_cooldown_days` | 同一焦点几天内不重复 | 3 |
| `min_interval_hours` | 两次闲逛的最小间隔 | 4 |

这张表由 `resolveSchedule()` 统一读取：**这里填了就用这里的，没填才落到 `policy.browse.*`。**

### 6.5 组合条目覆盖 —— profile 的 `cordis.patch.yml`

在 `id: heartbeat` 那条的 `config` 里可以覆盖 `intervalMin` / `maxDailySend` / `dataDir` 等；**`0` 表示"不覆盖"**（沿用下层值）。改完需要重载插件——通常就是重启 DSH。

### 6.6 编译期常量（改要重新构建）

这些不值得做成配置项（要么是结构性假设，要么改错会出乱子），但排查问题时要知道它们卡在哪。表中的行号对应本版代码，**行号会随改动漂移，按常量名搜更稳**：

| 常量 | 值 | 位置 |
|---|---|---|
| `BEAT_WATCHDOG_MS` | 45 分钟 | `src/core/orchestrator.ts:192` |
| 四相超时（维护 / 采集 / 闲逛） | 10 / 5 / 15 分钟 | `src/core/orchestrator.ts:204-206` |
| `TURN_TIMEOUT_MS` / `IDLE_WAIT_TIMEOUT_MS` | 3 / 4 分钟 | `src/core/orchestrator.ts:162-163` |
| `HOME_ROTATE_EVENT_COUNT` | 3000 | `src/core/orchestrator.ts:150` |
| `TOKEN_SAVER_IDLE_SECONDS` | 1800 | `src/core/orchestrator.ts:1559` |
| 文件锁：判死 / 等待 | 15 秒 / 3 秒 | `src/core/file-lock.ts` |
| 作息：`TAU_DAYS` / `CELL_EPSILON` / 双门阈值 | 10 天 / 1e-3 / 0.25 与 5% | `src/rhythm/rhythm.ts` |
| 摘要预算 `BUDGET_CHARS` | 3200 字符 | `src/profile/digest.ts` |
| `MAX_CHAT_SEEDS_PER_RUN` | 3 | `src/profile/consolidate.ts` |
| `REPORT_KEEP` | 400 条 | `src/seeds/report.ts` |
| `DESTRUCTIVE_ENDPOINTS` | 六个端点 | `src/rpc.ts` |

---

## 7. 诊断手册

**排障第一现场永远是 `data/logs/heartbeat.jsonl`**：JSONL，一行一个事件，带 UTC 时间戳。先 `Get-Content -Tail 50`，再按事件名筛：

```powershell
# 在仓库根目录执行
Get-Content .\data\logs\heartbeat.jsonl -Tail 200 |
  Select-String 'beat_error|spoke_failed|consolidation_failed|rpc_host_gate_missing'
```

**排查顺序**：有没有心跳（`beat_start`）→ 有没有报错（`beat_error`）→ 为什么没开口（`silent` 的 reason）→ 开口了有没有送到（`spoke` 后面跟没跟 `delivered`）。

### 7.1 事件字典

**启动与装载**

| 事件 | 含义 |
|---|---|
| `plugin_init` | 插件装载完成，记版本与生效配置 |
| `preset_install` | 随包预设的安装结果（`created` / `repaired` / `exists` / `skipped-*`，见 C18） |
| `orchestrator_started` / `orchestrator_disposed` | 编排器起停。**正常**——两条挨着出现说明插件在重载 |
| `rpc_registered` | 数据通道挂上了（带 route） |
| `rpc_host_gate_missing` | 宿主没有闸门钩子，危险端点已降级为拒绝（C24） |
| `tool_policy` | 工具面自检（`restrict=ok` 是预设挂上的判据） |

**每一拍**

| 事件 | 含义 |
|---|---|
| `beat_start` | 一拍开始 |
| `phase_done` | 某一相跑完（`phase`: maintenance / collect / wander / refill_wander） |
| `beat_error` | **拍级异常**——整拍挂了，看 `error` |
| `beat_watchdog` | 超时看门狗强制解锁（上一次拍卡死了 45 分钟以上） |
| `beat_agentless` | 拿不到 agent，本拍只跑维护与采集 |
| `silent` | 本拍不开口，`reason` 写原因（冷静期 / 上限 / 静默时段 / 没有候选…） |

**引擎室与 agent**

| 事件 | 含义 |
|---|---|
| `agent_resume_start` / `agent_create_start` | 正在尝试唤起或新建引擎室会话（长时间没动静时，看这一步有没有对应的成功事件） |
| `agent_reuse_live` / `agent_resume_ok` / `agent_create_ok` | 三种获取路径成功（都带 `model`） |
| `agent_resume_failed` / `agent_acquire_failed` | 获取失败，看 `error` |
| `agent_deferred` | 失败后退避重试（退避 1 → 2 → 4… 分钟，封顶 30） |
| `agent_cache_discarded` | 缓存的 agent 已失效，丢弃 |
| `home_rotate_start` / `_done` / `_archive` / `_failed` | 引擎室轮换的四步 |
| `home_reset` | 正身被移除（设置卡片操作），带 `oldSessionId` |
| `turn_extraction_empty` | 一轮跑完了但没抽到文本 |
| `interval_changed` / `ui_config_set` | 热参数被改（两条挨着出现是好迹象） |

**观察**

| 事件 | 含义 |
|---|---|
| `observed` | 某个绑定会话新增了几条观察（带 `cursor`） |
| `observe_error` | 观察失败（会话读不到等） |
| `cursor_format_discarded` | 游标格式不兼容，已丢弃并全量重扫——**升级后出现一次是正常的** |

**闲逛与素材**

| 事件 | 含义 |
|---|---|
| `wander` / `refill_wander` | 一次闲逛（带 `focus` 与 `registered`＝实际入池条数；0 条要查 C13） |
| `wander_parse_error` | 模型输出解析失败 |
| `seed_added` / `seed_retired` / `seed_restored` / `seed_deleted` / `seed_archive_trimmed` | 素材池的增删与淘汰（`seed_retired` 带 `reason`: completed / pool_cap / consumed / expired / cold_bench） |
| `preference_record_failed` | 素材偏好权重没记上——不影响本次投递，只是少学一次 |

**画像**

| 事件 | 含义 |
|---|---|
| `consolidation` | 一次合并（`applied` / `rejected` / `chatSeeds`） |
| `consolidation_failed` | 合并抛错（收件箱会保留，下次再来） |
| `profile_schema_fallback` | 白名单走了降级（用户层 → 出厂层 → 无白名单） |
| `profile_snapshot` / `profile_snapshot_failed` | journal 快照 |
| `screen_vision` / `idle_fallback` | 视觉识别结果 / 视觉不可用退回窗口标题 |

**表达与投递**

| 事件 | 含义 |
|---|---|
| `spoke` | 说出口了（`text` 存前 80 字，另有 `seeds` / `profile_ids` / `source` / `spoken`） |
| `spoke_fallback` / `spoke_late` / `spoke_deferred` / `spoke_failed` | 兜底 / 迟到确认 / 推迟 / 失败（看 `reason`） |
| `decision_deferred` | 表达决策抛错，这一拍没开口（看 `reason`） |
| `deliver_target_live` / `_resumed` / `_released` | 投递目标的取用与归还；`_released` 是**好迹象**（说明干净还回去了） |
| `deliver_target_resume_failed` / `_release_failed` | 取用或归还失败，看 `error`；偶发无碍，连着出现要查绑定 |
| `delivered` | 落进了用户会话 |
| `report_missing` / `report_read_failed` | 投递包没报账 / 报账读不出来 |
| `expression_dropped` / `_streak` | 输出被判不合格丢弃 / 连续丢弃计数 |
| `status_written` / `status_write_failed` | 状态栏场景写盘 |
| `pulse` / `time_injected` / `statusbar_track` | 探针脉冲 / 时间注入 / 状态栏走了哪条轨 |

**周报与维护**

| 事件 | 含义 |
|---|---|
| `weekly_generated` / `weekly_skipped` / `weekly_llm_failed` / `weekly_failed` | 周报四种结局 |
| `weekly_anchored` / `weekly_anchor_corrupt` | 触发锚点正常 / 损坏（会退回 mtime 兜底） |
| `retention` | 日志裁剪跑了一次 |
| `migrate_export` / `migrate_import` | 换机迁移 |
| `BURN_EVENT` | 焚毁执行完毕 |

### 7.2 症状 → 排查

| 症状 | 先看 | 常见原因 |
|---|---|---|
| 完全没有心跳 | 有没有 `orchestrator_started` | 插件没装进 bundles / 定时器没起 |
| 有 `beat_start` 就没下文 | `beat_error`、`beat_watchdog` | 某一相抛错；或真卡死了（看门狗会救回来） |
| 每拍都 `beat_agentless` | `agent_acquire_failed` 的 `error` | 通常是模型路由没传（C12） |
| 一直 `silent` | 那行的 `reason` | 冷静期 / 每日上限 / 静默时段 / `no candidates`（池子空） |
| 说出口了但用户没收到 | `spoke` 后有没有 `delivered` | 投递目标绑定掉了，或投递 agent 缺模型路由（C12 那个坑） |
| 设置卡片整块不见了 | 浏览器控制台有没有 "Failed to load plugins" | client 模块 id 与包名不一致（C15）；或只是没重启刷新 bundle（C16） |
| 卡片在、保存不生效 | 有没有 `ui_config_set` | 通道没注册（C21）；或值越界被丢弃（§6.1） |
| 状态栏不动 | `status_written` / `statusbar_track` | 状态文件没写；或轨道没钉上 |
| 闲逛永远 0 条 | `wander` 那行的入池数 | 预设没挂 → 模型手上没有 `web_search`（C13） |
| 画像永不更新 | `consolidation` / `consolidation_failed` | 合并没触发（间隔 + 积压两个条件）；或模型输出解析失败 |
| 摘要里作息永远"样本不足" | `profile_rhythm.json` 的 `days` | 样本太少；或峰值没过双门（§4.8） |
| 周报不生成 | `weekly_*` 系列 | 锚点损坏 / 被关 / 模型失败 |
| 时间不注入 | `time_injected` | 节流没过；或状态栏开着（两条轨道二选一） |

### 7.3 诊断 CLI

`dist/cli/index.js` 是独立进程，直接读写 `data/`：

```powershell
node $env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-heartbeat\dist\cli\index.js status
```

| 命令 | 用途 |
|---|---|
| `status` | 当前 dataDir、间隔、每日上限、素材池容量、psy 开关 |
| `sessions` | 列出可绑定的会话 |
| `bind list` / `add` / `remove` | 会话绑定（**删会话后要核对这里的死绑定**） |
| `seeds list` / `add` / `archive` / `restore` / `delete` | 素材池（`--archived` 看归档区） |
| `ledger add` / `list` / `done` / `open` | 账本（**别手改 `ledger.md`**） |
| `profile verify` / `rebuild` / `export` / `wipe` / `snapshot` | 画像（`verify` 只报不修；`rebuild` 原子替换） |
| `weekly` | 手动跑一次周报 |
| `logs` | 审计尾部 |
| `burn` / `burn --yes` / `burn --all` | 焚毁（不带 `--yes` 只是预演） |
| `migrate export` / `import` | 换机迁移 |
| `preset` | 预设的安装与校验 |

> CLI 改不了运行中宿主的内存状态——想改间隔请走设置页。

---

## 8. 安全与隐私模型

### 8.1 信任边界

| 界面 | 谁能碰 | 防线 |
|---|---|---|
| 数据通道 `/api/heartbeat` | 本机浏览器页面 | 宿主 `/api` 的 admission（Host / Origin fence + 浏览器认证 secret）；插件自己**不做鉴权**，只自检闸门在不在（C24） |
| `data/` 下的文件 | 本机、同一 Windows 用户 | DPAPI（CurrentUser 作用域）——换用户或换机器**解不开**，这是特性不是缺陷 |
| 送进模型的文本 | 远端模型服务 | 只送画像条目字段与 ≤1 句观察引语，不送对话原文、不送证据全量 |
| 屏幕内容 | 本地视觉桥（可能再转发给它配置的 provider） | 先解密再用、用完即焚，出去的只有识别摘要 |

**插件不开自己的网络客户端。** 出网只发生在三处：跑模型（宿主执行）、视觉识别（本机 modlens CLI）、闲逛时的 `web_search` 工具（宿主执行）。

### 8.2 什么走加密

**加密（DPAPI）**：素材池与归档、观察收件箱、投递报账、画像视图 / 快照 / 流水、表达记录、闲逛状态、屏幕快照与截图、闸门状态（含正身 id）、周报正文。

**有意保持明文**：

- **账本**——人可读是它的设计目标，加密会毁掉这个价值（可以拿它去提醒用户）；
- **作息直方图**——纯统计，没有内容；
- **状态栏场景文件**——派生态，且**刻意不含任何时间词**（状态栏泄露"现在几点"是个隐私问题）。

### 8.3 加密通道的实现

- `assets/vault.ps1` 做 DPAPI 整文件加解密，输出带 `KHBV1` ASCII 头；**脚本保持 ASCII-only**（PowerShell 5.1 的代码页坑）。
- 加解密是**整文件**的，不是流式——所以没有"追加写"这回事。素材池与收件箱的每次写入都是"解密 → 改 → 重加密 → 原子替换"，这也是它们需要文件锁的原因（§4.1）。
- **明文临时窗只允许出现在 `data/tmp/`**，用完即焚（`burnFileSync`）。别的地方出现明文一律当 bug 处理。

### 8.4 焚毁

焚毁清单在 `src/vault/burn-list.ts`——**单一事实源**。以前它有两份硬编码副本，漂移过，漏掉了文件。

| 模式 | 行为 |
|---|---|
| `burn` | 预演：列出将要删的东西，什么都不动 |
| `burn --yes` | 对每个文件覆写三次再删除 |
| `burn --all` | 连配置与日志一起清 |
| 卸载时的 `--purge` | 复用同一套清除核心 |

焚毁之后 journal 会重建，并写一条 `BURN_EVENT` 记录这次焚毁的范围。

### 8.5 换机迁移的加密封装

`migrate export` 产出一个**口令加密**的容器（`encryptContainer(entries, passphrase)`），导出的密文文件在目标机上用同一口令解开后按原样落盘。导入是两阶段的（先 staged 再改名），失败整体回滚，被替换的文件留 `.bak-migrate-<时间戳>`。

---

## 9. 开发工作流

### 9.1 环境与命令

| 项 | 值 |
|---|---|
| 运行环境 | Windows（`os: ["win32"]`）、Node ≥ 22.19.0、PowerShell 7 |
| 装依赖 | **`npm ci`**——只能用 npm，见下 |
| 构建 | `npm run build`（tsup，产出 `dist/` 与 `.d.ts`） |
| 类型检查 | `npm run typecheck`（`tsc --noEmit`） |
| 测试 | `npm test` |

> **为什么只能用 npm**：本地 `node_modules` 必须保持 npm 的扁平布局。用 pnpm 装出来的是符号链接布局，tsup 生成声明文件时会报
> `TS2742: The inferred type of 'X' cannot be named without a reference to '.pnpm/...'`——
> 类型解析不到真实路径。仓库只保留 `package-lock.json`，`pnpm-lock.yaml` 不入库。

### 9.2 改了源码怎么让它生效

`file:` 协议安装是**目录拷贝**（C10），所以改完源码要做两件事：**构建**，然后**把产物同步进 profile 的那份副本**。

```powershell
$repo = 'C:\code\dsh-heartbeat'
$mir  = "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-heartbeat"

npm run build
robocopy "$repo\dist"   "$mir\dist"   /MIR
robocopy "$repo\config" "$mir\config" /MIR
robocopy "$repo\assets" "$mir\assets" /MIR
Copy-Item "$repo\package.json","$repo\README.md","$repo\client.js" $mir -Force
```

**同步完要核对哈希**（逐个文件比 sha256），然后**重启 DSH**（bundle 是启动时读进内存的，C16）。

改完没反应时，排查顺序永远是：**构建了吗 → 同步了吗 → 重启了吗 → 才是代码对不对**。忘了第二步是最常见的自坑方式。

### 9.3 调试

```powershell
# 用一份单独的 data 目录跑 CLI，不碰正在运行的那份
node dist\cli\index.js status
```

看审计尾部用 §7 开头的命令。调试期间可以把 `intervalMin` 调到 2 分钟看三拍，验完记得调回去。

---

## 10. 测试与 CI

**282 个测试**，跑在 `node:test` + tsx 上，全量约 90 秒。

```powershell
npm test                                          # 全部
node --import tsx --test tests/browse.test.ts     # 单个文件
```

### 10.1 隔离与陷阱

测试通过 `HEARTBEAT_DATA_DIR` 指到临时目录，跑完删掉。沙箱一律用 `tests/_sandbox.ts` 的 `sandboxDir(prefix)` 创建，**不要直接 `fs.mkdtempSync`**——它把目录登记进一个进程级集合，测试进程退出时整批 `rmSync`。「每个用例建一个、文件级 `after` 只删最后一个」的写法会持续泄漏：2026-09-06 到 10-07 之间 `%TEMP%\hb-*` 攒了 16028 个空目录、约 4.4 MB。

**但 `workspace().configDir` 指向仓库里真实的 `config/`**——沙箱只隔离 `data/`。所以：

> 任何写 `config/` 的测试，**必须自己备份并在 `t.after` 里还原**。踩过一次：一个测试往 `config/profile-schema.json` 里写了 `'not json'` 没还原，之后连着两个测试莫名失败。

### 10.2 测试文件的分组

| 组 | 文件 |
|---|---|
| core 地基 | `_sandbox`（沙箱工厂）/ `path-guard` / `atomic-fs` / `audit-log` / `material` / `bindings` |
| 编排与通道 | `orchestrator`（引擎室、游标、文本抽取、正身）/ `rpc`（信封、端点、宿主闸门） |
| 素材与偏好 | `seeds` / `seeds-report`（投递报账）/ `preference` / `burn-list` |
| 画像 | `profile-store` / `profile-flow` / `profile-snapshot` |
| 感知与节奏 | `envpulse` / `gate` / `browse` / `statusbar` / `track` / `vision` |
| 配置 | `config-load` / `ui-config` / `preset-install` / `interests-edit` |
| 会话与轮换 | `home-rotation` / `visible-sessions` |
| 其余 | `vault` / `migrate` / `weekly` / `ledger` / `ledger-tool` / `time-inject` |

**新行为加在哪**：单模块逻辑就近加到同名的文件；跨模块的接线（相顺序、通道、事件流）放 `orchestrator.test.ts` 或 `rpc.test.ts`——这两个文件是回归网，动核心时先看它们有没有兜住。

### 10.3 CI

`.github/workflows/ci.yml`：在 **`windows-latest`** 上跑 `npm ci` → `npm run typecheck` → `npm test`。

选 Windows 是因为插件本身 `os: ["win32"]`、加密依赖 DPAPI、探针是 PowerShell 脚本——换 Linux 跑等于测了个别的东西。

---

## 11. 发布前检查清单

1. `package.json` 的 `version` 递增——**最容易忘的一步**；
2. `npm run typecheck` 干净；
3. `npm test` 全绿；
4. `npm run build` 成功，`dist/` 与 `.d.ts` 已重建；
5. README 的**版本兼容表**加上新版本行，**版本更新章节**补一条；
6. `docs/releases/v<新版本>.md` 建一份（更早的历史小节已归档在同目录的 `legacy-changelog.md`）；
7. **同步镜像 + 重启 + 跑够三拍**，确认没有 `beat_error` / `spoke_failed`；
8. `npm publish`；
9. 装机或回滚之后，**必查三件事**：

   - [ ] profile 的 `dsh.profile.bundles` 里**有 `dsh-heartbeat`**（只加 dependencies 的话卡片会整块消失）；
   - [ ] `dataDir` **钉在预期位置**（钉错了会新建一个空引擎室往里投递，症状是"绑定和素材全没了"）；
   - [ ] 镜像目录里**没有 `data/` 空壳残留**。

---

## 12. 已知限制与后续方向

### 12.1 明摆着的限制

- **加密存储没有真正的"追加"**：素材池、收件箱、报账每次写入都是"整文件解密 → 改 → 重新加密 → 原子替换"。跨进程并发已经用文件锁兜住，但文件越大越慢。真正的 append-only 存储是 **v2.0 的主要欠账**。
- **只跑 Windows**：DPAPI、PowerShell 探针、`os: ["win32"]`。换平台要同时换掉加密后端与这三个探针脚本。
- **单机单用户**：正身是一个本机会话 id，没有多设备 / 多用户的概念；换机器靠迁移包。
- **状态栏依赖宿主能力**：读得到宿主系统提示的模型走"系统 section"那条轨，其余模型只能走"消息尾部追加"，效果弱一档（§4.10）。
- **周报只回顾不预测**：不做计划、不排日程。
- **没有 lint / formatter 工具链**：只有类型检查与测试，这是有意的轻量取舍（§10）。
- **家轮换会丢一点上下文**：轮换出来的是全新会话，归档的旧会话不会被读回——引擎室不爱回忆太久以前的事。
- **素材去重是启发式的**：同题合并看 topic 与文本相似度，换种说法的重复可能并存。
- **纯文本假定 UTF-8**：Windows 记事本打开账本可能显示异常，用 VS Code 之类的编辑器看更稳。
- **墙钟窗口按进程时区判定**：安静时段与闲逛窗口都是"钟点"窗口，用进程本地时区解析（`minutesOfDay()` 取 `getHours()`）。本机部署下进程时区即用户时区，符合预期；但把宿主放进 UTC 容器这类环境里，窗口会整体偏移。实现本身没暴露时区参数，测试已把 `tests/gate.test.ts` 与 `tests/browse.test.ts` 钉死为 `Asia/Shanghai`。

### 12.2 后续方向

| 方向 | 说明 |
|---|---|
| append-only 存储 | 替掉"整文件重写 + 文件锁"，素材池与收件箱是主要受益者 |
| 跨平台 | 加密与探针两层都要抽象 |
| 更细的素材去重 | 语义级，而不是字符串级 |

---

## 13. 附：随仓库的修复脚本

`scripts/` 下有一次性与救火用的脚本，**不进构建产物**，只在本仓库里跑：

| 脚本 | 干什么 | 怎么用 |
|---|---|---|
| `repair-session.mjs` | 体检 / 修复单个会话文件 | `node scripts/repair-session.mjs inspect <会话目录>` 先只读体检，确认没问题再用 `fix <会话目录>`（修复前会备份） |
| `repair-v0-members.mjs` | 扫全部会话，补历史代（v0）缺失的成员记录 | 直接跑 = 预检（只读）；`fix` = 备份 + 修复 + 复核；`--root <目录>` 换扫描根（默认 `~/.dsh/sessions`） |
| `migrate-v1-seeds.mjs` | 把 v1 时代的素材池迁到现在的格式 | 一次性脚本 |

**什么时候需要它们**：宿主加载会话时报 `session event at seq N lacks an identified message`——说明某条消息是手写进会话的、缺了 id（C5 的反面教材）。先 `inspect` 看清是哪一条，再 `fix`。

宿主升级到 0.1.5 以后，会话目录会变成**多代文件布局**（C20），`repair-v0-members.mjs` 只应该碰 v0 那一代。

---

## 14. 变更日志

**当前版本 v1.9.1**（`package.json` 里还写着 1.9.0，正式发版时按 §11 第 1 步递增）——在 v1.9.0 之上做的一次代码审查修复（86 项发现，分五批落地：静默失败类 → 数据完整性 → 边界与体验 → 工程基建 → 结构性重构）。

历史版本的详细记录在 **`docs/releases/`**：v1.6.2 起每版一份，更早的合并进同目录的 `legacy-changelog.md`；README 的"版本更新"章节保留 v1.5 起的关键改动。

**v1.9.1 之前的整份设计文档**（旧结构，模块划分与参数位置都有变化）归档在 `docs/DESIGN-v1.9.0-and-earlier.md`。

**这个文件什么时候要改**：结构性变更（模块拆分、宿主契约变化、参数位置移动、新增数据文件）必须同步改这里；只改行为、不动结构的补丁，更新 README 与 `docs/releases/` 就够了。
