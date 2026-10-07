# v1.7.1

**修复：升级 DSH 0.1.7 后「心跳模式」预设静默失效**

`0.1.7` 起宿主不再从文件系统用户目录（`~/.dsh/.agent-presets`）加载 agent 预设，旧的安装方式失效，症状是：

- 审计出现 `preset_install skipped-no-root`
- 界面报 `Unknown agent preset: heartbeat`
- 闲逛轮报 `tools.restrict unknown web_search`——预设没挂上，心跳 agent 成了"裸 agent"，连 `web_search` 都看不见

现在改为在插件的安装清单里**声明式**注册预设（与官方 standard 预设同机制），重启即注册，「心跳模式」重新出现在 Agent 预设页。`0.1.5` 及更早的宿主仍走原来的文件安装路径，两边都不断。

## 说明

- 预设内容与原先一致：上下文折叠组 + 唯一模型工具 `web_search`（不抓正文）；**无 persona 行**——部署人格与心跳提示词已足够，不能被 "You are a coding agent" 盖掉。
- 升级后**重启 DSH** 即可，无需手动操作。
- 本版读取的是内置声明；若 `~/.dsh/.agent-presets` 下那份是你手改过的，它不再生效。

安装/升级方式不变（npm 或 GitHub release）。
