# 网易云音乐 / B 站「个人记录」数据接入调研

> 背景：心跳 2.1.0 第④个功能（闲逛时能看听歌记录 / 视频观看记录，账本 #f575a6）需要评估两个平台的数据可得性。
> 本文档只做调研结论，不含任何代码改动。调研日期：2026-11-08。
> 调研纪律：未登录任何账号、未写入任何数据、未触碰用户凭据文件；对公开接口只做了无凭据的只读试探。

---

## 目录

- 一、网易云音乐：三条路
  - 1.1 官方开放平台 API
  - 1.2 第三方开源服务端（NeteaseCloudMusicApi 系）
  - 1.3 网页接口直连（weapi/eapi）
- 二、哔哩哔哩：两条路
  - 2.1 官方开放平台（open.bilibili.com）
  - 2.2 网页接口 + SESSDATA（含本机凭据复用评估）
- 三、对比表与明确结论
- 四、给心跳的用法建议（素材候选 + 频率）

---

## 一、网易云音乐：三条路

### 1.1 官方开放平台 API —— 结论：对个人开发者此路不通

**入驻资质**
- 官方平台存在「个人接入指南」分类，个人入驻门槛仅要求：成年实名用户；同一用户只能选择一种身份类型入驻（个人或厂商二选一）。出处：`https://developer.music.163.com/st/developer/document?docId=c5cb8108c73b42c8bec8869b26a15738`（个人接入指南 → 使用引导 → 入驻条件）。
- **但个人场景不能用开放平台 API**。官方 FAQ 原文：「个人开发者能否接入开放平台 API？→ 个人场景：暂不支持，仅可使用 ncm-cli；厂商入驻：联系云音乐商务」「针对个人 demo 只有 CLI 吗？→ 是的，目前针对个人应用仅提供 ncm-cli」。出处：同上文档站 → 个人接入指南 → 常见问题 FAQ（账号与应用管理 / OpenClaw 集成两节）。
- 开放平台 API 本身面向厂商/合作方，能力为歌单、个性化推荐、评论、播客等（面向音箱、车机、IoT 设备）。出处：文档站「厂商接入指南 → 平台概述」页。

**ncm-cli（个人唯一官方通道）的现状**
- 安装：`npm install -g @music163/ncm-cli`；需先完成个人入驻获取 App ID / Private Key（`ncm-cli configure`），再 `ncm-cli login` 用网易云音乐 App 扫码授权。出处：文档站「个人接入指南 → 技术指南 → 网易云音乐 CLI」页。
- 命令参考覆盖：search（搜索）、play/pause/next（播放控制）、queue（播放队列）、`recommend daily`（每日推荐）、tui（终端播放器）。出处：同上「CLI 命令参考」。
- **关键缺口：命令参考中没有读取「最近播放 / 听歌排行 / 红心歌单」的命令**。文档开头宣称 CLI 具备「听歌数据采集」能力（出处：同上 CLI 简介段落），但该能力的具体命令未出现在文档中——「CLI 能否读取用户听歌记录」目前**未证实**，需实际安装 `ncm-cli -h` 验证（验证需要用户扫码登录，本调研未执行）。
- 限流：官方文档未公布 ncm-cli 的调用配额数值——**未证实**（厂商路线文档提到「每人当天接口调用次数有上限，具体可见应用详情里剩余次数」，个人 CLI 通道是否有同样配额未证实）。
- 风险：CLI 必须登录才能使用；受版权限制并非所有歌曲可播（出处：FAQ 音乐播放与功能节）。

**小结**：官方路线上，「获取听歌记录」这一目标既不能通过开放平台 API 达成（个人场景明确暂不支持），ncm-cli 文档中也未见对应命令。**判定：此路对本功能不可行，无需再投入。**

### 1.2 第三方开源服务端 —— 结论：可行，推荐路线

**项目状态**
- 原版 `Binaryify/NeteaseCloudMusicApi` 已于 2024 年初因版权争议清空仓库停更（README 仅留「保护版权，此仓库不再维护」），GitHub API 显示 `archived: true`、最后 push 2024-02-28、30,224 stars。出处：GitHub API `repos/Binaryify/NeteaseCloudMusicApi` 查询结果（2026-11-08 实测）；报道见仓库 README 所引新闻链接。
- 社区续作 `NeteaseCloudMusicApiEnhanced/api-enhanced` 仍在活跃维护：2,187 stars、最后 push 2026-11-06（调研前两天）、未归档。出处：GitHub API `repos/NeteaseCloudMusicApiEnhanced/api-enhanced` 查询结果（2026-11-08 实测）。文档站：https://docs-neteasecloudmusicapi.focalors.ltd 。

**鉴权方式**（出处：api-enhanced 仓库 `module/` 目录源码，2026-11-08 实测）
- 扫码登录：`login_qr_key` → `login_qr_create`（生成二维码，App 扫码）→ `login_qr_check`（轮询确认）→ 拿到 MUSIC_U cookie。
- 手机号登录：`login_cellphone`（手机号 + 密码/验证码）。
- cookie 登录：直接把已有 cookie 传给任意接口（`query.cookie`），适合「用户在浏览器导出一次 cookie」的低配合方案。
- cookie 续期：`login_refresh`。MUSIC_U cookie 实际有效期官方未公布，社区经验为数月级——**未证实**。

**能拿到什么数据**（出处：api-enhanced `module/` 源码逐文件核对，2026-11-08）
| 目标数据 | 接口 | 上游真实路径 | 关键参数 |
|---|---|---|---|
| 听歌排行（最符合"最近在听"） | `/user/record` | `POST /api/v1/play/record`（weapi） | `uid` + `type`（1=最近一周，0=所有时间） |
| 最近听歌列表 | `/recent/listen/list` 系 | `POST /api/pc/recent/listen/list` | 无 |
| 我喜欢的音乐（红心歌单曲 ID 列表） | `/likelist` | `POST /api/song/like/get` | `uid` |
| 用户歌单 / 每日推荐等 | `/user/playlist` 等 | 略 | 见仓库文档 |

- 注意：`/user/record`（听歌排行）返回的是歌曲 + 播放次数（playCount），「最近在听」语义优先用 `/api/pc/recent/listen/list`（按时间倒序的最近收听列表）。

**部署成本**
- 一个 Node.js 进程（Node ≥14），`npm install` 后 `node app.js` 即起本机 HTTP 服务；内置 vercel.json 可零成本部署 Vercel；支持 Docker。对本机单用户场景，最合理是随主程序同机跑一个本地服务。出处：仓库 README（api-enhanced，2026-11-08 实测）。

**限流**
- 自建服务无第三方配额；上游（网易服务器）未公布任何公开限流数值——**未证实**。社区经验为低频只读调用基本无感知，高频调用可能触发风控。

**风险**
- 非官方逆向接口：2024 年网易已对原项目发起下架维权，api-enhanced 仍存活但同一法律风险客观存在；接口路径可能随客户端改版失效。
- 服务端持有用户 cookie：必须仅本机/单用户使用，cookie 与数据不得外传、不得入库上传（脱敏纪律）。

### 1.3 网页接口直连（weapi/eapi）—— 结论：技术可行，但没必要单独维护

**加密门槛**（出处：api-enhanced `util/crypto.js` 源码，2026-11-08 实测）
- weapi：两轮 AES-128-ECB。第一轮用固定 key `0CoJUm6Qyw8W8jud` + 固定 iv `0102030405060708`；第二轮用随机 16 字节 secretKey；secretKey 再经 RSA 公钥（固定内置公钥）加密。linuxapi 则用 key `rFgB&h#%2?^eDg:Q`。
- eapi：请求路径 + 参数 md5 摘要用固定 key `e82ckenh8dichen8` 做 AES-128-ECB 拼接。
- **现成 JS 实现可直接搬**：上述算法全部实现在 api-enhanced 的 `util/crypto.js`（依赖 crypto-js / node-forge），含完整密钥常量，无需自己逆向。出处：仓库源码实测。

**判定**：既然 1.2 已提供现成服务端（其内部就是调用同一套加密直连网易），单独维护一套直连实现只增加维护面，没有额外收益。**仅当 1.2 被下架不可用时，才把 crypto.js 搬出来做最小直连**。风险与 1.2 相同（逆向接口法律风险 + 算法随版本变化），且没有社区修复兜底。

---

## 二、哔哩哔哩：两条路

### 2.1 官方开放平台 —— 结论：个人开发者拿不到，此路不通

**入驻资质**
- 入驻主体为中国内地合法合规运营主体（企业、党政机关、事业单位、社会组织等）；企业认证规则明确**暂不支持个体工商户 / 个人独资企业**认证；需营业执照扫描件 + 加盖公章的《入驻承诺函》。出处：open.bilibili.com 官网入驻流程页与其企业认证规则页（2026-11-08 检索）。
- **个人开发者暂不支持入驻**（2024 年以来的社区入驻攻略与上述官方规则一致）。出处：https://open.bilibili.com 及检索到的入驻攻略；官方页面本身未写明支持个人。

**OAuth2 与 scope**
- 官方 OAuth2：授权码模式，`access_token` 有效期 15 天、`refresh_token` 30 天，过期可用 refresh_token 换新。出处：哔哩哔哩开放平台 OAuth 2.0 接入文档（bilibili.apifox.cn/doc-7492454 镜像，2026-11-08 检索）。
- scope 是否包含「观看历史 / 收藏」：官方公开 scope 列表围绕账号信息、稿件/内容生产与数据分发，**未公开列出观看历史类 scope**——「开放平台能否授权读取用户观看历史」**未证实**，且以个人身份连入驻环节都过不了，本调研不再深入。
- 限流：开放平台接口配额官方未公开——**未证实**。
- 风险：此路对个人不可达（入驻门槛即拦截），无继续投入价值；若未来以企业主体入驻，观看历史类数据是否可授权仍属未证实。

### 2.2 网页接口 + SESSDATA —— 结论：可行，推荐路线（含本机凭据复用评估）

**核心接口**（出处：bilibili-API-collect 文档 `docs/historytoview/history.md`，经存档 fork `rinnein/bilibili-API-collect`（116 stars，master 分支同步至 2026-01-25 关停前）读取；原仓库 SocialSisterYi/bilibili-API-collect 于 2026-01-28 因 B 站律师函清空关停，报道见新浪财经 2026-01-29）

- `GET https://api.bilibili.com/x/web-interface/history/cursor`
- 认证：Cookie（SESSDATA）。无 cookie 实测返回 `{"code":-101,"message":"账号未登录","ttl":1}`（本机 2026-11-08 实测）。
- 参数：`ps`（每页项数，默认 20 最大 30）、`type`（all/archive/live/article 筛选）、翻页游标三元组 `max` + `business` + `view_at`（用上一次响应里 `data.cursor` 的值回传，类似链表 next 指针）。
- 返回字段（每条记录）：`title`（标题）、`author_name` / `author_mid`（UP 主）、`view_at`（观看时间戳）、`progress`（看到第几秒）、`duration`（总时长）、`show_title`（分 P 标题）、`history.{bvid, oid, cid, part, business, dt}`（业务类型与稿件定位）、`badge`、`tag_name`（分区）等。`business` 取值：archive（稿件）/ pgc（番剧影视）/ live / article / article-list。失效稿件也能返回。
- **数据颗粒度对本功能足够**：「刚看完《X》第 Y 期的 Z 分 P」可以精确拼出来。

**限流与 cookie 失效周期**
- 官方未公布任何 web 接口限流数值——**未证实**；社区共识为低频调用无碍、高频访问会触发风控。
- SESSDATA 有效期：官方未公布。出处：`docs/login/cookie_refresh.md`（同一存档 fork）——2023 年起社区观察 web cookie 会随敏感接口访问逐渐失效；cookie 不会自动刷新，需调用刷新流程（`passport.bilibili.com/x/passport-login/web/cookie/info` 检查 + RSA CorrespondPath + refresh_token 换新），refresh_token 需登录时持久化保存。**结论：不做自动化刷新，cookie 失效就走「提示用户重新提供」的降级路径。**

**本机已有 SESSDATA 复用评估（只读用途）**
- 可行性：该接口鉴权只需 cookie，无签名/风控前置校验，本机凭据直接可用；零部署成本，比 B 站任何其他路都轻。
- 稳定性风险（按影响排序）：
  1. cookie 会静默失效（周期未证实，社区观察数周~数月级），失效即 -101，需用户重新提供——产品上必须优雅降级，不能让心跳因此报错刷屏。
  2. 风控不确定性：同一 cookie 若调用频率、IP、UA 与用户日常浏览器行为差异过大，可能提前失效（未证实，属防御性假设）。
  3. 法律环境恶化：B 站 2025-07 对第三方客户端 PiliPala、2026-01 对 bilibili-API-collect（20k+ stars）连续发律师函，只读接口的第三方使用仍属灰色地带——个人本机低频使用风险最低，但需知情。
- 建议：复用可以，但要绑定三条纪律——①仅本机内存/本地文件使用、不上传不持久化到云端；②低频（见第四节频率建议）；③失效即停用并温和提示，不重试轰炸。

---

## 三、对比表与明确结论

### 对比表

| 维度 | 网易云 A：官方 API / ncm-cli | 网易云 B：api-enhanced 自建服务端（推荐） | 网易云 C：weapi/eapi 直连 | B 站 A：官方开放平台 | B 站 B：SESSDATA 只读接口（推荐） |
|---|---|---|---|---|---|
| 鉴权方式 | 个人入驻 + App ID/Key + 扫码（ncm-cli） | 扫码/手机号/cookie 三选一，登录一次长期复用 | 需 cookie，无登录流程可用 | 企业入驻 + OAuth2（个人无法获得） | 用户已有 SESSDATA cookie |
| 需要用户配合 | 实名入驻 + 扫码 | 扫码一次（或从浏览器导出一次 cookie） | 导出 cookie | ——（走不通） | 无（已有）；失效后重新提供 |
| 能拿到「最近在听/看」 | 听歌记录读取命令未证实 | 最近听歌列表 + 听歌排行（周/总）+ 红心歌单，颗粒度完整 | 同 B（同一套接口） | 未证实有观看历史 scope | 观看历史含标题/UP主/进度/分P，颗粒度完整 |
| 接入成本 | 中（入驻+CLI 封装） | 低（一个本地 Node 进程） | 中（自维护加密层） | 高且不可达 | 最低（零部署） |
| 稳定性 | 官方背书但能力缺失 | 中：社区活跃（2 天前仍在更新），接口可能随客户端改版漂移 | 中低：无社区修复兜底 | —— | 中：cookie 静默失效是最大变数 |
| 限流 | 官方未公布 | 官方未公布（未证实） | 官方未公布 | 未证实 | 官方未公布（未证实） |
| 主要风险 | 个人场景明确不支持 | 逆向接口法律风险；服务端持有 cookie 需脱敏 | 同 B，且无修复兜底 | 个人无资格 | cookie 失效；B 站对第三方 API 项目连续律师函 |

### 明确结论（先做哪一步）

1. **网易云走 1.2：自建 api-enhanced 本地服务端 + 扫码登录一次。**
   - 第一步：本机跑通 api-enhanced（npm install + node app.js），走 `login_qr_key/qr_create/qr_check` 让用户扫码一次，然后调 `POST /api/pc/recent/listen/list` 与 `POST /api/v1/play/record`（type=1）各一次，验证返回结构即完成技术验证。
   - 不选 1.1（个人场景官方明确暂不支持）；不选 1.3（无独立收益，仅作 1.2 失效后的备胎，crypto.js 可后补）。
2. **B 站走 2.2：SESSDATA 只读 cookie。**
   - 第一步：拿本机已有 SESSDATA 调 `GET /x/web-interface/history/cursor?ps=1` 验证 cookie 有效性（预期 code=0），并顺手确认返回字段满足素材需求。
   - 不选 2.1（个人无法入驻，scope 未见观看历史）。
   - 实现时必须带降级：-101 即停用该来源并提示用户更新 SESSDATA，不做自动化刷新。
3. **两平台的 cookie/凭据管理统一走脱敏纪律**：凭据只存本机、不进日志、不进提交内容、不进看板。

---

## 四、给心跳的用法建议（素材候选 + 频率）

### 数据 → 素材候选的转换建议

| 来源 | 抓取 | 素材候选示例 | 备注 |
|---|---|---|---|
| 网易云 `recent/listen/list` 第一条 | 最近收听的 1 首歌 | 「最近单曲循环《X》——<歌手>」 | 只取第一条，避免罗列显得窥探 |
| 网易云 `/user/record` type=1 第一名 | 本周播放次数最多的歌 | 「这周听得最多的是《X》，播放了 N 次」 | N 次这个数字很有心跳感 |
| B 站 history/cursor 第一条 | 最近观看的视频/番剧 | 「刚看完《X》看到第 Y 分钟」/「追的《X》更新了刚看完」 | progress/duration 可判断看到哪；只报最近一条 |

- 素材生成规则建议：进入素材池时打时间戳，**同一条素材 24 小时内不重复使用**；心跳闲逛触发时才从池子里捞，而不是每次拉取都新造素材（拉取与出素材解耦）。

### 频率建议（「多低才不冒犯」）

- 拉取频率：**每 2–4 小时一次足够**（拉一次存最新几条进素材池）。两个平台各自的调用完全可错开。
- 出素材频率：**闲逛会话里最多出现 1 条个人记录类素材**，且与上次同类素材间隔建议 ≥1 天。
- 不冒犯的红线（依据：素材语义而非实证）：不报精确时间点（不说「你凌晨 3 点在听」）、不连续追问、用户没登录的来源绝不出现「你去听听」类文案、任何来源失效就静默缺席不提示报错。
- 以上频率数字为工程建议而非实证结论——上线后建议观察用户反馈再调。

---

## 附：出处清单

| 编号 | 出处 | 用途 |
|---|---|---|
| S1 | https://developer.music.163.com/st/developer/document （个人接入指南：入驻条件 / FAQ / ncm-cli 各页，2026-11-08 浏览器实测渲染） | 网易云官方路线结论 |
| S2 | GitHub API `repos/Binaryify/NeteaseCloudMusicApi`（archived: true, pushed 2024-02-28） | 原项目停更 |
| S3 | GitHub API `repos/NeteaseCloudMusicApiEnhanced/api-enhanced`（2,187 stars, pushed 2026-11-06）+ 仓库 module/ 与 util/crypto.js 源码 | 网易云第三方路线全部接口与加密结论 |
| S4 | 存档 fork `rinnein/bilibili-API-collect`（master）docs/historytoview/history.md、docs/login/cookie_refresh.md | B 站接口字段与 cookie 刷新机制 |
| S5 | 本机无凭据只读试探（2026-11-08）：`api.bilibili.com/x/web-interface/history/cursor?ps=1` → code -101；`passport.bilibili.com/x/passport-login/web/cookie/info` → code -101 | 接口存在性与鉴权要求 |
| S6 | open.bilibili.com 入驻流程/企业认证规则页；bilibili.apifox.cn/doc-7492454（OAuth2 文档镜像） | B 站官方路线结论 |
| S7 | 新浪财经 2026-01-29 报道（bilibili-API-collect 收律师函关停） | B 站第三方 API 法律环境 |
| S8 | https://docs-neteasecloudmusicapi.focalors.ltd | api-enhanced 官方文档站 |
