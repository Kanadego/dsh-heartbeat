// 面板冒烟：不装 React、不进浏览器，用最小假实现把 client.js 的面板跑一遍。
//
// 覆盖的是「运行起来会不会炸」这一层：ModuleLoader 工厂能不能加载、plugins.bundle.config
// 槽位注册的参数对不对、七个 tab 各自的组件能不能渲染出树、summary 视图有没有输出。
// 不覆盖业务正确性（那要真宿主 + 真数据）。rpc 一律返回失败，所以每个 tab 走的是
// 「加载失败」分支——恰恰是最容易被漏测的一条路。
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = process.argv[2] || "client.js";
const SRC = fs.readFileSync(path.isAbsolute(TARGET) ? TARGET : path.join(ROOT, TARGET), "utf8");
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

// ── 万能叶子：任何字段访问都安全，迭代得空数组，字符串化为空串 ──
const anyLeaf = new Proxy(function () {}, {
  get(_t, prop) {
    if (prop === Symbol.iterator) return function* () {};
    if (prop === "then") return undefined;
    if (prop === "length") return 0;
    if (["map", "filter", "slice", "flatMap", "sort", "concat"].includes(prop)) return () => [];
    if (prop === "forEach") return () => {};
    if (prop === Symbol.toPrimitive || prop === "toString" || prop === "valueOf") return () => "";
    if (prop === "toLocaleString") return () => "";
    return anyLeaf;
  },
  apply() { return anyLeaf; },
});

// ── 最小 React：hooks 按 cursor 顺序分配 ──
const st = { cells: [], cursor: 0, effects: [] };
const React = {
  createElement(type, props, ...children) {
    const kids = children.flat(Infinity);
    return { $$el: true, type, props: { ...(props || {}), children: kids.length === 0 ? undefined : kids.length === 1 ? kids[0] : kids } };
  },
  useState(init) {
    const i = st.cursor++;
    if (!(i in st.cells)) st.cells[i] = typeof init === "function" ? init() : init;
    return [st.cells[i], (v) => { st.cells[i] = typeof v === "function" ? v(st.cells[i]) : v; }];
  },
  useReducer(reducer, init) {
    const i = st.cursor++;
    if (!(i in st.cells)) st.cells[i] = init;
    return [st.cells[i], (a) => { st.cells[i] = reducer(st.cells[i], a); }];
  },
  useRef(v) {
    const i = st.cursor++;
    if (!(i in st.cells)) st.cells[i] = { current: v };
    return st.cells[i];
  },
  useEffect(fn) { st.effects.push(fn); },
  useCallback(fn) { return fn; },
  useMemo(fn) { return fn(); },
};

function textOf(node) {
  if (node === null || node === undefined || node === false || node === true) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node.$$el) return typeof node.type === "function" ? "" : textOf(node.props.children);
  if (typeof node === "object") { try { return String(node); } catch { return ""; } }
  return String(node);
}
function render(node, out) {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) { for (const n of node) render(n, out); return; }
  if (!node.$$el) { const s = textOf(node); if (s) out.text.push(s); return; }
  if (typeof node.type === "function") { render(node.type(node.props), out); return; }
  out.tags.push(node.type);
  render(node.props.children, out);
}

// ── 假宿主 ──
let captured = null;
const sandbox = {
  window: { __ModuleLoader__: { load(o) { captured = o; } } },
  console, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
  Promise, Date, JSON, Math, String, Number, Object, Array, Error,
};
vm.createContext(sandbox);
vm.runInContext(SRC, sandbox);

let slotName = null, regOpts = null, regComp = null, injectErr = null;
const ctx = {
  get(name) {
    if (name === "locale") return { register() { return () => {}; }, bind() { return (k) => k; } };
    if (name === "connection") return { rpc: { call: async () => anyLeaf } };
    return undefined;
  },
  effect(fn) { try { fn(); } catch (e) { injectErr = injectErr || e; } },
  slots: {
    inject(name, factory) { slotName = name; try { factory(); } catch (e) { injectErr = e; } },
    register(opts, comp) { regOpts = opts; regComp = comp; return () => {}; },
    entries() { return []; },
  },
};

const mod = captured.factory((id) => (id === "react" ? React : {}));
mod.apply(ctx);

const failures = [];
const check = (ok, label) => { if (!ok) failures.push(label); };

check(slotName === "plugins.bundle.config", "槽位名应为 plugins.bundle.config，实际 " + slotName);
// 槽位 key 必须等于宿主报的 bundle 名（去掉 npm scope 的短名），不是完整包名：
// plugin-manager 用 ledger.bundles.has(pkg.name) 判定，而 pkg.name 来自 Host 的 bundle.name。
const BUNDLE_NAME = PKG.name.includes("/") ? PKG.name.slice(PKG.name.indexOf("/") + 1) : PKG.name;
check(regOpts && regOpts.key === BUNDLE_NAME, "注册 key 应为 bundle 名 " + BUNDLE_NAME + "，实际 " + (regOpts && regOpts.key));
check(!injectErr, "槽位注入抛错：" + (injectErr && (injectErr.message || injectErr)));
if (injectErr) { console.log(JSON.stringify({ ok: false, failures }, null, 2)); process.exit(1); }

const TABS = ["status", "sessions", "seeds", "interests", "profile", "weekly", "config"];
const sleep = (ms) => new Promise((r) => globalThis.setTimeout(r, ms));

async function mountTab(tabId) {
  st.cells = [tabId]; st.cursor = 0; st.effects = [];
  let err = null;
  try { render(regComp({ view: "page" }), { tags: [], text: [] }); } catch (e) { err = e; }
  for (const fn of st.effects) { try { fn(); } catch (e) { err = err || e; } }
  await sleep(20);
  const out = { tags: [], text: [] };
  st.cursor = 0; st.effects = [];
  try { render(regComp({ view: "page" }), out); } catch (e) { err = err || e; }
  return { err, buttons: out.tags.filter((t) => t === "button").length, text: out.text.join(" ").trim() };
}

for (const tab of TABS) {
  const r = await mountTab(tab);
  check(!r.err, "tab " + tab + " 渲染抛错：" + (r.err && (r.err.message || r.err)));
  check(r.buttons >= 7, "tab " + tab + " 的 tab 栏按钮数 " + r.buttons + " < 7");
}

st.cells = []; st.cursor = 0;
let summaryText = "";
try {
  const out = { tags: [], text: [] };
  render(regComp({ view: "summary" }), out);
  summaryText = out.text.join("");
} catch (e) { failures.push("summary 视图抛错：" + e.message); }
check(summaryText.length > 0, "summary 视图没有输出文本");

if (failures.length) {
  console.log(JSON.stringify({ ok: false, failures }, null, 2));
  process.exit(1);
}
console.log("panel smoke OK: 槽位 " + slotName + " / key " + regOpts.key + " / " + TABS.length + " 个 tab 渲染通过");
