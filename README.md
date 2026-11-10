# dsh-heartbeat

> 让 DeepSeek Harness 的 agent 拥有持续存在感的心跳插件：她按节律自己醒来，感知你的忙闲、按兴趣或你的 B 站足迹攒点话头、把没说完的心事带过下一拍，再按分寸决定要不要开口。

[![host](https://img.shields.io/badge/DSH-0.2.0--rc.1%20–%200.2.2--rc.1-blue)](https://github.com/deepseek-ai/deepseek-harness)
[![npm](https://img.shields.io/npm/v/@kanadego/dsh-heartbeat)](https://www.npmjs.com/package/@kanadego/dsh-heartbeat)
[![downloads](https://img.shields.io/npm/dm/@kanadego/dsh-heartbeat)](https://www.npmjs.com/package/@kanadego/dsh-heartbeat)
[![platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-lightgrey)]()
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

---

## 它是做什么的

普通的对话里，你不说话，agent 就永远停在上一句。`dsh-heartbeat` 给她装上一颗按节律跳动的心脏（默认 60 分钟一跳，带 ±20% 随机浮动）：

1. **自己找话头**：平时按兴趣词自己上网闲逛（`web_search`），或者看一眼你最近在 B 站看什么视频，也可以从你们之前的聊天里捞还没聊透的话题，攒进素材池。
2. **先看你在不在忙**：每次想开口前，先过一道纯代码闸门——深夜静默窗、专注模式、你正在忙、今日次数满了、离上次说话太近，命中任何一条就安静退下，**后续一分钱 token 都不花**。
3. **进你的房间说话**：闸门放行后，后台把候选素材压成简短的备料包，投进你绑定的常用会话。真正开口的是你那个会话里的 agent——她结合你们当下的气氛决定说哪条、或者干脆不说；没说完的心事可以留进**心事匣**带到下一跳，想记下的句子和待办分别收进**摘抄本**与**账本**。

```
维护 → 采集(截图/观察/B站) → 闲逛 → 闸门 ──→ 反刍备料 → 投递到绑定会话 → 留痕
                                      │
                                 判「别说」→ 当场结束（不调模型）
```

## 快速开始

```powershell
# 从 npm 安装（推荐）
npm install @kanadego/dsh-heartbeat

# 或通过 DSH CLI 安装
dsh plugin --profile web add @kanadego/dsh-heartbeat
```

重启 DSH 即生效。插件会自动注册心跳专用预设、建立数据目录 `~/.dsh/heartbeat-data`（升级或卸载都不会碰它）。

接下来只需要去 **插件管理 → dsh-heartbeat → 配置**，在「会话」页把你常聊的那个会话勾上**投递**和**观察**，就全齐了。

> **平台差异**：Windows 支持全部能力；Linux / macOS 下心跳、面板、素材与三本本子照常运行，仅依赖系统的截屏、忙闲检测与桌面通知自动降级跳过（且主密钥以 `0600` 权限文件存储，数据目录不跨系统混用）。

## 面板一览

日常操作全在 Web 面板的 7 个标签页里，无需敲命令：

| 心跳状态                               | 会话绑定                                 |
| -------------------------------------- | ---------------------------------------- |
| ![](docs/screenshots/panel-status.png) | ![](docs/screenshots/panel-sessions.png) |

| 素材池                                | 用户画像（只读）                        |
| ------------------------------------- | --------------------------------------- |
| ![](docs/screenshots/panel-seeds.png) | ![](docs/screenshots/panel-profile.png) |

<details>
<summary><b>展开看其余页面：兴趣范围 / 周报 / 设置</b></summary>

| 兴趣范围                                  | 周报                                   |
| ----------------------------------------- | -------------------------------------- |
| ![](docs/screenshots/panel-interests.png) | ![](docs/screenshots/panel-weekly.png) |

<img src="docs/screenshots/panel-settings.png" width="620" alt="设置页">

</details>

- **状态**：六格速览（上次心跳、版本、今日表达进度、时间注入、上次结果、此刻动态）。
- **会话**：独立控制每个会话的「投递」（去哪个房间说话）和「观察」（从哪个房间了解你）。
- **素材**：查看、过滤、归档话题与聊天素材；可直接点**扫码登录 B 站**，把观看历史接入素材源。
- **兴趣**：配置闲逛搜索的焦点词与浏览时段。
- **画像**：只读查看四个分区（兴趣 / 进行中 / 沟通偏好 / 心理），支持一键导出 Markdown。
- **周报**：每 7 天自动生成一份平实记录，复盘这周的表达、静默与新认识。
- **设置**：调整心跳间隔、静默时段、专注模式（一键暂停 N 分钟，到点自动恢复）、换机加密迁移，以及打开账本和摘抄本。

## 给 Agent 的四个工具

插件向你的日常会话注册了 4 个轻量工具，agent 会自己调用，不需要你手动下令：

| 工具                  | 文件与存储                       | 用来干什么                                                             |
| --------------------- | -------------------------------- | ---------------------------------------------------------------------- |
| `notepad`（心事匣）   | `data/notepad.json`（加密）      | 只有一格的便签，把这跳没说完的话留给下一跳的自己；写新盖旧，不写自动清 |
| `ledger`（账本）      | `data/ledger.md`（明文可手编）   | 记待办和承诺，聊到计划自己记上、做完自己勾掉                           |
| `excerpt`（摘抄本）   | `data/excerpts.md`（明文可手编） | 抄下你说过的话或想留住的小事，只增不减（除非主动抹掉）                 |
| `seed_report`（报账） | `data/seed_report.jsonl`         | 每次收到心跳投递包后报一次账（用了哪条素材 / 说了真心话 / 决定沉默）   |

## 数据与隐私

所有运行数据都收在 `~/.dsh/heartbeat-data`（也可通过插件配置 `dataDir` 或环境变量 `HEARTBEAT_DATA_DIR` 改位置）：

- **敏感数据整文件加密**：素材池（`seeds.jsonl`）、用户画像（`profile.*`）、心事匣、周报、屏幕快照与 B 站登录态均以 **AES-256-GCM** 加密落盘；主密钥 `data/vault.key` 在 Windows 上由系统 **DPAPI（仅当前账户可解）** 保护。
- **你写的东西保持明文**：设置项（`data/settings/`）、账本（`ledger.md`）、摘抄本（`excerpts.md`）和审计日志（`data/logs/heartbeat.jsonl`）直接用编辑器就能翻看。
- **隐私不出界**：全屏截图仅在视觉识别成功时提取一句状态摘要（「他此刻大概在…」），识别失败时画面与窗口标题绝不进入任何提示词；引擎室内部轮次受工具白名单硬限制。
- **换机与焚毁**：换电脑可在面板「设置 → 换机迁移」用口令打包导出、新机导入自动重加密；想彻底清空可跑 CLI `burn --yes`（三次覆写后删除运行时数据）。

<details>
<summary><b>展开查看：CLI 命令速查与常见排错</b></summary>

### CLI 命令

日常用面板即可；脚本或排障可调 `node <插件目录>/dist/cli/index.js <命令>`：

| 类别       | 常用命令                                                                                                   |
| ---------- | ---------------------------------------------------------------------------------------------------------- |
| 状态与节律 | `status`（策略总览） · `focus [分钟]` / `focus off`（开启或关闭专注模式）                                  |
| 会话绑定   | `sessions list` · `bind list` · `bind add <id> [--observe]` · `bind remove <id>`                           |
| 素材与闲逛 | `seeds list [--archived]` · `seeds add <text>` · `seeds gc` · `browse status` · `bili login`               |
| 账本与摘抄 | `ledger list [--pending]` / `ledger open` · `excerpt list [n]` / `excerpt open`                            |
| 画像与周报 | `profile list` / `profile export` / `profile verify` / `profile rebuild` · `weekly show`                   |
| 维护与安全 | `preset status` / `preset install` · `migrate export` / `import` · `vault status` · `burn [--yes] [--all]` |

### 常见排错

第一现场永远是 `data/logs/heartbeat.jsonl`，每一跳停在哪、为什么沉默都有记录：

- **一直沉默不说话**：看日志里 `silent` 行的 `reason`——常见是处于夜间静默窗、今日额度已满、冷却未到，或开了「节省 token 模式」且你离开电脑超过 30 分钟（`reason=token-saver`，一回来自动恢复）。
- **闲逛秒结束、报 `unknown global tool "web_search"`**：心跳预设没挂上，跑一次 `preset install` 重启即可。
- **投递没带「他此刻大概在…」**：未配置视觉辅助插件（如 ModLens）或网络超时，按隐私设计自动跳过画面信息，不影响心跳投递。
- **侧栏某个会话行突然不见了**：心跳刚往那个没打开的会话投递完、释放临时实例的正常现象，**刷新网页就回来**，内容零损失。

</details>

## 版本兼容与卸载

| 插件版本                    | 适配的 DSH 版本                 |
| --------------------------- | ------------------------------- |
| **v2.2.0 – v2.2.1**（当前） | `0.2.0-rc.1` – `0.2.2-rc.1`     |
| v2.1.1 – v2.1.2             | `0.2.0-rc.1` – `0.2.1-rc.5`     |
| v2.0.0 – v2.0.1             | `0.2.0-rc.1` – `0.2.1-rc.2`     |
| v1.x 历史版本               | 见 [CHANGELOG.md](CHANGELOG.md) |

卸载执行 `dsh plugin --profile web remove @kanadego/dsh-heartbeat`，只拆插件本体，不动 `heartbeat-data` 目录。

## 版本更新

<details open>
<summary><b>v2.2.x</b></summary>

### v2.2.1 · 2026-11-10（引擎室归档自愈 · 类型声明修复）

- **房间被归档也能自己换回来**：DSH 0.2.2 会把长期不用的会话归档，引擎室如果正好在名单里，整跳都不出声、也不会自己恢复。现在发现房间被归档就自动换一个新会话，旧房间原样留着、不删任何内容。
- **类型声明恢复完整**：上一版发布包里 `index.d.ts` 因为构建期路径依赖没有完整生成，这版修好了——用 TypeScript 接这个包的项目不会再丢类型。

### v2.2.0 · 2026-11-09（B 站素材源 · 扫码登录 · 静默时段面板 · 兼容 DSH 0.2.2）

- **B 站观看历史进素材池**：开启后每 2 小时拉一次观看历史，挑真正在看的（短视频、直播间、刚点开就划走的都不要），变成「他刚看完《…》」「《…》他看到第 12 分钟」这样的素材。同一个视频一天内不会重复进池，素材两天后自动过期。账号只读，不点赞、不评论、不改任何东西。
- **扫码登录与面板卡片**：素材 tab 里直接点「扫码登录」弹出二维码（或终端跑 `heartbeat bili login`），手机 B 站 App 扫完自动落盘加密保存。
- **静默时段能在面板改**：设置里新增起止时间框，保存立刻生效，不用重启。
- **投递不再对着空气说话**：自动跳过已归档的投递目标会话。
- **静默原因与时间注入修正**：细分被拦截 / 没吐字 / 英文输出三种日志原因；时间注入不再漏进引擎室轮次；修复 Linux 下打开账本/摘抄本的平台命令问题；适配 DSH 0.2.2 工具声明下发时机。

</details>

> 更早的版本记录见 [CHANGELOG.md](CHANGELOG.md)，架构细节与宿主契约备忘见 [DESIGN.md](DESIGN.md)。致谢 [tomsteve1102/presence-watch](https://github.com/tomsteve1102/presence-watch) 与前代项目 [kohaku-heartbeat](https://github.com/Kanadego/kohaku-heartbeat)。

## 下载量

<img src="docs/assets/npm-downloads.svg" alt="npm daily downloads" width="820">
