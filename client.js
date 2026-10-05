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
			const getConnection = () => {
				try { return ctx.get("connection"); } catch { return undefined; }
			};
			const rpc = async (endpoint, payload) => {
				const conn = getConnection();
				if (!conn || !conn.rpc || typeof conn.rpc.call !== "function") {
					throw new Error("RPC 通道不可用（请确认 DSH 正在运行）");
				}
				// C21：0.1.5 起自定义 rpc.handle 通道不可用，宿主侧改为 /api 下的精确
				// Fetch 路由；端点名走 payload.endpoint 字段（信封与 /api 同构）。
				const result = await conn.rpc.call("/api", "heartbeat", { endpoint, ...(payload ?? {}) }, undefined);
				if (!result || result.ok !== true) {
				 throw new Error((result && result.error && result.error.message) || "RPC 调用失败");
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
					const t = setInterval(() => { rpc("status").then((v) => setStateSafe(v)).catch(() => {}); }, 30000);
					return () => clearInterval(t);
				}, []);
				const stateRef = React.useRef(null);
				function setStateSafe(v) { stateRef.current = v; force(); }
				const [, force] = React.useReducer((x) => x + 1, 0);
				const view = stateRef.current || value;
				if (loading && !view) return React.createElement("div", { style: hintStyle }, "加载中…");
				if (error) return React.createElement("div", { style: hintStyle }, "状态获取失败：" + error);
				const lb = view.lastBeat || {};
				const verdictText = lb.verdict === "spoke" ? "说了：" + (lb.text || "").slice(0, 60)
					: lb.verdict === "silent" ? "沉默（" + (lb.reason || "") + "）"
					: lb.verdict === "spoke_failed" ? "投递失败（" + (lb.reason || "") + "）"
					: lb.verdict === "error" ? "心跳异常（" + (lb.reason || "") + "）" : "尚无记录";
				const sb = view.statusbar || {};
				const SCENE_LABELS = {
					"quiet-hours": "静默时段，世界睡了",
					"just-spoke": "刚去和你说过话",
					"wandering": "正在闲逛看新东西",
					"busy": "看到你在忙，不去打扰",
					"present": "在场待着",
					"away": "你不在，自己待着",
				};
				const statusText = sb.lastStatus
					? "心跳此刻：" + (SCENE_LABELS[sb.lastStatus.scene] || sb.lastStatus.scene) + (sb.lastStatus.note ? "——" + sb.lastStatus.note : "")
					: "心跳此刻：（还没有状态记录）";
				return React.createElement(
					"div",
					{ style: listStyle },
					React.createElement("div", null, "插件版本：v" + (view.version || "未知")),
					React.createElement("div", null, "上次心跳：", fmtTime(lb.at)),
					React.createElement("div", null, "结果：", verdictText),
					React.createElement("div", null, "今日表达：", view.cap.used, " / ", view.cap.max, " 条"),
					React.createElement("div", null, view.quiet ? "当前：静默时段内" : "当前：正常节律（间隔 " + view.intervalMin + " 分钟）"),
					React.createElement("div", null, sb.enabled === false ? statusText + "（状态栏已关闭）" : statusText),
					React.createElement("div", { style: hintStyle },
						"时间注入：", sb.timeInjectMin === 0 ? "已关闭"
							: "每 " + sb.timeInjectMin + " 分钟，最近 " + (sb.lastTimeInjectAt ? fmtTime(sb.lastTimeInjectAt) : "未发生过")),
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
				if (error) return React.createElement("div", { style: hintStyle }, "加载失败：" + error);
				if (!data) return React.createElement("div", { style: hintStyle }, "加载中…");
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
				const nameOf = (s) => s.title || (s.home ? "心跳正身（引擎室）" : s.id.slice(0, 19) + "…");
				const q = query.trim().toLowerCase();
				const matches = (s) => !q || nameOf(s).toLowerCase().includes(q) || s.id.toLowerCase().includes(q);
				const unbound = data.sessions.filter((s) => !s.deliver && !s.observe && matches(s));
				return React.createElement(
					"div",
					null,
					React.createElement("div", { style: hintStyle }, "绑定 = 表达投递 + 对话观察（D13），两个开关可以同时开，也可以在下面逐个切换。心跳正身的思考轮次固定在其自身会话，不受绑定影响。"),
					bound.map((s) => React.createElement("div", { key: s.id, style: rowList },
						React.createElement("span", { style: { flex: 1, fontSize: 12 } },
							"🔗 ", nameOf(s), "（", s.deliver ? "投递" : "", s.deliver && s.observe ? "+" : "", s.observe ? "观察" : "", "）"),
						React.createElement("span", { style: { display: "flex", gap: 4 } },
							React.createElement("button", { style: flagStyle(s.deliver), title: s.deliver ? "点击关闭投递" : "点击开启投递", onClick: () => setFlags(s.id, !s.deliver, s.observe) }, (s.deliver ? "☑ " : "☐ ") + "投递"),
							React.createElement("button", { style: flagStyle(s.observe), title: s.observe ? "点击关闭观察" : "点击开启观察", onClick: () => setFlags(s.id, s.deliver, !s.observe) }, (s.observe ? "☑ " : "☐ ") + "观察"),
							React.createElement("button", { style: buttonGhost, onClick: () => doUnbind(s.id) }, "解绑"),
						),
					)),
					bound.length === 0 ? React.createElement("div", { style: hintStyle }, "（暂无绑定会话——表达只出现在心跳正身会话）") : null,
					React.createElement("div", { style: rowStyle },
						React.createElement("button", { style: buttonGhost, onClick: () => setShowUnbound(!showUnbound) }, showUnbound ? "收起未绑定列表" : "绑定其他会话（" + unbound.length + "）")),
					showUnbound ? React.createElement(
						"div",
						null,
						React.createElement("input", { style: { ...inputStyle, width: "100%", margin: "4px 0", boxSizing: "border-box" }, placeholder: "按会话名或 id 过滤…", value: query, onChange: (e) => setQuery(e.target.value) }),
						unbound.length === 0 ? React.createElement("div", { style: hintStyle }, "（无匹配会话）") : null,
						unbound.map((s) => React.createElement("div", { key: s.id, style: rowList },
							React.createElement("span", { style: { flex: 1, fontSize: 12 } }, nameOf(s), s.home ? "（心跳正身，无需绑定）" : ""),
							s.home ? null : React.createElement(
								"span",
								{ style: { display: "flex", gap: 4 } },
								React.createElement("button", { style: buttonStyle, onClick: () => doBind(s.id, true, false) }, "绑定投递"),
								React.createElement("button", { style: buttonGhost, onClick: () => doBind(s.id, false, true) }, "绑定观察"),
								React.createElement("button", { style: buttonGhost, onClick: () => doBind(s.id, true, true) }, "投递+观察"),
							),
						)),
					) : null,
				);
			}

			// ── 素材池 ────────────────────────────────────────────────────
			function SeedsSection() {
				const [data, setData] = React.useState(null);
				const [error, setError] = React.useState(null);
				const [showArchived, setShowArchived] = React.useState(false);
				const [confirmId, setConfirmId] = React.useState(null);
				const reload = React.useCallback(() => {
					rpc("seeds.list").then(setData, (e) => setError(String(e).slice(0, 100)));
				}, []);
				React.useEffect(() => { reload(); }, [reload]);
				if (error) return React.createElement("div", { style: hintStyle }, "加载失败：" + error);
				if (!data) return React.createElement("div", { style: hintStyle }, "加载中…");
				const act = (endpoint, id) => rpc(endpoint, { id }).then(reload, (e) => setError(String(e).slice(0, 100)));
				const row = (s, archived) => React.createElement("div", { key: s.id, style: rowList },
					React.createElement("span", { style: { flex: 1, fontSize: 12 } },
						"[", s.tag, "/", s.source, "] ", s.text.slice(0, 42), "  used:", s.used),
					archived
						? React.createElement("button", { style: buttonGhost, onClick: () => act("seeds.restore", s.id) }, "恢复")
						: React.createElement("button", { style: buttonGhost, onClick: () => act("seeds.archive", s.id) }, "归档"),
					confirmId === s.id
						? React.createElement("button", { style: { ...buttonStyle, background: "#e5484d" }, onClick: () => { setConfirmId(null); act("seeds.delete", s.id); } }, "确认删除")
						: React.createElement("button", { style: buttonGhost, onClick: () => setConfirmId(s.id) }, "删除"),
				);
				return React.createElement(
					"div",
					null,
					React.createElement("div", { style: hintStyle }, "活跃 ", data.active.length, " / ", data.cap, " 条"),
					data.active.map((s) => row(s, false)),
					data.active.length === 0 ? React.createElement("div", { style: hintStyle }, "（池子是空的——浏览流和画像会慢慢喂养它）") : null,
					React.createElement("div", { style: rowStyle },
						React.createElement("button", { style: buttonGhost, onClick: () => setShowArchived(!showArchived) }, showArchived ? "收起归档区" : "归档区（" + data.archived.length + "）")),
					showArchived ? data.archived.map((s) => row(s, true)) : null,
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
				if (error) return React.createElement("div", { style: hintStyle }, "加载失败：" + error);
				if (!data) return React.createElement("div", { style: hintStyle }, "加载中…");
				const interests = data.interests || [];
				const doAdd = () => {
					const text = draft.trim();
					if (!text) return;
					rpc("interests.add", { text }).then(
						() => { setDraft(""); setStatus("已添加"); reload(); },
						(e) => setStatus("添加失败：" + String(e).slice(0, 80)),
					);
				};
				const doRemove = (text) => rpc("interests.remove", { text }).then(
					() => { setConfirmText(null); setStatus("已删除"); reload(); },
					(e) => { setConfirmText(null); setStatus("删除失败：" + String(e).slice(0, 80)); },
				);
				const saveWindows = () => {
					rpc("interests.setWindows", { windows: draftWindows }).then(
						() => { setStatus("浏览时段已保存"); reload(); },
						(e) => setStatus("保存失败：" + String(e).slice(0, 80)),
					);
				};
				const editWindow = (idx, field, value) => setDraftWindows((ws) => ws.map((w, i) => (i === idx ? { ...w, [field]: value } : w)));
				return React.createElement(
					"div",
					null,
					React.createElement("div", { style: hintStyle }, "闲逛搜索按这份清单轮换挑焦点（同一条 3 天内不重复）。增删后即时生效，无需重启。"),
					interests.map((t) => React.createElement("div", { key: t, style: rowList },
						React.createElement("span", { style: { flex: 1, fontSize: 12 } }, t),
						confirmText === t
							? React.createElement("button", { style: { ...buttonStyle, background: "#e5484d" }, onClick: () => doRemove(t) }, "确认删除")
							: React.createElement("button", { style: buttonGhost, onClick: () => setConfirmText(t) }, "删除"),
					)),
					interests.length === 0 ? React.createElement("div", { style: hintStyle }, "（清单是空的——闲逛将没有焦点可挑）") : null,
					React.createElement("div", { style: rowStyle },
						React.createElement("input", { style: { ...inputStyle, width: 240 }, placeholder: "新兴趣，如：天文摄影", value: draft, onChange: (e) => setDraft(e.target.value), onKeyDown: (e) => { if (e.key === "Enter") doAdd(); } }),
						React.createElement("button", { style: buttonStyle, onClick: doAdd }, "添加"),
					),
					React.createElement("div", { style: { ...hintStyle, marginTop: 10 } }, "浏览时段（闲逛只在这些窗口内发生；起始须早于结束，多个时段不能重叠）："),
					(draftWindows || []).map((w, idx) => React.createElement("div", { key: idx, style: rowList },
						React.createElement("input", { style: inputStyle, type: "time", value: w.start, onChange: (e) => editWindow(idx, "start", e.target.value) }),
						React.createElement("span", { style: hintStyle }, "到"),
						React.createElement("input", { style: inputStyle, type: "time", value: w.end, onChange: (e) => editWindow(idx, "end", e.target.value) }),
						(draftWindows.length > 1) ? React.createElement("button", { style: buttonGhost, onClick: () => setDraftWindows((ws) => ws.filter((_, i) => i !== idx)) }, "移除") : null,
					)),
					React.createElement("div", { style: rowStyle },
						React.createElement("button", { style: buttonGhost, onClick: () => setDraftWindows((ws) => [...(ws || []), { id: "", start: "11:00", end: "13:00" }]) }, "加一个时段"),
						React.createElement("button", { style: buttonStyle, onClick: saveWindows }, "保存时段"),
					),
					status ? React.createElement("div", { style: hintStyle }, status) : null,
				);
			}

			// ── 画像入口 ──────────────────────────────────────────────────
			function ProfileSection() {
				const [data, setData] = React.useState(null);
				const [error, setError] = React.useState(null);
				const load = React.useCallback(() => {
					rpc("profile.digest").then(setData, (e) => setError(String(e).slice(0, 100)));
				}, []);
				React.useEffect(() => { load(); }, [load]);
				const doExport = () => rpc("profile.export").then(
					(v) => setData((d) => ({ ...d, exported: v.path })),
					(e) => setError(String(e).slice(0, 100)),
				);
				if (error) return React.createElement("div", { style: hintStyle }, "加载失败：" + error);
				if (!data) return React.createElement("div", { style: hintStyle }, "加载中…");
				return React.createElement(
					"div",
					{ style: listStyle },
					React.createElement("div", null, React.createElement("b", null, "处境切面"), React.createElement("pre", { style: { whiteSpace: "pre-wrap", margin: "2px 0", fontSize: 12 } }, data.tact || "(空)")),
					React.createElement("div", null, React.createElement("b", null, "话题切面"), React.createElement("pre", { style: { whiteSpace: "pre-wrap", margin: "2px 0", fontSize: 12 } }, data.topic || "(空)")),
					React.createElement("div", { style: rowStyle },
						React.createElement("button", { style: buttonGhost, onClick: () => { load(); } }, "刷新"),
						React.createElement("button", { style: buttonGhost, onClick: () => { void doExport(); } }, "导出 Markdown")),
					data.exported ? React.createElement("div", { style: hintStyle }, "已导出：" + data.exported) : null,
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
				const interval = value && Number(value.intervalMin) > 0 ? Number(value.intervalMin) : 20;
				const cap = value && Number(value.maxDailySend) > 0 ? Number(value.maxDailySend) : 3;
				const timeInject = value && value.timeInjectMin === 0 ? 0 : (value && Number(value.timeInjectMin) > 0 ? Number(value.timeInjectMin) : 25);
				const statusbar = !value || value.statusbar !== false;
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
						setStatus("已保存（即时生效，无需重启）");
					} catch (e) {
						setStatus("保存失败：" + String(e).slice(0, 80));
					}
				};
				if (loadErr && !value) return React.createElement("div", { style: hintStyle }, "加载失败：" + loadErr);
				if (!value) return React.createElement("div", { style: hintStyle }, "加载中…");
				return React.createElement(
					"div",
					null,
					React.createElement("div", { style: rowStyle },
						React.createElement("span", { style: labelStyle }, "心跳间隔（分钟）"),
						React.createElement("input", { style: inputStyle, type: "number", min: 1, max: 1440, value: draftInterval, onChange: (e) => setDraftInterval(e.target.value) })),
					React.createElement("div", { style: rowStyle },
						React.createElement("span", { style: labelStyle }, "每日表达上限（条）"),
						React.createElement("input", { style: inputStyle, type: "number", min: 1, max: 50, value: draftCap, onChange: (e) => setDraftCap(e.target.value) })),
					React.createElement("div", { style: rowStyle },
						React.createElement("span", { style: labelStyle }, "时间注入间隔（分钟）"),
						React.createElement("input", { style: inputStyle, type: "number", min: 0, max: 1440, value: draftTimeInject, onChange: (e) => setDraftTimeInject(e.target.value) }),
						React.createElement("span", { style: hintStyle }, "0 = 关闭")),
					React.createElement("div", { style: rowStyle },
						React.createElement("span", { style: labelStyle }, "状态栏"),
						React.createElement("button", { style: draftStatusbar ? buttonStyle : buttonGhost, onClick: () => setDraftStatusbar(!draftStatusbar) }, draftStatusbar ? "☑ 开启" : "☐ 关闭"),
						React.createElement("span", { style: hintStyle }, "日常会话中的心跳状态感知（会额外消耗token）")),
					React.createElement("div", { style: rowStyle },
						React.createElement("span", { style: labelStyle }, "闲着模式"),
						React.createElement("button", { style: draftIdle ? buttonStyle : buttonGhost, onClick: () => setDraftIdle(!draftIdle) }, draftIdle ? "☑ 开启" : "☐ 关闭"),
						React.createElement("span", { style: hintStyle }, "素材池空时用画像话题兜底主动搭话（闸门仍生效）")),
					React.createElement("div", { style: rowStyle },
						React.createElement("span", { style: labelStyle }, "节省 token 模式"),
						React.createElement("button", { style: draftTokenSaver ? buttonStyle : buttonGhost, onClick: () => setDraftTokenSaver(!draftTokenSaver) }, draftTokenSaver ? "☑ 开启" : "☐ 关闭"),
						React.createElement("span", { style: hintStyle }, "你离开（闲置 ≥30 分钟）或锁屏时整跳暂停，回来自动恢复")),
					React.createElement("div", { style: rowStyle },
						React.createElement("span", { style: labelStyle }, "psy 分区"),
						React.createElement("button", { style: draftPsy ? buttonStyle : buttonGhost, onClick: () => setDraftPsy(!draftPsy) }, draftPsy ? "☑ 开启" : "☐ 关闭"),
						React.createElement("span", { style: hintStyle }, "允许画像记录 psy 分区（警告，开启后模型会主动猜测用户心理并计入用户画像，关闭时画像内容计入内容较少）")),
					React.createElement("div", { style: rowStyle },
						React.createElement("button", { style: buttonStyle, onClick: () => { void save(); } }, "保存"),
						React.createElement("span", { style: hintStyle }, status || "全部参数保存后即时生效，无需重启")),
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
				if (error) return React.createElement("div", { style: hintStyle }, "加载失败：" + error);
				if (!data) return React.createElement("div", { style: hintStyle }, "加载中…");
				return React.createElement(
					"div",
					null,
					React.createElement("div", { style: hintStyle }, "每 7 天生成一份：本周表达与静默、新认识、账本、素材池与活跃高峰。报告只陈述事实，由后台「心跳」署名。"),
					data.length === 0 ? React.createElement("div", { style: hintStyle }, "（还没有周报——装好一周后自动出第一期）") : null,
					data.length > 1 ? React.createElement("div", { style: rowStyle },
						data.map((r) => React.createElement("button", {
							key: r.file,
							style: r.file === selected ? buttonStyle : buttonGhost,
							onClick: () => loadReport(r.file),
						}, r.end.slice(0, 10))),
					) : null,
					text ? React.createElement("pre", { style: { whiteSpace: "pre-wrap", margin: "4px 0", fontSize: 12 } }, text) : null,
					React.createElement("div", { style: rowStyle },
						React.createElement("button", { style: buttonGhost, onClick: () => { void reload(); } }, "刷新")),
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
					setStatus("处理中…");
					fn().catch((e) => setStatus("失败：" + String(e).slice(0, 120))).finally(() => { busy.current = false; });
				};
				const doExport = () => run(async () => {
					if (!pw1 || pw1 !== pw2) { setStatus("两次口令不一致或为空"); return; }
					const v = await rpc("migrate.export", { passphrase: pw1 });
					setPw1(""); setPw2("");
					setStatus("已打包 " + v.count + " 个文件 → " + v.path + "（可拷贝到新机器，口令别丢）");
				});
				const doImport = () => run(async () => {
					if (!importFile || !importPw) { setStatus("需要容器路径与口令"); return; }
					const v = await rpc("migrate.import", { file: importFile.trim(), passphrase: importPw });
					setImportPw("");
					setStatus("恢复 " + v.restored.length + " 个文件，备份 " + v.backedUp.length + " 个，跳过 " + v.skipped.length + " 个——重启 DSH 后生效");
				});
				return React.createElement(
					"div",
					null,
					React.createElement("div", { style: hintStyle }, "换电脑/重装系统时把心跳的记忆带走：导出一个口令加密的迁移包，在新机器上导入。口令丢失无法破解，容器可安全走网盘。"),
					React.createElement("div", { style: { ...hintStyle, marginTop: 6, fontWeight: 600 } }, "① 在这台机器上导出"),
					React.createElement("div", { style: rowStyle },
						React.createElement("input", { style: inputStyle, type: "password", placeholder: "设置口令", value: pw1, onChange: (e) => setPw1(e.target.value) }),
						React.createElement("input", { style: inputStyle, type: "password", placeholder: "再输入一次", value: pw2, onChange: (e) => setPw2(e.target.value) }),
						React.createElement("button", { style: buttonStyle, onClick: () => { void doExport(); } }, "导出迁移包"),
					),
					React.createElement("div", { style: { ...hintStyle, marginTop: 6, fontWeight: 600 } }, "② 在新机器上导入"),
					React.createElement("div", { style: rowStyle },
						React.createElement("input", { style: { ...inputStyle, width: 220 }, placeholder: "迁移包完整路径（.hbmig）", value: importFile, onChange: (e) => setImportFile(e.target.value) }),
						React.createElement("input", { style: inputStyle, type: "password", placeholder: "口令", value: importPw, onChange: (e) => setImportPw(e.target.value) }),
						React.createElement("button", { style: buttonStyle, onClick: () => { void doImport(); } }, "导入"),
					),
					status ? React.createElement("div", { style: hintStyle }, status) : null,
				);
			}

			// ── 主卡片 ────────────────────────────────────────────────────
			function HeartbeatSection() {
				const [ledgerMsg, setLedgerMsg] = React.useState("");
				const openLedger = () => rpc("ledger.open").then(
					(v) => setLedgerMsg("已打开：" + v.path),
					(e) => setLedgerMsg("失败：" + String(e).slice(0, 80)),
				);
				return React.createElement(
					"div",
					{ style: { padding: "2px 0" } },
					React.createElement(Section, { title: "心跳状态", open: true }, React.createElement(StatusCard, null)),
					React.createElement(Section, { title: "会话绑定" }, React.createElement(SessionsSection, null)),
					React.createElement(Section, { title: "素材池" }, React.createElement(SeedsSection, null)),
					React.createElement(Section, { title: "兴趣范围" }, React.createElement(InterestsSection, null)),
					React.createElement(Section, { title: "用户画像（只读）" }, React.createElement(ProfileSection, null)),
					React.createElement(Section, { title: "账本" }, React.createElement(
						"div",
						null,
						React.createElement("div", { style: rowStyle },
							React.createElement("button", { style: buttonStyle, onClick: () => { void openLedger(); } }, "一键打开账本"),
							React.createElement("span", { style: hintStyle }, ledgerMsg || "账本是心跳 agent 的待办与话题来源，可直接手编")),
					)),
					React.createElement(Section, { title: "周报" }, React.createElement(WeeklySection, null)),
					React.createElement(Section, { title: "换机迁移" }, React.createElement(MigrateSection, null)),
					React.createElement(Section, { title: "节律配置" }, React.createElement(ConfigSection, null)),
				);
			}

			try {
				ctx.slots.inject("settings.section", function* () {
					yield ctx.slots.register(
						{ name: "settings.section", id: "dsh-heartbeat", order: 20, label: () => "心跳" },
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
		exports.inject = ["slots", "sessions"];
		exports.apply = apply;
		return module.exports;
	},
});
