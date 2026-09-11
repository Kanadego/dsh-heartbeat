// dsh-heartbeat client half (M6): settings-page card.
//
// Contract notes (verified against dsh-vision-router + dsh-client-ui-settings
// types on 0.1.1-rc.2):
//   - the client module is applied as a CLIENT-SIDE cordis plugin; the
//     ModuleLoader factory must return an object with an "apply" method;
//   - the settings page renders entries contributed to the 'settings.section'
//     slot; each entry = {name, id, order, label, inject} + a React component;
//   - ctx.settingsScope.bind({namespace}) yields a scope with getSnapshot /
//     subscribe / set(field, value) — writes go through the host settings
//     service (loopback-only, process-local persistence);
//   - custom host data flows through an exact Fetch route under /api:
//     ctx.get('connection').rpc.call('/api', 'heartbeat', { endpoint, ...payload }).
window.__ModuleLoader__.load({
	id: "@Kanadego/dsh-heartbeat",
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
			let scope;
			try {
				scope = ctx.settingsScope.bind({ namespace: "heartbeat" });
			} catch (e) {
				console.warn("[dsh-heartbeat] settingsScope unavailable", e);
				return;
			}
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
				return React.createElement(
					"div",
					{ style: listStyle },
					React.createElement("div", null, "上次心跳：", fmtTime(lb.at)),
					React.createElement("div", null, "结果：", verdictText),
					React.createElement("div", null, "今日表达：", view.cap.used, " / ", view.cap.max, " 条"),
					React.createElement("div", null, view.quiet ? "当前：静默时段内" : "当前：正常节律（间隔 " + view.intervalMin + " 分钟）"),
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
			function ConfigSection() {
				const snap = scope.getSnapshot();
				const value = (snap && (snap.value ?? snap.section ?? snap)) || {};
				const interval = Number(value.intervalMin) > 0 ? Number(value.intervalMin) : 20;
				const cap = Number(value.maxDailySend) > 0 ? Number(value.maxDailySend) : 3;
				const [draftInterval, setDraftInterval] = React.useState(interval);
				const [draftCap, setDraftCap] = React.useState(cap);
				const [status, setStatus] = React.useState("");
				React.useEffect(() => { setDraftInterval(interval); setDraftCap(cap); }, [interval, cap]);
				const save = async () => {
					try {
						const di = Math.max(1, Math.min(1440, Math.floor(Number(draftInterval) || 0)));
						const dc = Math.max(1, Math.min(50, Math.floor(Number(draftCap) || 0)));
						await scope.set("intervalMin", di);
						await scope.set("maxDailySend", dc);
						setStatus("已保存（间隔即时生效，无需重启）");
					} catch (e) {
						setStatus("保存失败：" + String(e).slice(0, 80));
					}
				};
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
						React.createElement("button", { style: buttonStyle, onClick: () => { void save(); } }, "保存"),
						React.createElement("span", { style: hintStyle }, status || "间隔保存后即时生效；其余参数在 data/settings/")),
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
					React.createElement(Section, { title: "用户画像（只读）" }, React.createElement(ProfileSection, null)),
					React.createElement(Section, { title: "账本" }, React.createElement(
						"div",
						null,
						React.createElement("div", { style: rowStyle },
							React.createElement("button", { style: buttonStyle, onClick: () => { void openLedger(); } }, "一键打开账本"),
							React.createElement("span", { style: hintStyle }, ledgerMsg || "账本是心跳 agent 的待办与话题来源，可直接手编")),
					)),
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

		exports.inject = ["settingsScope", "slots", "sessions"];
		exports.apply = apply;
		return module.exports;
	},
});
