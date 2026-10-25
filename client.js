// dsh-heartbeat client half (M6): settings-page card.
//
// Contract notes (verified against dsh-vision-router + dsh-client-ui-settings
// types on 0.1.1-rc.2; reworked for 0.1.7-rc.2 in v1.7.0):
//   - the client module is applied as a CLIENT-SIDE cordis plugin; the
//     ModuleLoader factory must return an object with an "apply" method;
//   - the settings page renders entries contributed to the 'settings.section'
//     slot; each entry = {name, id, order, label} + a React component (the
//     slot survives 0.1.7; the per-namespace settingsScope service does not);
//   - the rhythm editor rides the /api RPC channel (host persists to
//     data/settings/ui.json and applies live) — no host settings API needed;
//   - custom host data flows through an exact Fetch route under /api:
//     ctx.get('connection').rpc.call('/api', 'heartbeat', { endpoint, ...payload }).
window.__ModuleLoader__.load({
	id: "@kanadego/dsh-heartbeat",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");

		// Locale namespace and dictionary. zh is the source of truth: a host
		// without @deepseek-ai/dsh-client-locale falls back to it unchanged.
		const LOCALE_NS = "heartbeat";
		const DICT = {
			zh: {
				"settings.row.label": "心跳",
				"common.loading": "加载中…",
				"common.loadFailed": "加载失败：{error}",
				"common.confirmDelete": "确认删除",
				"common.delete": "删除",
				"common.empty": "(空)",
				"common.labelWithCount": "{label}（{count}）",
				"common.off": "关闭",
				"common.on": "开启",
				"common.refresh": "刷新",
				"common.remove": "移除",
				"common.save": "保存",
				"common.unknown": "未知",
				"common.add": "添加",
				"error.rpcUnavailable": "RPC 通道不可用（请确认 DSH 正在运行）",
				"error.rpcFailed": "RPC 调用失败",
				"status.loadFailed": "状态获取失败：{error}",
				"status.spoke": "说了：{text}",
				"status.silent": "沉默（{reason}）",
				"status.spokeFailed": "投递失败（{reason}）",
				"status.error": "心跳异常（{reason}）",
				"status.none": "尚无记录",
				"status.currentWithNote": "心跳此刻：{scene}——{note}",
				"status.current": "心跳此刻：{scene}",
				"status.currentEmpty": "心跳此刻：（还没有状态记录）",
				"status.version": "插件版本：v{version}",
				"status.lastBeat": "上次心跳：",
				"status.result": "结果：",
				"status.today": "今日表达：{used} / {max} 条",
				"status.quiet": "当前：静默时段内",
				"status.rhythm": "当前：正常节律（间隔 {interval} 分钟）",
				"status.statusbarOff": "{status}（状态栏已关闭）",
				"status.timeInject": "时间注入：",
				"status.timeInjectOff": "已关闭",
				"status.timeInjectEvery": "每 {interval} 分钟，最近 {last}",
				"status.never": "未发生过",
				"scene.quietHours": "静默时段，世界睡了",
				"scene.justSpoke": "刚去和你说过话",
				"scene.wandering": "正在闲逛看新东西",
				"scene.busy": "看到你在忙，不去打扰",
				"scene.present": "在场待着",
				"scene.away": "你不在，自己待着",
				"sessions.homeName": "心跳正身（引擎室）",
				"sessions.hint": "绑定 = 表达投递 + 对话观察（D13），两个开关可以同时开，也可以在下面逐个切换。心跳正身的思考轮次固定在其自身会话，不受绑定影响。",
				"sessions.boundRow": "🔗 {name}（{modes}）",
				"sessions.deliverTitleOn": "点击关闭投递",
				"sessions.deliverTitleOff": "点击开启投递",
				"sessions.observeTitleOn": "点击关闭观察",
				"sessions.observeTitleOff": "点击开启观察",
				"sessions.deliver": "投递",
				"sessions.observe": "观察",
				"sessions.unbind": "解绑",
				"sessions.noBound": "（暂无绑定会话——表达只出现在心跳正身会话）",
				"sessions.collapseUnbound": "收起未绑定列表",
				"sessions.bindOthers": "绑定其他会话（{count}）",
				"sessions.filterPlaceholder": "按会话名或 id 过滤…",
				"sessions.noMatch": "（无匹配会话）",
				"sessions.homeNoBind": "（心跳正身，无需绑定）",
				"sessions.bindDeliver": "绑定投递",
				"sessions.bindObserve": "绑定观察",
				"sessions.modesBoth": "投递+观察",
				"seeds.activeSummary": "活跃 {active} / {cap} 条；归档 {archived} 条",
				"seeds.tabTopic": "话题素材",
				"seeds.tabChat": "聊天素材",
				"seeds.tabArchivedTopic": "话题·归档",
				"seeds.tabArchivedChat": "聊天·归档",
				"seeds.hintArchivedChat": "归档的聊天素材：不再被挑中，可以恢复",
				"seeds.hintArchivedTopic": "归档的话题素材：不再被挑中，可以恢复",
				"seeds.hintChat": "对话里长出来的：说过一次就算用掉",
				"seeds.hintTopic": "浏览流、手写、画像喂进来的：随机挑，可重复用",
				"seeds.emptyArchived": "（这类还没有归档条目）",
				"seeds.empty": "（这类还没有条目）",
				"seeds.restore": "恢复",
				"seeds.archive": "归档",
				"seeds.used": "  used:{used}",
				"interests.added": "已添加",
				"interests.addFailed": "添加失败：{error}",
				"interests.deleted": "已删除",
				"interests.deleteFailed": "删除失败：{error}",
				"interests.savedWindows": "浏览时段已保存",
				"interests.saveFailed": "保存失败：{error}",
				"interests.hint": "闲逛搜索按这份清单轮换挑焦点（同一条 3 天内不重复）。增删后即时生效，无需重启。",
				"interests.empty": "（清单是空的——闲逛将没有焦点可挑）",
				"interests.placeholder": "新兴趣，如：天文摄影",
				"interests.windowsHint": "浏览时段（闲逛只在这些窗口内发生；起始须早于结束，多个时段不能重叠）：",
				"interests.to": "到",
				"interests.addWindow": "加一个时段",
				"interests.saveWindows": "保存时段",
				"profile.tabInterest": "兴趣",
				"profile.tabProjects": "进行中",
				"profile.tabComm": "沟通偏好",
				"profile.tabPsy": "心理",
				"profile.exported": "已导出：{path}",
				"profile.engine": "引擎室输入",
				"profile.digest": "共 {total} / {budget} 字符（{budgetState}）；按预算省略：处境 {tact} 条、话题 {topic} 条、兴趣 {wander} 条",
				"profile.withinBudget": "在预算内",
				"profile.overBudget": "超预算",
				"profile.tactFacet": "处境切面",
				"profile.topicFacet": "话题切面",
				"profile.wanderFacet": "兴趣切面",
				"profile.valid": "有效 {valid} 条 / 历史 {historical} 条（过期条目不进引擎室输入，也不在这里列出）",
				"profile.emptyPartition": "（这个分区还没有条目）",
				"profile.conf": "　conf {value}",
				"profile.temporal": "　{value}",
				"profile.stale": "　久未验证",
				"profile.updated": "　更新 {date}",
				"profile.exportMarkdown": "导出 Markdown",
				"config.saved": "已保存（即时生效，无需重启）",
				"config.saveFailed": "保存失败：{error}",
				"config.interval": "心跳间隔（分钟）",
				"config.cap": "每日表达上限（条）",
				"config.timeInject": "时间注入间隔（分钟）",
				"config.timeInjectOff": "0 = 关闭",
				"config.statusbar": "状态栏",
				"config.statusbarHint": "日常会话中的心跳状态感知（会额外消耗token）",
				"config.idle": "闲着模式",
				"config.idleHint": "素材池空时用画像话题兜底主动搭话（闸门仍生效）",
				"config.tokenSaver": "节省 token 模式",
				"config.tokenSaverHint": "你离开（闲置 ≥30 分钟）或锁屏时整跳暂停，回来自动恢复",
				"config.psy": "psy 分区",
				"config.psyHint": "允许画像记录 psy 分区（警告，开启后模型会主动猜测用户心理并计入用户画像，关闭时画像内容计入内容较少）",
				"config.saveHint": "全部参数保存后即时生效，无需重启",
				"weekly.intro": "每 7 天生成一份：本周表达与静默、新认识、账本、素材池与活跃高峰。报告只陈述事实，由后台「心跳」署名。",
				"weekly.empty": "（还没有周报——装好一周后自动出第一期）",
				"migrate.processing": "处理中…",
				"migrate.failed": "失败：{error}",
				"migrate.pwMismatch": "两次口令不一致或为空",
				"migrate.exported": "已打包 {count} 个文件 → {path}（可拷贝到新机器，口令别丢）",
				"migrate.needInput": "需要容器路径与口令",
				"migrate.imported": "恢复 {restored} 个文件，备份 {backedUp} 个，跳过 {skipped} 个——重启 DSH 后生效",
				"migrate.intro": "换电脑/重装系统时把心跳的记忆带走：导出一个口令加密的迁移包，在新机器上导入。口令丢失无法破解，容器可安全走网盘。",
				"migrate.exportHeading": "① 在这台机器上导出",
				"migrate.pwPlaceholder": "设置口令",
				"migrate.pwAgainPlaceholder": "再输入一次",
				"migrate.exportButton": "导出迁移包",
				"migrate.importHeading": "② 在新机器上导入",
				"migrate.filePlaceholder": "迁移包完整路径（.hbmig）",
				"migrate.pwPlaceholderShort": "口令",
				"migrate.importButton": "导入",
				"section.status": "心跳状态",
				"section.sessions": "会话绑定",
				"section.seeds": "素材池",
				"section.interests": "兴趣范围",
				"section.profile": "用户画像（只读）",
				"section.ledger": "账本",
				"section.excerpt": "摘抄本",
				"section.weekly": "周报",
				"section.migrate": "换机迁移",
				"section.config": "节律配置",
				"ledger.opened": "已打开：{path}",
				"ledger.failed": "失败：{error}",
				"ledger.open": "一键打开账本",
				"ledger.hint": "账本是心跳 agent 的待办与话题来源，可直接手编",
				"excerpt.opened": "已打开：{path}",
				"excerpt.failed": "失败：{error}",
				"excerpt.open": "一键打开摘抄本",
				"excerpt.hint": "留句子和小事的地方：只增不减，直接手编也不会被覆盖",
			},
			en: {
				"settings.row.label": "Heartbeat",
				"common.loading": "Loading…",
				"common.loadFailed": "Failed to load: {error}",
				"common.confirmDelete": "Confirm delete",
				"common.delete": "Delete",
				"common.empty": "(empty)",
				"common.labelWithCount": "{label} ({count})",
				"common.off": "Off",
				"common.on": "On",
				"common.refresh": "Refresh",
				"common.remove": "Remove",
				"common.save": "Save",
				"common.unknown": "unknown",
				"common.add": "Add",
				"error.rpcUnavailable": "RPC channel unavailable (make sure DSH is running)",
				"error.rpcFailed": "RPC call failed",
				"status.loadFailed": "Failed to fetch status: {error}",
				"status.spoke": "Said: {text}",
				"status.silent": "Silent ({reason})",
				"status.spokeFailed": "Delivery failed ({reason})",
				"status.error": "Heartbeat error ({reason})",
				"status.none": "No record yet",
				"status.currentWithNote": "Heartbeat now: {scene} — {note}",
				"status.current": "Heartbeat now: {scene}",
				"status.currentEmpty": "Heartbeat now: (no status record yet)",
				"status.version": "Plugin version: v{version}",
				"status.lastBeat": "Last heartbeat:",
				"status.result": "Result:",
				"status.today": "Expressions today: {used} / {max}",
				"status.quiet": "Now: in quiet hours",
				"status.rhythm": "Now: normal rhythm (every {interval} min)",
				"status.statusbarOff": "{status} (status bar off)",
				"status.timeInject": "Time injection:",
				"status.timeInjectOff": "Off",
				"status.timeInjectEvery": "Every {interval} min, last {last}",
				"status.never": "never",
				"scene.quietHours": "Quiet hours — the world is asleep",
				"scene.justSpoke": "Just talked to you",
				"scene.wandering": "Wandering around, looking at something new",
				"scene.busy": "You look busy, so I am staying out of the way",
				"scene.present": "Here with you",
				"scene.away": "You are away, so I am on my own",
				"sessions.homeName": "Heartbeat itself (engine room)",
				"sessions.hint": "Binding = expression delivery + conversation observation (D13). Both switches can be on at once, or toggled individually below. The heartbeat itself always thinks in its own session, regardless of bindings.",
				"sessions.boundRow": "🔗 {name} ({modes})",
				"sessions.deliverTitleOn": "Click to turn delivery off",
				"sessions.deliverTitleOff": "Click to turn delivery on",
				"sessions.observeTitleOn": "Click to turn observation off",
				"sessions.observeTitleOff": "Click to turn observation on",
				"sessions.deliver": "Deliver",
				"sessions.observe": "Observe",
				"sessions.unbind": "Unbind",
				"sessions.noBound": "(No bound sessions — expressions only appear in the heartbeat's own session)",
				"sessions.collapseUnbound": "Hide unbound sessions",
				"sessions.bindOthers": "Bind other sessions ({count})",
				"sessions.filterPlaceholder": "Filter by session name or id…",
				"sessions.noMatch": "(No matching sessions)",
				"sessions.homeNoBind": "(The heartbeat itself does not need binding)",
				"sessions.bindDeliver": "Bind delivery",
				"sessions.bindObserve": "Bind observation",
				"sessions.modesBoth": "Deliver + observe",
				"seeds.activeSummary": "Active {active} / {cap} entries; archived {archived}",
				"seeds.tabTopic": "Topics",
				"seeds.tabChat": "Chat",
				"seeds.tabArchivedTopic": "Topics · archived",
				"seeds.tabArchivedChat": "Chat · archived",
				"seeds.hintArchivedChat": "Archived chat material: no longer picked, but can be restored",
				"seeds.hintArchivedTopic": "Archived topic material: no longer picked, but can be restored",
				"seeds.hintChat": "Grown from conversations: used once and then spent",
				"seeds.hintTopic": "From browsing, handwriting, and the profile: picked at random and reusable",
				"seeds.emptyArchived": "(No archived entries of this kind yet)",
				"seeds.empty": "(No entries of this kind yet)",
				"seeds.restore": "Restore",
				"seeds.archive": "Archive",
				"seeds.used": "  used: {used}",
				"interests.added": "Added",
				"interests.addFailed": "Failed to add: {error}",
				"interests.deleted": "Deleted",
				"interests.deleteFailed": "Failed to delete: {error}",
				"interests.savedWindows": "Browsing windows saved",
				"interests.saveFailed": "Failed to save: {error}",
				"interests.hint": "Wandering searches rotate through this list for focus (the same entry is not reused within 3 days). Changes take effect immediately, no restart needed.",
				"interests.empty": "(The list is empty — wandering will have no focus to pick)",
				"interests.placeholder": "New interest, e.g. astrophotography",
				"interests.windowsHint": "Browsing windows (wandering only happens inside these; start must be before end, and windows must not overlap):",
				"interests.to": "to",
				"interests.addWindow": "Add a window",
				"interests.saveWindows": "Save windows",
				"profile.tabInterest": "Interests",
				"profile.tabProjects": "In progress",
				"profile.tabComm": "Communication preferences",
				"profile.tabPsy": "Psychology",
				"profile.exported": "Exported: {path}",
				"profile.engine": "Engine room input",
				"profile.digest": "{total} / {budget} characters ({budgetState}); omitted to fit the budget — situation: {tact}, topic: {topic}, interest: {wander}",
				"profile.withinBudget": "within budget",
				"profile.overBudget": "over budget",
				"profile.tactFacet": "Situation facet",
				"profile.topicFacet": "Topic facet",
				"profile.wanderFacet": "Interest facet",
				"profile.valid": "Valid {valid} / historical {historical} entries (expired entries are neither sent to the engine room nor listed here)",
				"profile.emptyPartition": "(This partition has no entries yet)",
				"profile.conf": " · confidence {value}",
				"profile.temporal": " · {value}",
				"profile.stale": " · not verified for a while",
				"profile.updated": " · updated {date}",
				"profile.exportMarkdown": "Export Markdown",
				"config.saved": "Saved (takes effect immediately, no restart needed)",
				"config.saveFailed": "Failed to save: {error}",
				"config.interval": "Heartbeat interval (minutes)",
				"config.cap": "Daily expression limit",
				"config.timeInject": "Time injection interval (minutes)",
				"config.timeInjectOff": "0 = off",
				"config.statusbar": "Status bar",
				"config.statusbarHint": "Show heartbeat status in everyday conversations (uses extra tokens)",
				"config.idle": "Idle mode",
				"config.idleHint": "When the material pool is empty, fall back to profile topics and start a conversation (gates still apply)",
				"config.tokenSaver": "Token-saver mode",
				"config.tokenSaverHint": "Pause all beats while you are away (idle for 30+ min) or the screen is locked, and resume automatically when you return",
				"config.psy": "Psychology partition",
				"config.psyHint": "Allow the profile to record the psychology partition (warning: when enabled, the model will guess your psychology and add it to your profile; when disabled, the profile contains less content)",
				"config.saveHint": "All settings take effect immediately after saving, no restart needed",
				"weekly.intro": "Generated every 7 days: this week's expressions and silences, new acquaintances, ledger, material pool, and activity peaks. The report states facts only and is signed by the background Heartbeat.",
				"weekly.empty": "(No weekly report yet — the first one appears a week after installation)",
				"migrate.processing": "Working…",
				"migrate.failed": "Failed: {error}",
				"migrate.pwMismatch": "The two passphrases do not match, or are empty",
				"migrate.exported": "Packed {count} files → {path} (copy it to the new machine, and do not lose the passphrase)",
				"migrate.needInput": "A container path and passphrase are required",
				"migrate.imported": "Restored {restored} files, backed up {backedUp}, skipped {skipped} — restart DSH to apply",
				"migrate.intro": "Take the heartbeat's memory with you when changing computers or reinstalling: export a passphrase-encrypted migration package, then import it on the new machine. A lost passphrase cannot be cracked, and the container is safe to put on cloud storage.",
				"migrate.exportHeading": "1. Export on this machine",
				"migrate.pwPlaceholder": "Set a passphrase",
				"migrate.pwAgainPlaceholder": "Enter it again",
				"migrate.exportButton": "Export migration package",
				"migrate.importHeading": "2. Import on the new machine",
				"migrate.filePlaceholder": "Full path to the migration package (.hbmig)",
				"migrate.pwPlaceholderShort": "Passphrase",
				"migrate.importButton": "Import",
				"section.status": "Heartbeat status",
				"section.sessions": "Session bindings",
				"section.seeds": "Material pool",
				"section.interests": "Interest scope",
				"section.profile": "User profile (read-only)",
				"section.ledger": "Ledger",
				"section.excerpt": "Excerpt book",
				"section.weekly": "Weekly report",
				"section.migrate": "Migrate to a new machine",
				"section.config": "Rhythm settings",
				"ledger.opened": "Opened: {path}",
				"ledger.failed": "Failed: {error}",
				"ledger.open": "Open the ledger",
				"ledger.hint": "The ledger is the heartbeat agent's source of todos and topics, and can be edited by hand",
				"excerpt.opened": "Opened: {path}",
				"excerpt.failed": "Failed: {error}",
				"excerpt.open": "Open the excerpt book",
				"excerpt.hint": "A place for sentences and small things: it only grows, and hand edits are never overwritten",
			},
		};
		const fill = (text, params) => String(text).replace(/\{(\w+)\}/g, (match, key) => (params && key in params ? String(params[key]) : match));
		let localeSvc = null;
		const t = (key, params) => {
			if (localeSvc) return localeSvc.bind(LOCALE_NS)(key, params);
			const text = DICT.zh[key];
			return text === undefined ? key : fill(text, params);
		};
		const L = (key, params) => t(key, params);

		const rowStyle = { display: "flex", alignItems: "center", gap: 8, margin: "6px 0" };
		const labelStyle = { minWidth: 140, fontSize: 13, color: "var(--dsw-alias-label-secondary)", flex: "none" };
		const inputStyle = { width: 90, height: 28, borderRadius: 8, border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-specific-input-bg, transparent)", color: "var(--dsw-alias-label-primary)", padding: "0 8px", fontSize: 13 };
		const buttonStyle = { height: 26, padding: "0 12px", borderRadius: 8, border: "none", background: "#339CFF", color: "#fff", fontSize: 12, cursor: "pointer", flex: "none" };
		const buttonGhost = { ...buttonStyle, background: "var(--dsw-alias-interactive-bg-hover, #444)", color: "var(--dsw-alias-label-primary)" };
		const hintStyle = { fontSize: 12, color: "var(--dsw-alias-label-tertiary)", margin: "4px 0" };
		const sectionStyle = { borderTop: "1px solid var(--dsw-alias-border-l2)", marginTop: 10, paddingTop: 6 };
		const summaryStyle = { fontSize: 13, fontWeight: 600, color: "var(--dsw-alias-label-primary)", cursor: "pointer" };
		const listStyle = { listStyle: "none", margin: "4px 0", padding: 0, fontSize: 12, color: "var(--dsw-alias-label-secondary)" };
		const rowList = { display: "flex", alignItems: "center", gap: 8, padding: "3px 0" };

		function apply(ctx) {
			// settingsScope was removed in DSH 0.1.7 — never bound here again.
			// The rhythm editor rides the RPC channel (data/settings/ui.json on
			// the host), so the card works identically on every host generation.
			const locale = ctx.get("locale");
			if (locale && typeof locale.register === "function" && typeof locale.bind === "function") {
				localeSvc = locale;
				ctx.effect(() => locale.register(LOCALE_NS, { zh: DICT.zh, en: DICT.en }));
			}
			const getConnection = () => {
				try { return ctx.get("connection"); } catch { return undefined; }
			};
			const rpc = async (endpoint, payload) => {
				const conn = getConnection();
				if (!conn || !conn.rpc || typeof conn.rpc.call !== "function") {
					throw new Error(t("error.rpcUnavailable"));
				}
				// C21：0.1.5 起自定义 rpc.handle 通道不可用，宿主侧改为 /api 下的精确
				// Fetch 路由；端点名走 payload.endpoint 字段（信封与 /api 同构）。
				const result = await conn.rpc.call("/api", "heartbeat", { endpoint, ...(payload ?? {}) }, undefined);
				if (!result || result.ok !== true) {
				 throw new Error((result && result.error && result.error.message) || t("error.rpcFailed"));
				}
				return result.value;
			};
			// 会话名来自 client 自己的会话存储（侧边栏同名数据源）；拿不到则回退 id。
			const sessionName = (id) => {
				try {
					const list = typeof ctx.sessions?.list === "function" ? ctx.sessions.list() : undefined;
					const hit = Array.isArray(list) ? list.find((s) => s && (s.id === id || s.sessionId === id)) : undefined;
					const name = hit && (hit.title || hit.name || hit.displayName);
					return name ? String(name) : null;
				} catch { return null; }
			};

			// ── 通用小组件 ────────────────────────────────────────────────
			function Section(props) {
				const [open, setOpen] = React.useState(props.open === true);
				return React.createElement(
					"details",
					{ open, style: sectionStyle, onToggle: (e) => setOpen(e.target.open) },
					React.createElement("summary", { style: summaryStyle }, props.title),
					open ? React.createElement("div", { style: { paddingTop: 4 } }, props.children) : null,
				);
			}
			function useAsync(fetcher, deps) {
				const [state, setState] = React.useState({ loading: true, error: null, value: null });
				React.useEffect(() => {
					let alive = true;
					setState({ loading: true, error: null, value: null });
					fetcher().then(
						(value) => { if (alive) setState({ loading: false, error: null, value }); },
						(error) => { if (alive) setState({ loading: false, error: String(error).slice(0, 120), value: null }); },
					);
					return () => { alive = false; };
				}, deps || []);
				return state;
			}
			const fmtTime = (iso) => {
				try { return new Date(iso).toLocaleString("zh-CN", { hour12: false }); } catch { return String(iso); }
			};

			// ── 心跳状态卡片 ──────────────────────────────────────────────
			function StatusCard() {
				const { loading, error, value } = useAsync(() => rpc("status"), []);
				React.useEffect(() => {
					const timer = setInterval(() => { rpc("status").then((v) => setStateSafe(v)).catch(() => {}); }, 30000);
					return () => clearInterval(timer);
				}, []);
				const stateRef = React.useRef(null);
				function setStateSafe(v) { stateRef.current = v; force(); }
				const [, force] = React.useReducer((x) => x + 1, 0);
				const view = stateRef.current || value;
				if (loading && !view) return React.createElement("div", { style: hintStyle }, t("common.loading"));
				if (error) return React.createElement("div", { style: hintStyle }, L("status.loadFailed", { error }));
				const lb = view.lastBeat || {};
				const verdictText = lb.verdict === "spoke" ? L("status.spoke", { text: (lb.text || "").slice(0, 60) })
					: lb.verdict === "silent" ? L("status.silent", { reason: lb.reason || "" })
					: lb.verdict === "spoke_failed" ? L("status.spokeFailed", { reason: lb.reason || "" })
					: lb.verdict === "error" ? L("status.error", { reason: lb.reason || "" }) : t("status.none");
				const sb = view.statusbar || {};
				const SCENE_KEYS = {
					"quiet-hours": "scene.quietHours",
					"just-spoke": "scene.justSpoke",
					"wandering": "scene.wandering",
					"busy": "scene.busy",
					"present": "scene.present",
					"away": "scene.away",
				};
				const sceneLabel = sb.lastStatus ? (SCENE_KEYS[sb.lastStatus.scene] ? t(SCENE_KEYS[sb.lastStatus.scene]) : sb.lastStatus.scene) : "";
				const statusText = sb.lastStatus
					? (sb.lastStatus.note
						? L("status.currentWithNote", { scene: sceneLabel, note: sb.lastStatus.note })
						: L("status.current", { scene: sceneLabel }))
					: t("status.currentEmpty");
				return React.createElement(
					"div",
					{ style: listStyle },
					React.createElement("div", null, L("status.version", { version: view.version || t("common.unknown") })),
					React.createElement("div", null, t("status.lastBeat"), fmtTime(lb.at)),
					React.createElement("div", null, t("status.result"), verdictText),
					React.createElement("div", null, L("status.today", { used: view.cap.used, max: view.cap.max })),
					React.createElement("div", null, view.quiet ? t("status.quiet") : L("status.rhythm", { interval: view.intervalMin })),
					React.createElement("div", null, sb.enabled === false ? L("status.statusbarOff", { status: statusText }) : statusText),
					React.createElement("div", { style: hintStyle },
						t("status.timeInject"), sb.timeInjectMin === 0 ? t("status.timeInjectOff")
							: L("status.timeInjectEvery", { interval: sb.timeInjectMin, last: sb.lastTimeInjectAt ? fmtTime(sb.lastTimeInjectAt) : t("status.never") })),
				);
			}

			// ── 会话绑定 ──────────────────────────────────────────────────
			function SessionsSection() {
				const [data, setData] = React.useState(null);
				const [error, setError] = React.useState(null);
				const [showUnbound, setShowUnbound] = React.useState(false);
				const [query, setQuery] = React.useState("");
				const reload = React.useCallback(() => {
					Promise.all([rpc("sessions.list"), rpc("bindings.get")]).then(
						([sessions, bindings]) => setData({ sessions: sessions.sessions, bindings: bindings.bindings }),
						(e) => setError(String(e).slice(0, 100)),
					);
				}, []);
				React.useEffect(() => { reload(); }, [reload]);
				if (error) return React.createElement("div", { style: hintStyle }, L("common.loadFailed", { error }));
				if (!data) return React.createElement("div", { style: hintStyle }, t("common.loading"));
				const bound = data.sessions.filter((s) => s.deliver || s.observe);
				const doUnbind = (id) => rpc("bindings.remove", { sessionId: id }).then(reload, (e) => setError(String(e).slice(0, 100)));
				const doBind = (id, deliver, observe) => rpc("bindings.add", { sessionId: id, deliver, observe }).then(reload, (e) => setError(String(e).slice(0, 100)));
				// 已绑定的会话照样能改开关：D13 允许投递 + 观察同时开，所以这里按字段单独
				// 翻转，而不是把会话当成"已绑定就锁死"。两个都关 = 真正解绑。
				const setFlags = (id, deliver, observe) => {
					const call = (!deliver && !observe)
						? rpc("bindings.remove", { sessionId: id })
						: rpc("bindings.add", { sessionId: id, deliver, observe });
					return call.then(reload, (e) => setError(String(e).slice(0, 100)));
				};
				const flagStyle = (on) => (on ? buttonGhost : { ...buttonGhost, opacity: 0.5 });
				// 会话名：宿主从 projcache 取 title；无 title 时回退 id 前缀
				const nameOf = (s) => s.title || (s.home ? t("sessions.homeName") : s.id.slice(0, 19) + "…");
				const q = query.trim().toLowerCase();
				const matches = (s) => !q || nameOf(s).toLowerCase().includes(q) || s.id.toLowerCase().includes(q);
				const unbound = data.sessions.filter((s) => !s.deliver && !s.observe && matches(s));
				const modesOf = (s) => (s.deliver && s.observe ? t("sessions.modesBoth") : s.deliver ? t("sessions.deliver") : t("sessions.observe"));
				return React.createElement(
					"div",
					null,
					React.createElement("div", { style: hintStyle }, t("sessions.hint")),
					bound.map((s) => React.createElement("div", { key: s.id, style: rowList },
						React.createElement("span", { style: { flex: 1, fontSize: 12 } },
							L("sessions.boundRow", { name: nameOf(s), modes: modesOf(s) })),
						React.createElement("span", { style: { display: "flex", gap: 4 } },
							React.createElement("button", { style: flagStyle(s.deliver), title: s.deliver ? t("sessions.deliverTitleOn") : t("sessions.deliverTitleOff"), onClick: () => setFlags(s.id, !s.deliver, s.observe) }, (s.deliver ? "☑ " : "☐ ") + t("sessions.deliver")),
							React.createElement("button", { style: flagStyle(s.observe), title: s.observe ? t("sessions.observeTitleOn") : t("sessions.observeTitleOff"), onClick: () => setFlags(s.id, s.deliver, !s.observe) }, (s.observe ? "☑ " : "☐ ") + t("sessions.observe")),
							React.createElement("button", { style: buttonGhost, onClick: () => doUnbind(s.id) }, t("sessions.unbind")),
						),
					)),
					bound.length === 0 ? React.createElement("div", { style: hintStyle }, t("sessions.noBound")) : null,
					React.createElement("div", { style: rowStyle },
						React.createElement("button", { style: buttonGhost, onClick: () => setShowUnbound(!showUnbound) }, showUnbound ? t("sessions.collapseUnbound") : L("sessions.bindOthers", { count: unbound.length }))),
					showUnbound ? React.createElement(
						"div",
						null,
						React.createElement("input", { style: { ...inputStyle, width: "100%", margin: "4px 0", boxSizing: "border-box" }, placeholder: t("sessions.filterPlaceholder"), value: query, onChange: (e) => setQuery(e.target.value) }),
						unbound.length === 0 ? React.createElement("div", { style: hintStyle }, t("sessions.noMatch")) : null,
						unbound.map((s) => React.createElement("div", { key: s.id, style: rowList },
							React.createElement("span", { style: { flex: 1, fontSize: 12 } }, nameOf(s), s.home ? t("sessions.homeNoBind") : ""),
							s.home ? null : React.createElement(
								"span",
								{ style: { display: "flex", gap: 4 } },
								React.createElement("button", { style: buttonStyle, onClick: () => doBind(s.id, true, false) }, t("sessions.bindDeliver")),
								React.createElement("button", { style: buttonGhost, onClick: () => doBind(s.id, false, true) }, t("sessions.bindObserve")),
								React.createElement("button", { style: buttonGhost, onClick: () => doBind(s.id, true, true) }, t("sessions.modesBoth")),
							),
						)),
					) : null,
				);
			}

			// ── 素材池（v1.9.3 三版）：话题 / 聊天 × 活跃 / 归档，四个按钮各看一类 ──
			// 和画像分区同一套 tab 交互，风格统一；一次只看一类。
			function SeedsSection() {
				const [data, setData] = React.useState(null);
				const [error, setError] = React.useState(null);
				const [tab, setTab] = React.useState("topic");
				const [confirmId, setConfirmId] = React.useState(null);
				const reload = React.useCallback(() => {
					rpc("seeds.list").then(setData, (e) => setError(String(e).slice(0, 100)));
				}, []);
				React.useEffect(() => { reload(); }, [reload]);
				if (error) return React.createElement("div", { style: hintStyle }, L("common.loadFailed", { error }));
				if (!data) return React.createElement("div", { style: hintStyle }, t("common.loading"));
				const act = (endpoint, id) => rpc(endpoint, { id }).then(reload, (e) => setError(String(e).slice(0, 100)));
				const row = (s, archived) => React.createElement("div", { key: s.id, style: rowList },
					React.createElement("span", { style: { flex: 1, fontSize: 12, wordBreak: "break-word" } },
						"[", s.tag, "/", s.source, "] ", s.text.slice(0, 60), L("seeds.used", { used: s.used })),
					archived
						? React.createElement("button", { style: buttonGhost, onClick: () => act("seeds.restore", s.id) }, t("seeds.restore"))
						: React.createElement("button", { style: buttonGhost, onClick: () => act("seeds.archive", s.id) }, t("seeds.archive")),
					confirmId === s.id
						? React.createElement("button", { style: { ...buttonStyle, background: "#e5484d" }, onClick: () => { setConfirmId(null); act("seeds.delete", s.id); } }, t("common.confirmDelete"))
						: React.createElement("button", { style: buttonGhost, onClick: () => setConfirmId(s.id) }, t("common.delete")),
				);
				const isChat = (s) => (s.category || "topic") === "chat";
				const topics = data.active.filter((s) => !isChat(s));
				const chats = data.active.filter(isChat);
				const arcTopics = data.archived.filter((s) => !isChat(s));
				const arcChats = data.archived.filter(isChat);
				const archived = tab.indexOf("arc") === 0;
				const chat = tab.indexOf("chat") >= 0;
				const list = archived ? (chat ? arcChats : arcTopics) : (chat ? chats : topics);
				const tabButton = (key, label, count) => React.createElement("button", {
					key,
					style: tab === key ? buttonStyle : buttonGhost,
					onClick: () => setTab(key),
				}, L("common.labelWithCount", { label, count }));
				return React.createElement(
					"div",
					null,
					React.createElement("div", { style: hintStyle }, L("seeds.activeSummary", { active: data.active.length, cap: data.cap, archived: data.archived.length })),
					React.createElement("div", { style: tabRow },
						tabButton("topic", t("seeds.tabTopic"), topics.length),
						tabButton("chat", t("seeds.tabChat"), chats.length),
						tabButton("arc-topic", t("seeds.tabArchivedTopic"), arcTopics.length),
						tabButton("arc-chat", t("seeds.tabArchivedChat"), arcChats.length)),
					React.createElement("div", { style: hintStyle }, archived
						? (chat ? t("seeds.hintArchivedChat") : t("seeds.hintArchivedTopic"))
						: (chat ? t("seeds.hintChat") : t("seeds.hintTopic"))),
					list.length === 0
						? React.createElement("div", { style: hintStyle }, archived ? t("seeds.emptyArchived") : t("seeds.empty"))
						: React.createElement("div", { style: scrollBox }, list.map((s) => row(s, archived))),
				);
			}

			// ── 兴趣范围 + 浏览时段（v1.4.0）──────────────────────────────
			// 首编继承出厂：第一次增删/存时段时，插件自动把出厂 interests.json
			// 完整复制进 data/settings/interests.json，之后卡片就是唯一入口。
			function InterestsSection() {
				const [data, setData] = React.useState(null);
				const [error, setError] = React.useState(null);
				const [status, setStatus] = React.useState("");
				const [confirmText, setConfirmText] = React.useState(null);
				const [draft, setDraft] = React.useState("");
				const [draftWindows, setDraftWindows] = React.useState(null);
				const reload = React.useCallback(() => {
					rpc("interests.list").then((doc) => {
						setData(doc);
						setDraftWindows((prev) => prev || (doc._schedule?.windows || []).map((w) => ({ id: w.id || (w.start + "-" + w.end), start: w.start, end: w.end })));
					}, (e) => setError(String(e).slice(0, 100)));
				}, []);
				React.useEffect(() => { reload(); }, [reload]);
				if (error) return React.createElement("div", { style: hintStyle }, L("common.loadFailed", { error }));
				if (!data) return React.createElement("div", { style: hintStyle }, t("common.loading"));
				const interests = data.interests || [];
				const doAdd = () => {
					const text = draft.trim();
					if (!text) return;
					rpc("interests.add", { text }).then(
						() => { setDraft(""); setStatus(t("interests.added")); reload(); },
						(e) => setStatus(L("interests.addFailed", { error: String(e).slice(0, 80) })),
					);
				};
				const doRemove = (text) => rpc("interests.remove", { text }).then(
					() => { setConfirmText(null); setStatus(t("interests.deleted")); reload(); },
					(e) => { setConfirmText(null); setStatus(L("interests.deleteFailed", { error: String(e).slice(0, 80) })); },
				);
				const saveWindows = () => {
					rpc("interests.setWindows", { windows: draftWindows }).then(
						() => { setStatus(t("interests.savedWindows")); reload(); },
						(e) => setStatus(L("interests.saveFailed", { error: String(e).slice(0, 80) })),
					);
				};
				const editWindow = (idx, field, value) => setDraftWindows((ws) => ws.map((w, i) => (i === idx ? { ...w, [field]: value } : w)));
				return React.createElement(
					"div",
					null,
					React.createElement("div", { style: hintStyle }, t("interests.hint")),
					interests.map((item) => React.createElement("div", { key: item, style: rowList },
						React.createElement("span", { style: { flex: 1, fontSize: 12 } }, item),
						confirmText === item
							? React.createElement("button", { style: { ...buttonStyle, background: "#e5484d" }, onClick: () => doRemove(item) }, t("common.confirmDelete"))
							: React.createElement("button", { style: buttonGhost, onClick: () => setConfirmText(item) }, t("common.delete")),
					)),
					interests.length === 0 ? React.createElement("div", { style: hintStyle }, t("interests.empty")) : null,
					React.createElement("div", { style: rowStyle },
						React.createElement("input", { style: { ...inputStyle, width: 240 }, placeholder: t("interests.placeholder"), value: draft, onChange: (e) => setDraft(e.target.value), onKeyDown: (e) => { if (e.key === "Enter") doAdd(); } }),
						React.createElement("button", { style: buttonStyle, onClick: doAdd }, t("common.add")),
					),
					React.createElement("div", { style: { ...hintStyle, marginTop: 10 } }, t("interests.windowsHint")),
					(draftWindows || []).map((w, idx) => React.createElement("div", { key: idx, style: rowList },
						React.createElement("input", { style: inputStyle, type: "time", value: w.start, onChange: (e) => editWindow(idx, "start", e.target.value) }),
						React.createElement("span", { style: hintStyle }, t("interests.to")),
						React.createElement("input", { style: inputStyle, type: "time", value: w.end, onChange: (e) => editWindow(idx, "end", e.target.value) }),
						(draftWindows.length > 1) ? React.createElement("button", { style: buttonGhost, onClick: () => setDraftWindows((ws) => ws.filter((_, i) => i !== idx)) }, t("common.remove")) : null,
					)),
					React.createElement("div", { style: rowStyle },
						React.createElement("button", { style: buttonGhost, onClick: () => setDraftWindows((ws) => [...(ws || []), { id: "", start: "11:00", end: "13:00" }]) }, t("interests.addWindow")),
						React.createElement("button", { style: buttonStyle, onClick: saveWindows }, t("interests.saveWindows")),
					),
					status ? React.createElement("div", { style: hintStyle }, status) : null,
				);
			}

			// ── 画像入口（v2.0）：四个分区 + 引擎室输入 ─────────────────────
			// 一次只看一个分区，条目一条一块、正文自动换行；另给一个只读的
			// 「引擎室输入」视图，直接回答「截断后引擎室到底看到了什么」。
			const PARTITIONS = [
				{ key: "interest", labelKey: "profile.tabInterest" },
				{ key: "projects", labelKey: "profile.tabProjects" },
				{ key: "comm", labelKey: "profile.tabComm" },
				{ key: "psy", labelKey: "profile.tabPsy" },
			];
			const entryBox = { borderLeft: "2px solid var(--dsw-alias-border-l2)", paddingLeft: 8, margin: "6px 0" };
			// v1.9.3：分区条目一多就顶到屏幕外，给个固定高度的滚动区。
			const scrollBox = { maxHeight: 320, overflowY: "auto", padding: "4px 6px", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 6 };
			const groupHead = { fontSize: 12.5, fontWeight: 600, margin: "10px 0 2px" };
			const entryHead = { fontSize: 12, color: "var(--dsw-alias-label-tertiary)", marginBottom: 2, wordBreak: "break-word" };
			const entryBody = { fontSize: 12.5, lineHeight: 1.65, whiteSpace: "pre-wrap", wordBreak: "break-word", color: "var(--dsw-alias-label-secondary)", margin: "2px 0" };
			const tabRow = { display: "flex", flexWrap: "wrap", gap: 6, margin: "6px 0" };
			function ProfileSection() {
				const [data, setData] = React.useState(null);
				const [digest, setDigest] = React.useState(null);
				const [tab, setTab] = React.useState("interest");
				const [error, setError] = React.useState(null);
				const [status, setStatus] = React.useState("");
				const load = React.useCallback(() => {
					rpc("profile.partitions").then(setData, (e) => setError(String(e).slice(0, 120)));
					rpc("profile.digest").then(setDigest, () => { /* 引擎室输入是附加视图，失败不挡分区 */ });
				}, []);
				React.useEffect(() => { load(); }, [load]);
				const doExport = () => rpc("profile.export").then(
					(v) => setStatus(L("profile.exported", { path: v.path })),
					(e) => setError(String(e).slice(0, 120)),
				);
				if (error) return React.createElement("div", { style: hintStyle }, L("common.loadFailed", { error }));
				if (!data) return React.createElement("div", { style: hintStyle }, t("common.loading"));
				const groups = data.partitions || {};
				const group = groups[tab] || { total: 0, valid: 0, entries: [] };
				const entries = group.entries || [];
				const tabButton = (key, label, count) => React.createElement("button", {
					key,
					style: tab === key ? buttonStyle : buttonGhost,
					onClick: () => setTab(key),
				}, count === undefined ? label : L("common.labelWithCount", { label, count }));
				const om = (digest && digest.omitted) || { tact: 0, topic: 0, wander: 0 };
				return React.createElement(
					"div",
					{ style: listStyle },
					React.createElement("div", { style: tabRow },
						PARTITIONS.map((p) => tabButton(p.key, t(p.labelKey), (groups[p.key] || {}).valid || 0)),
						tabButton("__engine", t("profile.engine"))),
					tab === "__engine"
						? React.createElement("div", null,
							React.createElement("div", { style: hintStyle }, digest
								? L("profile.digest", { total: digest.totalChars, budget: digest.budgetChars, budgetState: digest.withinBudget ? t("profile.withinBudget") : t("profile.overBudget"), tact: om.tact, topic: om.topic, wander: om.wander })
								: t("common.loading")),
							React.createElement("div", { style: scrollBox },
								React.createElement("div", null,
									React.createElement("b", null, t("profile.tactFacet")),
									React.createElement("div", { style: entryBody }, (digest && digest.tact) || t("common.empty"))),
								React.createElement("div", null,
									React.createElement("b", null, t("profile.topicFacet")),
									React.createElement("div", { style: entryBody }, (digest && digest.topic) || t("common.empty"))),
								React.createElement("div", null,
									React.createElement("b", null, t("profile.wanderFacet")),
									React.createElement("div", { style: entryBody }, (digest && digest.wander) || t("common.empty")))))
						: React.createElement("div", null,
							React.createElement("div", { style: hintStyle }, L("profile.valid", { valid: group.valid, historical: group.total - group.valid })),
							entries.length === 0
								? React.createElement("div", { style: hintStyle }, t("profile.emptyPartition"))
								: React.createElement("div", { style: scrollBox }, entries.map((e) => React.createElement("div", { key: e.id || (String(e.topic) + String(e.content).slice(0, 12)), style: entryBox },
									React.createElement("div", { style: entryHead },
										(e.topic || "") + "/" + (e.subTopic || "")
										+ L("profile.conf", { value: Number(e.confidence || 0).toFixed(2) })
										+ (e.temporal ? L("profile.temporal", { value: e.temporal }) : "")
										+ (e.lowActivity ? t("profile.stale") : "")
										+ (e.updatedAt ? L("profile.updated", { date: String(e.updatedAt).slice(0, 10) }) : "")),
									React.createElement("div", { style: entryBody }, e.content || ""))))),
					React.createElement("div", { style: rowStyle },
						React.createElement("button", { style: buttonGhost, onClick: () => { load(); } }, t("common.refresh")),
						React.createElement("button", { style: buttonGhost, onClick: () => { void doExport(); } }, t("profile.exportMarkdown"))),
					status ? React.createElement("div", { style: hintStyle }, status) : null,
				);
			}

			// ── 配置 + 账本 ───────────────────────────────────────────────
			// 节律配置走 RPC + 宿主侧 data/settings/ui.json（v1.7.0）：
			// 三代宿主（0.1.1 scope / 0.1.5 installSection / 0.1.7 profile
			// 表单）行为统一，保存即时生效、无需重载。
			function ConfigSection() {
				const [value, setValue] = React.useState(null);
				const [loadErr, setLoadErr] = React.useState(null);
				React.useEffect(() => {
					rpc("config.get").then(setValue, (e) => setLoadErr(String(e).slice(0, 100)));
				}, []);
				const interval = value && Number(value.intervalMin) > 0 ? Number(value.intervalMin) : 60;
				const cap = value && Number(value.maxDailySend) > 0 ? Number(value.maxDailySend) : 10;
				const timeInject = value && value.timeInjectMin === 0 ? 0 : (value && Number(value.timeInjectMin) > 0 ? Number(value.timeInjectMin) : 25);
				const statusbar = !!value && value.statusbar === true;
				const idleMode = !!value && value.idleMode === true;
				const tokenSaver = !!value && value.tokenSaver === true;
				const psyEnabled = !!value && value.psyEnabled === true;
				const [draftInterval, setDraftInterval] = React.useState(interval);
				const [draftCap, setDraftCap] = React.useState(cap);
				const [draftTimeInject, setDraftTimeInject] = React.useState(timeInject);
				const [draftStatusbar, setDraftStatusbar] = React.useState(statusbar);
				const [draftIdle, setDraftIdle] = React.useState(idleMode);
				const [draftTokenSaver, setDraftTokenSaver] = React.useState(tokenSaver);
				const [draftPsy, setDraftPsy] = React.useState(psyEnabled);
				const [status, setStatus] = React.useState("");
				React.useEffect(() => { setDraftInterval(interval); setDraftCap(cap); setDraftTimeInject(timeInject); setDraftStatusbar(statusbar); setDraftIdle(idleMode); setDraftTokenSaver(tokenSaver); setDraftPsy(psyEnabled); }, [interval, cap, timeInject, statusbar, idleMode, tokenSaver, psyEnabled]);
				const save = async () => {
					try {
						const di = Math.max(1, Math.min(1440, Math.floor(Number(draftInterval) || 0)));
						const dc = Math.max(1, Math.min(50, Math.floor(Number(draftCap) || 0)));
						const dt = Math.max(0, Math.min(1440, Math.floor(Number(draftTimeInject) || 0)));
						const v = await rpc("config.set", {
							intervalMin: di,
							maxDailySend: dc,
							timeInjectMin: dt,
							statusbar: !!draftStatusbar,
							idleMode: !!draftIdle,
							tokenSaver: !!draftTokenSaver,
							psyEnabled: !!draftPsy,
						});
						setValue(v);
						setStatus(t("config.saved"));
					} catch (e) {
						setStatus(L("config.saveFailed", { error: String(e).slice(0, 80) }));
					}
				};
				if (loadErr && !value) return React.createElement("div", { style: hintStyle }, L("common.loadFailed", { error: loadErr }));
				if (!value) return React.createElement("div", { style: hintStyle }, t("common.loading"));
				return React.createElement(
					"div",
					null,
					React.createElement("div", { style: rowStyle },
						React.createElement("span", { style: labelStyle }, t("config.interval")),
						React.createElement("input", { style: inputStyle, type: "number", min: 1, max: 1440, value: draftInterval, onChange: (e) => setDraftInterval(e.target.value) })),
					React.createElement("div", { style: rowStyle },
						React.createElement("span", { style: labelStyle }, t("config.cap")),
						React.createElement("input", { style: inputStyle, type: "number", min: 1, max: 50, value: draftCap, onChange: (e) => setDraftCap(e.target.value) })),
					React.createElement("div", { style: rowStyle },
						React.createElement("span", { style: labelStyle }, t("config.timeInject")),
						React.createElement("input", { style: inputStyle, type: "number", min: 0, max: 1440, value: draftTimeInject, onChange: (e) => setDraftTimeInject(e.target.value) }),
						React.createElement("span", { style: hintStyle }, t("config.timeInjectOff"))),
					React.createElement("div", { style: rowStyle },
						React.createElement("span", { style: labelStyle }, t("config.statusbar")),
						React.createElement("button", { style: draftStatusbar ? buttonStyle : buttonGhost, onClick: () => setDraftStatusbar(!draftStatusbar) }, draftStatusbar ? "☑ " + t("common.on") : "☐ " + t("common.off")),
						React.createElement("span", { style: hintStyle }, t("config.statusbarHint"))),
					React.createElement("div", { style: rowStyle },
						React.createElement("span", { style: labelStyle }, t("config.idle")),
						React.createElement("button", { style: draftIdle ? buttonStyle : buttonGhost, onClick: () => setDraftIdle(!draftIdle) }, draftIdle ? "☑ " + t("common.on") : "☐ " + t("common.off")),
						React.createElement("span", { style: hintStyle }, t("config.idleHint"))),
					React.createElement("div", { style: rowStyle },
						React.createElement("span", { style: labelStyle }, t("config.tokenSaver")),
						React.createElement("button", { style: draftTokenSaver ? buttonStyle : buttonGhost, onClick: () => setDraftTokenSaver(!draftTokenSaver) }, draftTokenSaver ? "☑ " + t("common.on") : "☐ " + t("common.off")),
						React.createElement("span", { style: hintStyle }, t("config.tokenSaverHint"))),
					React.createElement("div", { style: rowStyle },
						React.createElement("span", { style: labelStyle }, t("config.psy")),
						React.createElement("button", { style: draftPsy ? buttonStyle : buttonGhost, onClick: () => setDraftPsy(!draftPsy) }, draftPsy ? "☑ " + t("common.on") : "☐ " + t("common.off")),
						React.createElement("span", { style: hintStyle }, t("config.psyHint"))),
					React.createElement("div", { style: rowStyle },
						React.createElement("button", { style: buttonStyle, onClick: () => { void save(); } }, t("common.save")),
						React.createElement("span", { style: hintStyle }, status || t("config.saveHint"))),
				);
			}

			// ── 周报（v1.8.0）────────────────────────────────────────────
			// 每 7 天一份：代码收集本周事实 → 引擎室写成中性叙述（自称「心跳」，
			// 不是会话里的 agent）。报告 DPAPI 加密落盘，这里解密展示。
			function WeeklySection() {
				const [data, setData] = React.useState(null);
				const [error, setError] = React.useState(null);
				const [selected, setSelected] = React.useState("");
				const [text, setText] = React.useState(null);
				const loadReport = React.useCallback((file) => {
					setSelected(file);
					rpc("weekly.get", { file }).then((r) => setText(r.text), (e) => setError(String(e).slice(0, 100)));
				}, []);
				const reload = React.useCallback(() => {
					rpc("weekly.list").then(
						(v) => {
							setData(v.reports);
							setText(null);
							if (v.reports && v.reports.length > 0) loadReport(v.reports[0].file);
						},
						(e) => setError(String(e).slice(0, 100)),
					);
				}, [loadReport]);
				React.useEffect(() => { reload(); }, [reload]);
				if (error) return React.createElement("div", { style: hintStyle }, L("common.loadFailed", { error }));
				if (!data) return React.createElement("div", { style: hintStyle }, t("common.loading"));
				return React.createElement(
					"div",
					null,
					React.createElement("div", { style: hintStyle }, t("weekly.intro")),
					data.length === 0 ? React.createElement("div", { style: hintStyle }, t("weekly.empty")) : null,
					data.length > 1 ? React.createElement("div", { style: rowStyle },
						data.map((r) => React.createElement("button", {
							key: r.file,
							style: r.file === selected ? buttonStyle : buttonGhost,
							onClick: () => loadReport(r.file),
						}, r.end.slice(0, 10))),
					) : null,
					text ? React.createElement("pre", { style: { whiteSpace: "pre-wrap", margin: "4px 0", fontSize: 12 } }, text) : null,
					React.createElement("div", { style: rowStyle },
						React.createElement("button", { style: buttonGhost, onClick: () => { void reload(); } }, t("common.refresh"))),
				);
			}

			// ── 换机迁移（v1.8.0）────────────────────────────────────────
			// 打包画像/账本/素材池等为口令加密容器（AES-256-GCM），新机器导入时
			// 用本机 DPAPI 重新加密。口令只在这一次调用里出现，不落盘不进日志。
			function MigrateSection() {
				const [pw1, setPw1] = React.useState("");
				const [pw2, setPw2] = React.useState("");
				const [importFile, setImportFile] = React.useState("");
				const [importPw, setImportPw] = React.useState("");
				const [status, setStatus] = React.useState("");
				const busy = React.useRef(false);
				const run = (fn) => {
					if (busy.current) return;
					busy.current = true;
					setStatus(t("migrate.processing"));
					fn().catch((e) => setStatus(L("migrate.failed", { error: String(e).slice(0, 120) }))).finally(() => { busy.current = false; });
				};
				const doExport = () => run(async () => {
					if (!pw1 || pw1 !== pw2) { setStatus(t("migrate.pwMismatch")); return; }
					const v = await rpc("migrate.export", { passphrase: pw1 });
					setPw1(""); setPw2("");
					setStatus(L("migrate.exported", { count: v.count, path: v.path }));
				});
				const doImport = () => run(async () => {
					if (!importFile || !importPw) { setStatus(t("migrate.needInput")); return; }
					const v = await rpc("migrate.import", { file: importFile.trim(), passphrase: importPw });
					setImportPw("");
					setStatus(L("migrate.imported", { restored: v.restored.length, backedUp: v.backedUp.length, skipped: v.skipped.length }));
				});
				return React.createElement(
					"div",
					null,
					React.createElement("div", { style: hintStyle }, t("migrate.intro")),
					React.createElement("div", { style: { ...hintStyle, marginTop: 6, fontWeight: 600 } }, t("migrate.exportHeading")),
					React.createElement("div", { style: rowStyle },
						React.createElement("input", { style: inputStyle, type: "password", placeholder: t("migrate.pwPlaceholder"), value: pw1, onChange: (e) => setPw1(e.target.value) }),
						React.createElement("input", { style: inputStyle, type: "password", placeholder: t("migrate.pwAgainPlaceholder"), value: pw2, onChange: (e) => setPw2(e.target.value) }),
						React.createElement("button", { style: buttonStyle, onClick: () => { void doExport(); } }, t("migrate.exportButton")),
					),
					React.createElement("div", { style: { ...hintStyle, marginTop: 6, fontWeight: 600 } }, t("migrate.importHeading")),
					React.createElement("div", { style: rowStyle },
						React.createElement("input", { style: { ...inputStyle, width: 220 }, placeholder: t("migrate.filePlaceholder"), value: importFile, onChange: (e) => setImportFile(e.target.value) }),
						React.createElement("input", { style: inputStyle, type: "password", placeholder: t("migrate.pwPlaceholderShort"), value: importPw, onChange: (e) => setImportPw(e.target.value) }),
						React.createElement("button", { style: buttonStyle, onClick: () => { void doImport(); } }, t("migrate.importButton")),
					),
					status ? React.createElement("div", { style: hintStyle }, status) : null,
				);
			}

			// ── 主卡片 ────────────────────────────────────────────────────
			function HeartbeatSection() {
				const [ledgerMsg, setLedgerMsg] = React.useState("");
				const openLedger = () => rpc("ledger.open").then(
					(v) => setLedgerMsg(L("ledger.opened", { path: v.path })),
					(e) => setLedgerMsg(L("ledger.failed", { error: String(e).slice(0, 80) })),
				);
				const [excerptMsg, setExcerptMsg] = React.useState("");
				const openExcerpt = () => rpc("excerpt.open").then(
					(v) => setExcerptMsg(L("excerpt.opened", { path: v.path })),
					(e) => setExcerptMsg(L("excerpt.failed", { error: String(e).slice(0, 80) })),
				);
				return React.createElement(
					"div",
					{ style: { padding: "2px 0" } },
					React.createElement(Section, { title: t("section.status"), open: true }, React.createElement(StatusCard, null)),
					React.createElement(Section, { title: t("section.sessions") }, React.createElement(SessionsSection, null)),
					React.createElement(Section, { title: t("section.seeds") }, React.createElement(SeedsSection, null)),
					React.createElement(Section, { title: t("section.interests") }, React.createElement(InterestsSection, null)),
					React.createElement(Section, { title: t("section.profile") }, React.createElement(ProfileSection, null)),
					React.createElement(Section, { title: t("section.ledger") }, React.createElement(
						"div",
						null,
						React.createElement("div", { style: rowStyle },
							React.createElement("button", { style: buttonStyle, onClick: () => { void openLedger(); } }, t("ledger.open")),
							React.createElement("span", { style: hintStyle }, ledgerMsg || t("ledger.hint"))),
					)),
					React.createElement(Section, { title: t("section.excerpt") }, React.createElement(
						"div",
						null,
						React.createElement("div", { style: rowStyle },
							React.createElement("button", { style: buttonStyle, onClick: () => { void openExcerpt(); } }, t("excerpt.open")),
							React.createElement("span", { style: hintStyle }, excerptMsg || t("excerpt.hint"))),
						)),
					React.createElement(Section, { title: t("section.weekly") }, React.createElement(WeeklySection, null)),
					React.createElement(Section, { title: t("section.migrate") }, React.createElement(MigrateSection, null)),
					React.createElement(Section, { title: t("section.config") }, React.createElement(ConfigSection, null)),
				);
			}

			try {
				ctx.slots.inject("settings.section", function* () {
					yield ctx.slots.register(
						{ name: "settings.section", id: "dsh-heartbeat", order: 20, locale: LOCALE_NS, label: () => t("settings.row.label") },
						HeartbeatSection,
					);
				});
			} catch (e) {
				console.warn("[dsh-heartbeat] settings.section slot unavailable", e);
			}
		}

		// settingsScope deliberately absent: removed in DSH 0.1.7 (its client
		// service no longer exists; declaring it stalls the whole client bundle
		// on a "waiting for service" and blocks the web UI from booting).
		exports.inject = ["slots", "sessions", "locale"];
		exports.apply = apply;
		return module.exports;
	},
});
