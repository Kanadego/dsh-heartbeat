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
//     service (loopback-only, process-local persistence).
//
// v1 card scope: heartbeat interval + daily cap (restart to take effect).
window.__ModuleLoader__.load({
	id: "dsh-heartbeat",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");

		const rowStyle = { display: "flex", alignItems: "center", gap: 8, margin: "6px 0" };
		const labelStyle = { minWidth: 140, fontSize: 13, color: "var(--dsw-alias-label-secondary)" };
		const inputStyle = { width: 90, height: 28, borderRadius: 8, border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-specific-input-bg, transparent)", color: "var(--dsw-alias-label-primary)", padding: "0 8px", fontSize: 13 };
		const buttonStyle = { height: 28, padding: "0 14px", borderRadius: 8, border: "none", background: "#339CFF", color: "#fff", fontSize: 13, cursor: "pointer" };
		const hintStyle = { fontSize: 12, color: "var(--dsw-alias-label-tertiary)", margin: "4px 0" };

		function apply(ctx) {
			let scope;
			try {
				scope = ctx.settingsScope.bind({ namespace: "heartbeat" });
			} catch (e) {
				console.warn("[dsh-heartbeat] settingsScope unavailable", e);
				return;
			}

			function HeartbeatSection() {
				const [, force] = React.useReducer((x) => x + 1, 0);
				React.useEffect(() => {
					try { return scope.subscribe(() => force()); } catch { return undefined; }
				}, []);
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
						setStatus("已保存。重启 DSH 后新节律生效。");
					} catch (e) {
						setStatus("保存失败：" + String(e).slice(0, 80));
					}
				};

				return React.createElement(
					"div",
					{ style: { padding: "4px 0" } },
					React.createElement("div", { style: hintStyle }, "琥珀的心跳：定时醒来，维护记忆，按分寸开口。沉默是常态。"),
					React.createElement("div", { style: rowStyle },
						React.createElement("span", { style: labelStyle }, "心跳间隔（分钟）"),
						React.createElement("input", { style: inputStyle, type: "number", min: 1, max: 1440, value: draftInterval, onChange: (e) => setDraftInterval(e.target.value) })),
					React.createElement("div", { style: rowStyle },
						React.createElement("span", { style: labelStyle }, "每日表达上限（条）"),
						React.createElement("input", { style: inputStyle, type: "number", min: 1, max: 50, value: draftCap, onChange: (e) => setDraftCap(e.target.value) })),
					React.createElement("div", { style: rowStyle },
						React.createElement("button", { style: buttonStyle, onClick: () => { void save(); } }, "保存"),
						React.createElement("span", { style: hintStyle }, status || "修改后需重启 DSH 生效")),
					React.createElement("div", { style: hintStyle }, "运行数据与审计日志在工作区 data/ 目录；一键焚毁见 CLI：node dist/cli/index.js burn"),
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

		exports.inject = ["settingsScope", "slots"];
		exports.apply = apply;
		return module.exports;
	},
});
