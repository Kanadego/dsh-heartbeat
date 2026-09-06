# dsh-heartbeat

> 让 DeepSeek Harness Agent 拥有持续存在感与自主生活流的心跳插件。
> 她能自己醒来、维护自己的记忆与画像、感知环境与忙闲、按分寸决定是否开口——沉默是常态。

[![host](https://img.shields.io/badge/DSH-0.1.1--rc.2-blue)](https://github.com/deepseek-ai/deepseek-harness)
[![platform](https://img.shields.io/badge/platform-Windows-lightgrey)]()
[![license](https://img.shields.io/badge/license-MIT-green)]()

---

## 这是什么

一个 DeepSeek Harness 插件：定时唤醒 agent（默认 20 分钟一跳），按七相循环运行——

```
维护（素材池 gc / 日志保留 / 画像合并）→ 采集（屏幕 / 温度计 / 追踪）
→ 闲逛（按兴趣搜网，结果代码入池）→ 闸门（静默窗/忙时/每日上限/冷却）
→ Digest（处境+画像+素材 现拼）→ 聚焦推理（说不说/说什么/怎么说）
→ 投递（专用心跳会话 + toast 提示）→ 留痕（每跳可审计）
```

核心设计（详见 [DESIGN.md](DESIGN.md)）：

- **沉默是常态**：闸门前置，SILENT 轮零模型调用；"没有真实来处的话，一句都别说"
- **素材池是缓存不是记忆**：TTL/消费退休/冷板凳/容量挤出四条确定性淘汰，画像单向隔离
- **用户画像**：本地结构化档案（兴趣/项目/沟通偏好/心理基线），bi-temporal + 来源强制，
  stable/volatile 分档（稳定特质不因时间遗忘），journal 单一权威可重建
- **分寸闸门**：独立层、可审计——静默窗/忙时窗口类别/每日上限/冷却/在场联动
- **隐私**：全部本地；敏感文件 DPAPI（CurrentUser）加密；一键焚毁；路径守卫 + 模型工具硬限制

## 安装 / 卸载

```powershell
# 安装（构建产物随包分发，无需本地构建）
dsh plugin --profile web add file:D:/path/to/dsh-heartbeat

# 卸载（插件本体干净移除；data/ 用户数据默认保留，--purge 才连删）
dsh plugin --profile web remove dsh-heartbeat
```

重启 DSH 后生效。插件自动创建**专用心跳会话**并开始按节律运行。

## 使用

日常无需任何操作。想看Agent的动向：

```powershell
node <插件目录>/dist/cli/index.js status        # 运行状态摘要
node <插件目录>/dist/cli/index.js gate status   # 今日表达余量/冷却/静默窗
node <插件目录>/dist/cli/index.js seeds stats   # 素材池
node <插件目录>/dist/cli/index.js profile export  # 画像解密导出（人可审）
```

**设置页 → 心跳** 卡片：心跳间隔、每日表达上限（保存后重启生效）。

**主动投递与观察**（把心跳消息送进你常用的会话 / 让会话内容变成画像素材）：

```powershell
node dist/cli/index.js sessions list              # 枚举会话 id
node dist/cli/index.js bind add session-xxxx      # 绑定投递（琥珀开口也会说到那里）
node dist/cli/index.js bind add session-xxxx --observe   # 绑定观察（对话变画像素材）
node dist/cli/index.js bind remove session-xxxx   # 解绑
```

## 配置

三层优先级（低→高）：**出厂默认**（包内 `config/`，只读）→ **用户文件层**（`data/settings/policy.json`，deepMerge）→ **设置页**（间隔/上限，即时生效间隔重排定时器）。

| 常用参数 | 位置 |
|---|---|
| 静默时段 / 冷却 / 素材池上限 / TTL 阶梯 / 画像分区容量 | `data/settings/policy.json`（只写要覆盖的子键） |
| 画像能记什么（隐私白名单） | `data/settings/profile-schema.json` |
| 追踪哪些 npm/GitHub / 兴趣种子 | `config/watchlist.json`、`config/interests.json`（用户层同名文件整体替换） |
| 忙闲类别表（哪些进程算忙） | `config/busy-rules.json` |

完整参数表与生效方式见 [DESIGN.md §6](DESIGN.md)。

## 数据与隐私

- 全部运行数据在 `data/`（唯一可写目录，路径守卫强制）：清单与格式见 [DESIGN.md §5](DESIGN.md)
- 加密（DPAPI，CurrentUser，防他人/他机/误同步，不防同账户恶意软件）：
  素材池、屏幕快照、表达记录、画像三件套、浏览流状态
- 明文（透明度设计）：账本、作息聚合、审计日志（不含敏感原文）
- 模型出库仅限合并裁决的最小必要摘要（不含 psy、不含原文），知情同意设计
- 一键焚毁：`node dist/cli/index.js burn`（预演）→ `burn --yes`（覆写 x3 + 删除，设置保留）；`--all` 连设置归零

## 诊断

第一现场：`data/logs/heartbeat.jsonl`（每跳留痕，silent 必带原因）。
事件字典、症状→排查表、宿主契约备忘见 [DESIGN.md §7](DESIGN.md)；画像完整性用 `profile verify`。

## 开发

```powershell
npm install
npm run build        # tsup → dist/
npm run typecheck
npm test             # 88 个单元测试（判定逻辑全注入时间，无 sleep）
```

工程细节（宿主契约实测备忘、模块实现、踩坑记录）见 [DESIGN.md](DESIGN.md)。

## 致谢

- [tomsteve1102/presence-watch](https://github.com/tomsteve1102/presence-watch) — 讨论起点与闸门思想
- 前代项目 [kohaku-heartbeat](https://github.com/Kanadego/kohaku-heartbeat) — v1 脚本外挂形态，本项目为其插件化重构

## 许可

[MIT](LICENSE)
