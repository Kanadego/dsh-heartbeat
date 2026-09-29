# v1.7.2

**声明适配 DSH `0.2.0-rc.1`，无行为改动**

**附带修复**：宿主关闭（含桌面端更新）时取消进行中的一跳——此前更新若恰逢一跳在跑，会因宿主等不到优雅收尾而中止（"Host did not complete graceful task teardown"）。

`0.2.0-rc.1` 发布后，宿主按插件声明的 peerDependencies 做兼容性检查时会把本插件**整包跳过**：`^0.1.x` 的 caret 范围上限是 `<0.2.0-0`，把 `0.2.0` 的预发布版也排除了。本版把版本范围加入 `^0.2.0-rc.1`：

- `@deepseek-ai/dsh-llm`（peerDependencies）
- `@deepseek-ai/dsh-settings`（dependencies）

老宿主（`0.1.2-rc.1` / `0.1.5-rc.2` / `0.1.7-rc.x`）不受影响，`0.2.0` 正式版也在覆盖内。

## 适配依据

对 `0.1.7-rc.2` ↔ `0.2.0-rc.1` 逐包源码比对，心跳依赖的全部宿主接口**运行时代码零变化**，无需行为改动：

- `dsh-llm`：`createUserMessage` 与自有消息来源标记（byte 级一致）
- `dsh-agent` / `dsh-session`：`agent/inbox/spliced`、`turn/end` 事件原样保留
- `dsh-app-boot`：profile 加载与 patch 校验机制不变
- `dsh-client-modules`：客户端脚本投递机制不变
- `dsh-settings`：API 不变（心跳本就带三代 API 兼容层）

## 说明

- 升级后**重启 DSH** 即可。
- ⚠️ `0.2.0` 生态提示：dshmarket、soul-md 等多数第三方插件在 `0.2.0-rc.1` 上会被同机制跳过，升级宿主前先确认插件已发适配版。

安装/升级方式不变（npm 或 GitHub release）。
