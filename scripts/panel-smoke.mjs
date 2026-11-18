// 面板冒烟：不装 React、不进浏览器，用最小假实现把 client.js 的面板跑一遍。
//
// 覆盖的是「运行起来会不会炸」这一层：ModuleLoader 工厂能不能加载、plugins.bundle.config
// 槽位注册的参数对不对、七个 tab 各自的组件能不能渲染出树、summary 视图有没有输出。
// 不覆盖业务正确性（那要真宿主 + 真数据）。rpc 一律返回失败，所以每个 tab 走的是
// 「加载失败」分支——恰恰是最容易被漏测的一条路。
//
// 第二遍起补设置页断言（N7）：引擎下拉按设置卡定位、断言 option 数量与选中值；
// 之后用无 connection 的假宿主加载一遍（只读态，issue #7 / P1-3），再模拟 connection
// 晚到（升级）、以及升级后 connection 瞬时消失（只升不降，不允许降级回只读）；
// 最后用手动闸门扣住一条 rpc、重挂载后再放行，钉住卸载 cleanup（迟到值不许写进新挂载）——
// 判定全部靠桩里记录的结算状态，不依赖任何毫秒阈值。
//
// 只读态的「点击面」逐控件断言：5 个开关必须没有 onClick（同值写入盲区不可构造，
// 见第五遍注释），专注按钮同样不挂、保存按钮点了也不能发 RPC（计数不增）。
//
// 第五遍之后另有两遍补交叉审查（5881e4b9）的覆盖洞：
// ①「只读 + 已暂停」挂载——桩只读挂载就返回 paused（18:30），走 client.js 的
//   resume 分支，钉住它的 onClick / disabled 两个 readonly 半边（删任一半都红）；
// ②阳性控制——挂载拉回 A（18:30）、config.get 成功后补拉回 B（19:00），断言最终
//   显示 B。两种桩形态（默认的「首次回 null」与这里的「真实返回」）都覆盖，
//   deps 写成 [] 在两种形态下都红。
//
// 第九遍（D5）补「可编辑态正向点击面」：前八遍只钉住「只读时不许点」，把 5 个开关与
// 暂停/恢复的 onClick 全改成 undefined、或把 focus 三元恒渲染成 resume 依旧全绿。
// 这里逐控件点一次：开关文案翻转 → 保存后 config.set 逐个键名带出翻转值；6 个非开关
// 键（number/time/select）各走一遍真实 onChange → 保存载荷带出新值；暂停发
// focus.pause 且 minutes 按实测钳制规则（Number(v)||30 → 取整 → [1,1440]）；恢复发
// focus.resume 且按钮回「暂停」；focus/config 失败与成功各自只清自己的红字。
// 另补低6/低1：config.get 与 focus.status 拉取的 alive 守卫（迟到值/迟到失败不许覆盖
// 或污染新挂载），桩级闸门判定，不依赖壁钟；focus.status 桩按 src/rpc.ts 五个字段返回（低5）。
// 点击后的观察一律走 settlePage（render + 提交 effect 直到收敛）：只 render 会漏掉
// 「点击后同步 effect 把 draft 回滚」这类回归。另用非兜底配置钉住配置→draft 同步 effect
// 的每处赋值，并给 config.get 失败补阳性控制（加载失败文案）。
//
// 假 React 的 effect 语义按真实 React 收紧：useEffect 记录依赖数组，首次挂载或
// 依赖浅比较变化才执行；setter 只在值真的变化时把本轮标脏，渲染循环靠 dirty 收敛。
// 因此「删掉挂载重探后的 recheck()」（升级后没有 state 更新 → 界面停在只读）和
// 「把 [readonly] 依赖改成 []」（readonly 变了 effect 不重跑 → config.get/focus.status
// 都不补拉）这两个变异都会被下面的断言抓住。只读态的 config.get 必须真的发出才能计数：
// 第五遍挂载用 failOnce 宿主（探测取不到、之后可用），删掉 if (readonly) return; 直接变红。
//
// 发版前卫生单收口（N22b/N26/N28×5）：A/N22b 的 readonly 半边与 B/N26 的
// 「focus 失败不动 saveErr」早在 D5 的正向点击面与低1 双失败格里钉住（变异实测红，
// 见两处 N22b/N26 注释）；本遍补的是真正还没人看过的五格——
// D1 保存成功→再失败（成功回执必须被失败清掉）、D2 ghost 底色的 alpha 数值区间、
// D3 开态文字色的等值集合（var(...) 不假红、#000 仍红）、D4 settlePage 不再吞
// flush 的 err（不收敛即整遍失败并打印原因）、D5 状态栏 {error} 占位真的渲染、
// 以及点击后观察统一走 settlePage 而不是裸 rerender。
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = process.argv[2] || "client.js";
const SRC = fs.readFileSync(path.isAbsolute(TARGET) ? TARGET : path.join(ROOT, TARGET), "utf8");

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

// ── 最小 React：hooks 按 cursor 顺序分配；effect 记依赖，state 更新标脏 ──
const st = { cells: [], cursor: 0, effectSlots: [], roundEffects: [], dirty: false };

function sameDeps(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((v, i) => Object.is(v, b[i]));
}

const React = {
  createElement(type, props, ...children) {
    const kids = children.flat(Infinity);
    return { $$el: true, type, props: { ...(props || {}), children: kids.length === 0 ? undefined : kids.length === 1 ? kids[0] : kids } };
  },
  useState(init) {
    const i = st.cursor++;
    if (!(i in st.cells)) st.cells[i] = typeof init === "function" ? init() : init;
    return [st.cells[i], (v) => {
      const next = typeof v === "function" ? v(st.cells[i]) : v;
      if (Object.is(next, st.cells[i])) return;
      st.cells[i] = next;
      st.dirty = true;
    }];
  },
  useReducer(reducer, init) {
    const i = st.cursor++;
    if (!(i in st.cells)) st.cells[i] = init;
    return [st.cells[i], (a) => {
      const next = reducer(st.cells[i], a);
      if (Object.is(next, st.cells[i])) return;
      st.cells[i] = next;
      st.dirty = true;
    }];
  },
  useRef(v) {
    const i = st.cursor++;
    if (!(i in st.cells)) st.cells[i] = { current: v };
    return st.cells[i];
  },
  useEffect(fn, deps) { st.roundEffects.push({ index: st.cursor++, fn, deps }); },
  // useCallback/useMemo 必须真的按依赖缓存：否则依赖 [reload] 的加载 effect 每轮都重跑，
  // 每轮 setData 一个新对象，dirty 永远清不掉（假 React 也会假死循环）。
  useCallback(fn, deps) {
    const i = st.cursor++;
    const cell = st.cells[i];
    if (!cell || deps === undefined || !sameDeps(cell.deps, deps)) {
      st.cells[i] = { fn, deps: deps ? deps.slice() : undefined };
    }
    return st.cells[i].fn;
  },
  useMemo(fn, deps) {
    const i = st.cursor++;
    const cell = st.cells[i];
    if (!cell || deps === undefined || !sameDeps(cell.deps, deps)) {
      st.cells[i] = { value: fn(), deps: deps ? deps.slice() : undefined };
    }
    return st.cells[i].value;
  },
};

function commitEffects() {
  for (const { index, fn, deps } of st.roundEffects) {
    const prev = st.effectSlots[index];
    const shouldRun = !prev || deps === undefined || !sameDeps(prev.deps, deps);
    if (!shouldRun) continue;
    if (prev && typeof prev.cleanup === "function") prev.cleanup();
    const cleanup = fn();
    st.effectSlots[index] = { deps: deps ? deps.slice() : undefined, cleanup: typeof cleanup === "function" ? cleanup : null };
  }
}

function textOf(node) {
  if (node === null || node === undefined || node === false || node === true) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node.$$el) return typeof node.type === "function" ? "" : textOf(node.props.children);
  if (typeof node === "object") { try { return String(node); } catch { return ""; } }
  return String(node);
}
function render(node, out, inScope) {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) { for (const n of node) render(n, out, inScope); return; }
  if (!node.$$el) { const s = textOf(node); if (s) out.text.push(s); return; }
  if (typeof node.type === "function") { render(node.type(node.props), out, inScope); return; }
  const scope = !!inScope || (node.props && node.props.className === "hb-config");
  out.tags.push(node.type);
  if (!out.scoped) out.scoped = [];
  if (scope) out.scoped.push(node);
  render(node.props.children, out, scope);
}

// 设置卡（className: hb-config）内的元素由 render 顺带收集，避免二次遍历时
// 重跑函数组件导致 hooks 的 cursor 错位（会读到隔壁 state，选中值就假了）。
// 按卡定位引擎下拉，断言 option 数量与选中值都不受别处 select 干扰。
function engineInfo(out) {
  const nodes = out.scoped || [];
  const select = nodes.find((n) => n.type === "select") || null;
  const kids = select ? (Array.isArray(select.props.children) ? select.props.children : [select.props.children]) : [];
  const options = kids.filter((c) => c && c.$$el && c.type === "option");
  const values = options.map((o) => o.props.value);
  const selectedValue = select ? select.props.value : undefined;
  const selected = options.find((o) => o.props.value === selectedValue);
  return { select, options, values, selectedValue, selectedText: selected ? textOf(selected) : "" };
}
function buttonsIn(out) { return (out.scoped || []).filter((n) => n.type === "button"); }
// locale 服务在场时文案是 key（bind 在冒烟里是恒等函数），不在场时是 zh 字典原文。
function saveButton(out) { return buttonsIn(out).find((b) => ["保存", "common.save"].includes(textOf(b))); }
function hasClass(out, cls) {
  return (out.scoped || []).some((n) => typeof n.props.className === "string" && n.props.className.split(/\s+/).includes(cls));
}
function hasConfigCard(out) {
  return (out.scoped || []).some((n) => n.props && n.props.className === "hb-config");
}

// ── 开关样式判据（N28-D2 / D3）──
// 开=高亮底+白字、关=ghost 灰底+正文色。两个判据都不钉字面量：
//   - 文字色放宽成等值集合：var(--dsw-alias-label-primary) 与 #fff 是同一个颜色，
//     钉 '=== "#fff"' 会在实现换写法时假红（N28-D3）；
//   - ghost 底色的 rgba 前缀相同、只有 alpha 能动，光比前缀连 alpha=0（全透明）
//     和 .95（近乎实心）都放过（N28-D2），所以解析出数值再判区间。
const ON_TEXT_COLORS = ["#fff", "#FFF", "#ffffff", "rgb(255, 255, 255)", "rgb(255,255,255)", "var(--dsw-alias-label-primary)"];
const isOnTextColor = (color) => ON_TEXT_COLORS.includes(String(color == null ? "" : color).trim());
const GHOST_ALPHA_MIN = 0.05;
const GHOST_ALPHA_MAX = 0.3;
function ghostAlpha(style) {
  const bg = style && style.background != null ? String(style.background).trim() : "";
  const m = /^rgba\(\s*127\s*,\s*127\s*,\s*127\s*,\s*(0?\.\d+|0|1)\s*\)$/.exec(bg);
  return m ? Number(m[1]) : null;
}
function isGhostAlpha(alpha) {
  return alpha !== null && alpha >= GHOST_ALPHA_MIN && alpha <= GHOST_ALPHA_MAX;
}

// ── 假宿主 ──
// configValue 是 config.get 的返回值：注入真值让设置页走真实数据分支。
let configValue = null;
// configSetOk=false 时 config.set 一律失败（anyLeaf → result.ok !== true）。
let configSetOk = false;
// statusValue 非空时 status 端点返回正常数据（用于验证晚注册 connection 的状态卡）。
let statusValue = null;
// 手动闸门：statusHoldPending 让下一条 status 请求扣住不结算，releaseStatus 放行。
// 「是否已结算」不在 release 函数体里置位，而是挂在返回给调用方的 promise 链上
// （makeCtx 里 .then 置 settled）：删掉 resolve(...) 时 settled 永远是 false。
// cleanup 用例靠它做桩级判定，不依赖「延迟 N 毫秒」这类壁钟阈值（慢机上 mount
// 本身超时就会假绿）。
let statusHoldPending = false;
let statusGate = null;   // { settled, done }，done 是交给 client 的那条 promise
let releaseStatus = null;
// 同款手动闸门，扣住 focus.status 的一拉：验收 focus 拉取的 alive/卸载守卫（低6）。
let focusStatusHoldPending = false;
let focusStatusGate = null;
let releaseFocusStatus = null;
// 同款闸门，扣住 config.get 的若干拉：验收 config 拉取的 alive 守卫（与 focus.status 一致）。
// 计数式而不是布尔：低1 的迟到失败用例要同时扣住两次挂载的请求、再按顺序放行。
let configGetHoldCount = 0;
let configGetGates = [];
let configGetGate = null;
let releaseConfigGet = null;
// 桩的默认契约：本宿主还没真正发出过 config.get 时 focus.status 返回 null，挂载那一拉
// 不产生 state 更新（否则它会把界面顺带推到可编辑，盖住删掉 recheck() 的变异）；
// 升级后真补拉时已有 config.get，才拿得到暂停状态。这是人造契约，所以另用
// opts.focusMount / opts.focusAfter 造「真实返回」的宿主形态做阳性控制（见 F1/F2 两遍），
// 两种形态都要覆盖。真实返回值见 src/rpc.ts 的 focus.status——带
// { paused, clock, until, minutes, via } 五个字段，桩用 focusSnap() 保持同一形态。

const sleep = (ms) => new Promise((r) => globalThis.setTimeout(r, ms));
const failures = [];
const check = (ok, label) => { if (!ok) failures.push(label); };

// focus.status 真实返回形态（src/rpc.ts）：paused 以外的字段客户端现在不读，但桩必须
// 带全——否则以后客户端升级去读 until/minutes/via 时，用例会在「桩缺字段」上假绿。
const focusSnap = (paused, clock) => ({
  paused,
  clock,
  until: paused ? "2026-11-18T03:30:00.000Z" : null,
  minutes: paused ? 30 : null,
  via: paused ? "settings-card" : null,
});

function makeCtx(opts) {
  const state = { slotName: null, regOpts: null, regComp: null, injectErr: null, localeDicts: null, configGetCalls: 0, configSetCalls: 0, statusCalls: 0, focusStatusCalls: 0, focusActionCalls: 0, sawConfigGet: false, configSetArgs: [], focusActionArgs: [], focusStatusLast: null };
  const ctx = {
    get(name) {
      if (name === "locale" && opts.locale) {
        return {
          register(_ns, dict) { state.localeDicts = dict; return () => {}; },
          bind() { return (k) => k; },
        };
      }
      // opts.connection === false 模拟非 Web 宿主（Android SDK 组合等）：
      // ctx.get('connection') 返回 undefined，设置页只能读不能存。
      // 'failOnce' 模拟「重探这一次取不到，之后又好了」——只升不降用例要用。
      if (name === "connection") {
        if (opts.connection === "failOnce") { opts.connection = true; return undefined; }
        if (opts.connection) {
          return {
            rpc: {
              call: async (_route, _plugin, request) => {
                const endpoint = request && request.endpoint;
                if (endpoint === "config.get") {
                  state.configGetCalls += 1;
                  state.sawConfigGet = true;
                  const snapshot = configValue ? { ok: true, value: configValue } : anyLeaf;
                  if (configGetHoldCount > 0) {
                    configGetHoldCount -= 1;
                    const gate = { settled: false };
                    const pending = new Promise((resolve) => { gate.release = (v) => resolve(v === undefined ? snapshot : v); });
                    gate.done = pending.then((v) => { gate.settled = true; return v; });
                    configGetGates.push(gate);
                    configGetGate = gate;
                    releaseConfigGet = gate.release;
                    return gate.done;
                  }
                  return snapshot;
                }
                if (endpoint === "config.set") {
                  state.configSetCalls += 1;
                  state.configSetArgs.push({ ...request });
                  return configSetOk ? { ok: true, value: configValue } : anyLeaf;
                }
                if (endpoint === "status") {
                  state.statusCalls += 1;
                  // opts.statusFail：以结构化 rpc 错误结算，钉住 StatusCard 的
                  // {error} 占位真的把错误详情渲染出来（N28-D5）。消息里带空白，
                  // 任何「只渲染到第一个词」的截断写法都过不了断言。
                  if (opts.statusFail) return { ok: false, error: { message: "status rpc exploded" }, value: null };
                  const snapshot = statusValue;
                  if (statusHoldPending) {
                    statusHoldPending = false;
                    // 结算标记由 promise 链置位。F3 的价值在第八遍附的阳性控制：
                    // 删掉 resolve(...) 时 settled 永远 false，那里的
                    // 「阳性控制：放行后 promise 链应结算」断言直接红（已实测）。
                    // 「settled 放 promise 链还是放 release 函数体」本身没有独立判据——
                    // 别在这句注释上宣称比实测更强的东西。
                    const gate = { settled: false };
                    const pending = new Promise((resolve) => {
                      releaseStatus = () => resolve(snapshot ? { ok: true, value: snapshot } : anyLeaf);
                    });
                    gate.done = pending.then((v) => { gate.settled = true; return v; });
                    statusGate = gate;
                    return gate.done;
                  }
                  return snapshot ? { ok: true, value: snapshot } : anyLeaf;
                }
                if (endpoint === "focus.status") {
                  state.focusStatusCalls += 1;
                  // 值按「本次请求发出时」的宿主形态定：挂载那一拉看 focusMount，
                  // config.get 成功之后的补拉看 focusAfter（低4：不再回落到全局变量，
                  // A→B 用例不再隐式依赖第五遍设的时钟）。
                  const value = state.sawConfigGet
                    ? (opts.focusAfter !== undefined ? opts.focusAfter : undefined)
                    : (opts.focusMount !== undefined ? opts.focusMount : null);
                  if (value && typeof value === "object") state.focusStatusLast = value;
                  if (focusStatusHoldPending) {
                    focusStatusHoldPending = false;
                    const gate = { settled: false };
                    const pending = new Promise((resolve) => { releaseFocusStatus = () => resolve({ ok: true, value }); });
                    gate.done = pending.then((v) => { gate.settled = true; return v; });
                    focusStatusGate = gate;
                    return gate.done;
                  }
                  if (value === undefined) return anyLeaf; // 声明了「config.get 之后没有补拉值」：走 rpc 失败分支
                  return { ok: true, value };
                }
                if (endpoint === "focus.pause" || endpoint === "focus.resume") {
                  state.focusActionCalls += 1;
                  state.focusActionArgs.push({ endpoint, minutes: request.minutes });
                  if (opts.focusThrow) throw new Error("focus rpc crashed");
                  if (opts.focusFail) return anyLeaf;
                  // 真实返回形态（src/rpc.ts）：pause → { paused, until, clock, minutes }；
                  // resume → { paused, removed }。
                  if (endpoint === "focus.pause") {
                    return { ok: true, value: { paused: true, until: "2026-11-18T03:30:00.000Z", clock: "12:30", minutes: request.minutes } };
                  }
                  return { ok: true, value: { paused: false, removed: true } };
                }
                return anyLeaf;
              },
            },
          };
        }
        return undefined;
      }
      return undefined;
    },
    effect(fn) { try { fn(); } catch (e) { state.injectErr = state.injectErr || e; } },
    slots: {
      inject(name, factory) { state.slotName = name; try { factory(); } catch (e) { state.injectErr = e; } },
      register(opts2, comp) { state.regOpts = opts2; state.regComp = comp; return () => {}; },
      entries() { return []; },
    },
  };
  return { ctx, state };
}

// 每个宿主一份独立的 vm 上下文：模块级状态（能力探测结果等）互不影响。
function boot(opts) {
  let captured = null;
  const sandbox = {
    window: { __ModuleLoader__: { load(o) { captured = o; } } },
    console, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    Promise, Date, JSON, Math, String, Number, Object, Array, Error,
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  const { ctx, state } = makeCtx(opts);
  const mod = captured.factory((id) => (id === "react" ? React : {}));
  mod.apply(ctx);
  return { ctx, state, mod };
}

// 像 React 一样反复渲染直到没有 state 更新：每轮渲染 + 提交 effect + 等异步落地，
// 本轮有 setter 改值（dirty）就再来一轮。effect 依赖没变就不会重跑。
// 返回值不带 rounds：之前它没有任何断言消费（死值），删掉而不是留一条假判据（F6）。
async function flush(root, label, maxRounds = 20) {
  let err = null;
  let out = null;
  for (let round = 1; round <= maxRounds; round++) {
    st.dirty = false;
    st.cursor = 0;
    st.roundEffects = [];
    out = { tags: [], text: [], scoped: [] };
    try { render(root, out); } catch (e) { err = err || e; }
    try { commitEffects(); } catch (e) { err = err || e; }
    await sleep(20);
    if (!st.dirty) return { err, out };
  }
  return { err: err || new Error(label + " 渲染未收敛（" + maxRounds + " 轮后仍有 state 更新）"), out };
}

function rerender(regComp) {
  st.cursor = 0;
  st.roundEffects = [];
  const out = { tags: [], text: [], scoped: [] };
  render(React.createElement(regComp, { view: "page" }), out);
  return out;
}

// 点完控件后的观察必须走这个：render + 提交 effect 直到收敛（不卸载）。
// 只用 rerender 会漏掉「点击后同步 effect 把 draft 回滚」这类回归——
// 真实 React 每次渲染后都会跑 effect，回滚当场就会发生，冒烟却看不见。
// N28-D4：flush 的超轮次/渲染错误过去被直接丢掉，点击后掉进「每轮都 setState」
// 的回归只是把一遍从 8.6s 拖到 13.4s，断言仍全绿；这里把它翻成失败并带出原因。
async function settlePage(regComp, label) {
  const { err, out } = await flush(React.createElement(regComp, { view: "page" }), label);
  check(!err, "settlePage[" + label + "] 未收敛：" + (err && (err.message || err)));
  return out;
}

// 重挂载等价于卸载 + 挂载：先跑上一轮所有 effect 的 cleanup，再清空槽位。
function unmountEffects() {
  for (const slot of st.effectSlots) {
    if (slot && typeof slot.cleanup === "function") slot.cleanup();
  }
  st.effectSlots = [];
}

async function mountPage(regComp, tab) {
  unmountEffects();
  st.cells = [tab];
  st.cursor = 0;
  st.effectSlots = [];
  st.roundEffects = [];
  st.dirty = false;
  return flush(React.createElement(regComp, { view: "page" }), "tab " + tab);
}

const first = boot({ connection: true, locale: true });
const { slotName, regOpts, regComp, injectErr } = first.state;
const localeDicts = first.state.localeDicts;

check(slotName === "plugins.bundle.config", "槽位名应为 plugins.bundle.config，实际 " + slotName);
// 槽位 key 同时注册两种安装名：宿主 listBundles() 的 bundle 名取决于 profile 依赖的 key，
// file: 安装时为短名 'dsh-heartbeat'，npm 安装时为 scoped 全名 '@kanadego/dsh-heartbeat'。
// 双注册保证两种安装方式下面板都不会消失（单 key 在另一安装方式下会被过滤）。
const BUNDLE_NAMES = ["dsh-heartbeat", "@kanadego/dsh-heartbeat"];
check(regOpts && BUNDLE_NAMES.includes(regOpts.key), "注册 key 应为短名/全名之一，实际 " + (regOpts && regOpts.key));
check(!injectErr, "槽位注入抛错：" + (injectErr && (injectErr.message || injectErr)));
if (injectErr) { console.log(JSON.stringify({ ok: false, failures }, null, 2)); process.exit(1); }

const TABS = ["status", "sessions", "seeds", "interests", "profile", "weekly", "config"];

async function mountTab(tabId) {
  const r = await mountPage(regComp, tabId);
  const out = r.out || { tags: [], text: [] };
  return { err: r.err, buttons: out.tags.filter((t) => t === "button").length, text: out.text.join(" ").trim() };
}

for (const tab of TABS) {
  const r = await mountTab(tab);
  check(!r.err, "tab " + tab + " 渲染抛错：" + (r.err && (r.err.message || r.err)));
  check(r.buttons >= 7, "tab " + tab + " 的 tab 栏按钮数 " + r.buttons + " < 7");
}

st.cells = []; st.cursor = 0; st.effectSlots = []; st.roundEffects = [];
let summaryText = "";
try {
  const out = { tags: [], text: [] };
  render(React.createElement(regComp, { view: "summary" }), out);
  summaryText = out.text.join("");
} catch (e) { failures.push("summary 视图抛错：" + e.message); }
check(summaryText.length > 0, "summary 视图没有输出文本");

const FULL_CONFIG = {
  intervalMin: 60, maxDailySend: 10, timeInjectMin: 25,
  statusbar: true, idleMode: false, tokenSaver: false,
  visionEngine: "native", psyEnabled: false,
  quietStart: "01:00", quietEnd: "08:00",
};
const ENGINE_VALUES = ["", "auto", "native", "modlens"];

async function configPass(config) {
  configValue = config;
  return mountPage(regComp, "config");
}

// ── 第二遍：设置页带真值渲染（Web 宿主行为不变）──
const web = await configPass(FULL_CONFIG);
check(!web.err, "config 带真值渲染抛错：" + (web.err && (web.err.message || web.err)));
const webInsp = web.out;
const eng = engineInfo(webInsp);
check(hasConfigCard(webInsp), "设置页缺少根节点 className=hb-config");
check(eng.select !== null, "设置卡里缺少「识别引擎」下拉（select）");
check(eng.options.length === 4, "识别引擎下拉应有 4 个选项，实际 " + eng.options.length);
check(JSON.stringify(eng.values) === JSON.stringify(ENGINE_VALUES), "识别引擎选项值应为 " + JSON.stringify(ENGINE_VALUES) + "，实际 " + JSON.stringify(eng.values));
check(eng.selectedValue === "native", "config.get 返回 native 时下拉应选中 native，实际 " + JSON.stringify(eng.selectedValue));
const webText = web.out.text.join(" ");
check(webText.includes("config.group.vision"), "设置页缺少「视觉识别」分组");
check(webText.includes("config.visionEngine"), "设置页缺少「识别引擎」行");
check(webText.includes("config.visionEngine.modlens"), "识别引擎下拉缺少 ModLens 选项");
// 2.3.0 experimental: the silence-close switch and BOTH of its texts must render,
// and the zh/en dictionaries must both carry the new copy keys.
check(webText.includes("config.group.silence"), "设置页缺少「静默收尾」分组");
check(webText.includes("config.concludeSilent"), "设置页缺少「静默收尾开关」行");
check(webText.includes("config.concludeSilentHint"), "设置页缺少静默收尾说明");
check(webText.includes("config.concludeSilentWarn"), "设置页缺少静默收尾风险提示");
const SILENCE_KEYS = [
  "config.group.silence", "config.group.silenceDesc", "config.concludeSilent",
  "config.concludeSilentHint", "config.concludeSilentWarn",
];
check(
  localeDicts !== null && SILENCE_KEYS.every((k) => localeDicts.zh && k in localeDicts.zh && localeDicts.en && k in localeDicts.en),
  "中英两套 locale DICT 缺少静默收尾文案",
);
// Web 宿主：保存按钮可用、没有只读横幅（行为与改造前一致）。
const webSave = saveButton(webInsp);
check(webSave && !webSave.props.disabled, "Web 宿主保存按钮不应 disabled");
check(!hasClass(webInsp, "hb-configReadonly"), "Web 宿主不应渲染只读横幅");

// ── 保存失败 / 成功后清红字（issue #7：失败不再静默；成功不残留红字）──
configSetOk = false;
webSave.props.onClick();
await sleep(20);
// 点击后的观察统一走 settlePage（与文件头注释同口径）：rerender 不跑 effect，
// 会把「点击后 effect 立刻把回执回滚」的回归藏起来（N28-D5 后半）。
const failed = await settlePage(regComp, "保存失败后");
check(hasClass(failed, "hb-configError"), "config.set 失败时应渲染红字行（hb-configError）");
check(failed.text.join(" ").includes("config.saveFailed"), "保存失败红字应使用 config.saveFailed 文案");
configSetOk = true;
const retrySave = saveButton(failed);
check(retrySave !== undefined, "保存失败后保存按钮应仍在");
if (retrySave) retrySave.props.onClick();
await sleep(20);
const savedAgain = await settlePage(regComp, "保存重试成功后");
check(!hasClass(savedAgain, "hb-configError"), "保存成功后应清掉上一次的失败红字");
check(savedAgain.text.join(" ").includes("config.saved"), "保存成功后应显示「已保存」");
configSetOk = false;

// ── N28-D1：保存成功→再失败的格 ──
// 现实现 catch 里先 setStatus("") 再写 saveErr；删掉那句 setStatus("") 会留下
// 「已保存」与「保存失败」红绿并存。上面只测了失败→成功方向，这一格补反向。
{
  configValue = { ...FULL_CONFIG };
  configSetOk = true;
  const b = boot({ connection: true, locale: false, focusAfter: focusSnap(false, null) });
  await mountPage(b.state.regComp, "config");
  let out = await settlePage(b.state.regComp, "D1 挂载");
  const firstSave = saveButton(out);
  check(firstSave !== null && typeof firstSave.props.onClick === "function", "N28-D1：保存按钮应可点");
  if (firstSave && typeof firstSave.props.onClick === "function") { firstSave.props.onClick(); await sleep(20); }
  out = await settlePage(b.state.regComp, "D1 保存成功后");
  check(out.text.join(" ").includes("已保存"), "N28-D1：保存成功应先出现「已保存」，实际 " + JSON.stringify(out.text.join(" ").slice(0, 160)));
  configSetOk = false;
  const secondSave = saveButton(out);
  check(secondSave !== null && typeof secondSave.props.onClick === "function", "N28-D1：保存失败前按钮应仍可点");
  if (secondSave && typeof secondSave.props.onClick === "function") { secondSave.props.onClick(); await sleep(20); }
  out = await settlePage(b.state.regComp, "D1 再保存失败后");
  check(!out.text.join(" ").includes("已保存"), "N28-D1：再保存失败时上一次的「已保存」必须消失（catch 里的 setStatus(\"\")），实际 " + JSON.stringify(out.text.join(" ").slice(0, 160)));
  check(out.text.join(" ").includes("保存失败"), "N28-D1：再保存失败应显示「保存失败：…」");
  configValue = { ...FULL_CONFIG };
  configSetOk = false;
}

// ── 第三遍：config 里没有 visionEngine（宿主默认值 ''）→ 选中「跟随 vision.json（默认 auto）」──
const def = await configPass({ ...FULL_CONFIG, visionEngine: undefined });
check(!def.err, "config 默认值渲染抛错：" + (def.err && (def.err.message || def.err)));
const defEng = engineInfo(def.out);
check(defEng.selectedValue === "", "默认配置下引擎下拉应选中 ''（跟随 vision.json），实际 " + JSON.stringify(defEng.selectedValue));
check(defEng.selectedText === "config.visionEngine.follow", "默认配置下应选中 follow 项，实际 " + defEng.selectedText);
check(
  !!localeDicts && localeDicts.zh["config.visionEngine.follow"].includes("auto"),
  "follow 项的中文文案应写明默认 auto",
);

// ── 第四遍：config 显式 auto → 选中值 auto ──
const auto = await configPass({ ...FULL_CONFIG, visionEngine: "auto" });
const autoEng = engineInfo(auto.out);
check(autoEng.selectedValue === "auto", "config 返回 auto 时下拉应选中 auto，实际 " + JSON.stringify(autoEng.selectedValue));

// ── 晚注册 connection 的宿主：状态卡（默认 tab）不能报 RPC 不可用 ──
// apply 时没有 connection，apply 之后才有；默认状态页直接打 rpc('status')。
// 客户端现在每次调用现取 connection（不再用 apply 时的一次性判定做闸门）。
const scOpts = { connection: false, locale: false };
const sc = boot(scOpts);
statusValue = {
  version: "2.3.0",
  intervalMin: 60,
  quiet: false,
  cap: { used: 2, max: 10 },
  statusbar: { enabled: true, timeInjectMin: 25, lastTimeInjectAt: null, lastStatus: null },
  lastBeat: { at: 1763424000000, verdict: "silent", reason: "quiet-hours" },
};
scOpts.connection = true;
const scMount = await mountPage(sc.state.regComp, "status");
check(!scMount.err, "晚注册 connection 场景渲染抛错：" + (scMount.err && (scMount.err.message || scMount.err)));
const scText = (scMount.out || { text: [] }).text.join(" ");
check(scText.includes("v2.3.0"), "晚注册 connection 的宿主上 StatusCard 应渲染出状态数据，实际没有版本号");
check(scText.includes("2 / 10"), "晚注册 connection 的宿主上 StatusCard 应渲染出今日用量");
check(!scText.includes("RPC 通道不可用"), "晚注册 connection 的宿主上 StatusCard 不应报 RPC 通道不可用");
check(sc.state.statusCalls > 0, "StatusCard 应实际调用 status 端点，实际 0 次");
statusValue = null;

// ── 第五遍：无 connection 的宿主 → 设置卡可见但只读（P1-3 #7 验收）──
// 不注入 locale，让文案直接取 zh 字典，断言用户真正会看到的那句话。
// 挂载时用的 connection 走 failOnce：probe 这一次取不到（保持只读），随后的
// focus.status 与（若守卫缺失的）config.get 都能真正打进假宿主——所以下面的
// configGetCalls===0 是真计数，不再是「client 层提前抛错」的空转断言。
const roOpts = { connection: false, locale: false, focusAfter: focusSnap(true, "18:30") };
const ro = boot(roOpts);
const roRegComp = ro.state.regComp;
configValue = null;
roOpts.connection = "failOnce";
const roMount = await mountPage(roRegComp, "config");
let roErr = roMount.err;
const roOut = roMount.out;
const roText = roOut.text.join(" ");
check(!roErr, "无 connection 宿主渲染抛错：" + (roErr && (roErr.message || roErr)));
const roEng = engineInfo(roOut);
check(hasConfigCard(roOut), "无 connection 时设置卡应仍然可见（hb-config）");
check(roText.includes("data/settings/policy.json"), "无 connection 时缺少「改 data/settings/policy.json」的只读说明");
check(roText.includes("不支持在应用内改设置"), "无 connection 时只读说明文案不完整");
check(!roText.includes("加载失败"), "无 connection 时不应只剩加载失败，应渲染只读设置卡");
// 只读态引擎下拉：4 个真实引擎选项仍在（证明卡没被吞掉），但选中位必须是占位「—」，
// 不能替用户声称当前是 follow / native。
const VISION_UNSET = "__unset__";
const roRealOptions = roEng.options.filter((o) => o.props.value !== VISION_UNSET);
check(roRealOptions.length === 4, "只读态下引擎下拉仍应列出 4 个真实引擎选项，实际 " + roRealOptions.length);
// 判据统一用真值而不是 === true：readonly ? 1 : 0 这类写法在真实 DOM 同样禁用，
// 没有假绿风险，不必因为布尔类型差异误红（低3）。
check(!!(roEng.select && roEng.select.props.disabled), "只读态下引擎下拉应 disabled");
check(roEng.selectedValue === VISION_UNSET, "只读态下引擎下拉不应选中任何真实引擎，实际 " + JSON.stringify(roEng.selectedValue));
check(roEng.selectedText === "—", "只读态下引擎下拉应显示占位「—」，实际 " + JSON.stringify(roEng.selectedText));
const roInputs = roOut.scoped.filter((n) => n.type === "input");
check(roInputs.length > 0 && roInputs.every((n) => !!n.props.disabled), "只读态下输入框应全部 disabled");
// 只读态拿不到真实配置：输入框必须空着，兜底值 60/10/25/01:30 不许伪装成配置值。
check(roInputs.length > 0 && roInputs.every((n) => n.props.value === ""), "只读态下输入框不应展示硬编码兜底值");
const roNumberInputs = roInputs.filter((n) => n.props.type === "number");
check(roNumberInputs.length > 0 && roNumberInputs.every((n) => n.props.placeholder === "—"), "只读态下数字输入框应使用占位符「—」");
// 只读态开关（statusbar/concludeSilent/tokenSaver/psy/idle）同样不许回退到「关闭」：
// 真实默认 statusbar 是开启，显示「☐ 关闭」等于把相反值当事实。这条单列，覆盖
// 「只把输入框置空、开关仍渲染兜底」的半吊子修法。
const roToggleTexts = buttonsIn(roOut).map((b) => textOf(b)).filter((tx) => tx === "—" || tx.includes("关闭") || tx.includes("开启"));
check(roToggleTexts.filter((tx) => tx === "—").length === 5, "只读态 5 个开关都应显示占位「—」，实际 " + JSON.stringify(roToggleTexts));
check(!roToggleTexts.some((tx) => tx.includes("关闭") || tx.includes("开启")), "只读态开关不应展示「关闭/开启」兜底语义，实际 " + JSON.stringify(roToggleTexts));
const roToggles = buttonsIn(roOut).filter((b) => textOf(b) === "—");
check(roToggles.length === 5 && roToggles.every((b) => !!b.props.disabled), "只读态 5 个开关应全部 disabled");
// 开关底色也不许泄露「关」：只读态必须走 ghost 样式，不能套高亮按钮。
check(roToggles.every((b) => b.props.style && String(b.props.style.background).includes("rgba(127,127,127")), "只读态开关应使用 ghost 样式（不许套高亮按钮）");
// N28-D2：前缀一致还不够——alpha 改成 0（全透明）或 .95（近乎实心）仍是同一前缀。
// 解析成数值后钉区间，「灰底」才真的被保护住。
const roGhostAlphas = roToggles.map((b) => ghostAlpha(b.props.style));
check(roGhostAlphas.every(isGhostAlpha), "N28-D2：只读态开关 ghost 底色的 alpha 应落在 " + GHOST_ALPHA_MIN + "–" + GHOST_ALPHA_MAX + "，实际 " + JSON.stringify(roGhostAlphas));
// 只读态控件必须整排「无可调用入口」，不只第一个开关：disabled 只是 DOM 闸门，
// 程序化调用 props.onClick 绕得过去，所以 5 个开关逐个断言。
// 同值写入盲区：假 React 的 setter 对同值写入按 Object.is 短路、不标脏，因此
// 「调用后 dirty 不变」抓不到 () => set(on) 这种同值空转；这里改为直接钉
// 「没有可调用的 handler」，同值写入在该用例里不可构造。
// 判据用 typeof !== "function" 而不是 === undefined：onClick: readonly ? null : fn 与
// undefined 在 React 里等价（null 也是合法无 handler），不能因为写法变化假红（F4）。
// 取舍（低2）：这里故意比「可观察行为」更严——只读时即便挂 () => {} 行为也等价，
// 仍判红。理由是别把守卫写进 handler 里：那种写法下禁用的只是 DOM gate，程序化
// 调用照样能烧一次 RPC/改 draft；接受 no-op 假红，换取「只读入口必须真的不存在」。
const roToggle = roToggles[0];
check(roToggles.length === 5 && roToggles.every((b) => typeof b.props.onClick !== "function"), "只读态 5 个开关都不应挂可调用的 onClick");
const cellsBeforeClick = JSON.stringify(st.cells);
if (roToggle && typeof roToggle.props.onClick === "function") roToggle.props.onClick();
check(JSON.stringify(st.cells) === cellsBeforeClick, "只读态开关的 onClick 不应改动 draft");
check(st.dirty === false, "只读态开关的 onClick 不应推进渲染");
// 专注按钮在只读态也必须 disabled 且不挂可调用入口（判据同开关：typeof，见 F4）。
// 这一遍挂载拿到的 focus 是 null（默认桩契约），所以渲染的是「暂停」分支；
// 「恢复」分支由下面「只读 + 已暂停」那一遍专门覆盖。
// N22b：这两条断言就是「disabled: focusBusy || readonly 的 readonly 半边」的钉子——
// 只读挂载里 focusBusy 恒为 false，删掉 readonly 半边本句即红（已用变异实测）。
const roFocusBtn = buttonsIn(roOut).find((b) => ["暂停", "恢复"].includes(textOf(b)));
check(roFocusBtn !== undefined, "只读态应渲染专注按钮（暂停/恢复）");
check(!!(roFocusBtn && roFocusBtn.props.disabled), "只读态下专注按钮应 disabled");
check(roFocusBtn && typeof roFocusBtn.props.onClick !== "function", "只读态下专注按钮不应挂可调用的 onClick（否则程序化调用会真发 focus RPC）");
// 保存按钮在只读态仍挂 onClick（由 save() 内的只读守卫兜底）：真的点一下，
// 断言 config.set/config.get 计数都不动——删掉 save() 里的 if (readonly) return; 即红。
const roSave = saveButton(roOut);
check(!!(roSave && roSave.props.disabled), "只读态下保存按钮应 disabled");
check(roSave && typeof roSave.props.title === "string" && roSave.props.title.includes("data/settings/policy.json"), "只读态下保存按钮应带 title 提示");
const callsBeforeClick = { get: ro.state.configGetCalls, set: ro.state.configSetCalls, focus: ro.state.focusActionCalls };
if (roSave && typeof roSave.props.onClick === "function") { roSave.props.onClick(); await sleep(0); }
if (roFocusBtn && typeof roFocusBtn.props.onClick === "function") { roFocusBtn.props.onClick(); await sleep(0); }
check(ro.state.configSetCalls === callsBeforeClick.set, "只读态点击保存不应发起 config.set，实际 " + ro.state.configSetCalls + " 次");
check(ro.state.configGetCalls === callsBeforeClick.get, "只读态点击保存/专注不应发起 config.get");
check(ro.state.focusActionCalls === callsBeforeClick.focus, "只读态点击专注按钮不应发起 focus RPC，实际 " + ro.state.focusActionCalls + " 次");
check(hasClass(roOut, "hb-configReadonly"), "只读态下应渲染只读横幅（hb-configReadonly）");
// 只读态根本不应该去拉 config.get。这里 probe 之后 connection 真的可用，
// 删掉 effect 里的 if (readonly) return; 会让 config.get 打进假宿主、计数变 1。
check(ro.state.configGetCalls === 0, "只读态不应调用 config.get，实际 " + ro.state.configGetCalls + " 次");

// ── 第五遍附：只读 + 已暂停 → 渲染「恢复」按钮（F1，交叉审查 5881e4b9 的覆盖洞）──
// 真实宿主在只读态也会成功返回 paused，界面走的是 client.js 的 resume 分支。
// 之前所有只读挂载都只渲染「暂停」（默认桩首次 focus.status 回 null），resume 分支的
// onClick / disabled 两个 readonly 半边零覆盖：分别删任一半都全绿。这里让桩在挂载
// 那一拉就真实返回 paused（18:30），把两个半边都钉住。
const roPausedOpts = { connection: false, locale: false, focusMount: focusSnap(true, "18:30") };
const roPaused = boot(roPausedOpts);
roPausedOpts.connection = "failOnce";
const roPausedMount = await mountPage(roPaused.state.regComp, "config");
const roPausedOut = roPausedMount.out;
const roPausedText = roPausedOut.text.join(" ");
check(!roPausedMount.err, "只读+已暂停挂载抛错：" + (roPausedMount.err && (roPausedMount.err.message || roPausedMount.err)));
check(hasClass(roPausedOut, "hb-configReadonly"), "只读+已暂停时仍应渲染只读横幅");
check(roPausedText.includes("已暂停至 18:30"), "只读+已暂停时应显示「已暂停至 18:30」，实际文案 " + JSON.stringify(roPausedText.slice(0, 200)));
const roResumeBtn = buttonsIn(roPausedOut).find((b) => textOf(b) === "恢复");
check(roResumeBtn !== undefined, "只读+已暂停时应渲染「恢复」按钮（不能只剩「暂停」）");
// 删掉 resume 分支的 onClick 守卫 → 这句红。
check(roResumeBtn && typeof roResumeBtn.props.onClick !== "function", "只读+已暂停时「恢复」按钮不应挂可调用的 onClick（否则程序化调用会真发 focus.resume）");
// 删掉 resume 分支 disabled 的 readonly 半边（focusBusy || readonly → focusBusy）→ 这句红。
check(!!(roResumeBtn && roResumeBtn.props.disabled), "只读+已暂停时「恢复」按钮应 disabled（readonly 半边）");
const roPausedCallsBefore = roPaused.state.focusActionCalls;
if (roResumeBtn && typeof roResumeBtn.props.onClick === "function") { roResumeBtn.props.onClick(); await sleep(0); }
check(roPaused.state.focusActionCalls === roPausedCallsBefore, "只读+已暂停时点击「恢复」不应发起 focus RPC，实际 " + roPaused.state.focusActionCalls + " 次");
check(roPaused.state.configGetCalls === 0, "只读+已暂停时同样不应调用 config.get，实际 " + roPaused.state.configGetCalls + " 次");
// 低5：桩的 focus.status 契约必须与 src/rpc.ts 同形（paused/clock/until/minutes/via），
// 不能只造 paused/clock——否则以后客户端升级去读 until 时用例会在「桩缺字段」上假绿。
// 同时钉住客户端目前只读 paused/clock：多出来的 until ISO 值不许漏进界面。
const roPausedSnapKeys = roPaused.state.focusStatusLast ? Object.keys(roPaused.state.focusStatusLast).sort() : [];
check(JSON.stringify(roPausedSnapKeys) === JSON.stringify(["clock", "minutes", "paused", "until", "via"]), "focus.status 桩应带全 paused/clock/until/minutes/via 五个字段，实际 " + JSON.stringify(roPausedSnapKeys));
check(!roPausedText.includes("2026-11-18T03:30"), "专注卡只展示 paused/clock，不应把 until 的 ISO 值渲染进界面");

// ── 第六遍：connection 晚到（apply 时不可用、挂载后才可用）→ 只读态应升级为可编辑 ──
// 挂载 effect 强制重探一次；探到可用后必须 recheck() 推进 state（删掉 recheck 就停在只读）。
// focus.status 的依赖是 [readonly]：升级后要补拉一次，否则专注卡停在挂载时的旧状态。
const focusCallsBefore = ro.state.focusStatusCalls;
roOpts.connection = true;
configValue = FULL_CONFIG;
// 挂载那一拉不会产生 state 更新（宿主在真发出 config.get 前把 focus.status 回成 null），
// 所以这一挂载里唯一能把界面从只读推进到可编辑的 state 更新必须是 recheck()。
const upMount = await mountPage(roRegComp, "config");
const upErr = upMount.err;
const upOut = upMount.out;
const upText = upOut.text.join(" ");
check(!upErr, "connection 晚到场景渲染抛错：" + (upErr && (upErr.message || upErr)));
check(!hasClass(upOut, "hb-configReadonly"), "connection 晚到后可编辑时不应再渲染只读横幅");
check(!upText.includes("不支持在应用内改设置"), "connection 晚到后不应再显示只读说明");
const upEng = engineInfo(upOut);
check(upEng.select && !upEng.select.props.disabled, "connection 晚到后引擎下拉应恢复可用");
check(upEng.options.length === 4, "可编辑态引擎下拉不应带只读占位项，实际 " + upEng.options.length + " 个");
check(upEng.selectedValue === "native", "connection 晚到后应真正拉回配置（选中 native），实际 " + JSON.stringify(upEng.selectedValue));
const upInputs = upOut.scoped.filter((n) => n.type === "input");
check(upInputs.length > 0 && upInputs.every((n) => !n.props.disabled), "connection 晚到后输入框应恢复可用");
check(upInputs.some((n) => n.props.value === 60), "connection 晚到后输入框应显示真实配置值（interval 60）");
const upSave = saveButton(upOut);
check(upSave && !upSave.props.disabled, "connection 晚到后保存按钮应恢复可用");
check(ro.state.configGetCalls > 0, "connection 晚到后应实际发起 config.get，实际调用 " + ro.state.configGetCalls + " 次");
// 升级后必须「至少补拉一次」。不钉死 ===2：focus effect 里加 if (readonly) return
// 不是合法实现——实测 10 条红：只读「已暂停」的文案/按钮存在/不挂 onClick/disabled
// 四条、focus.status 桩五字段形状、A→B 阳性控制的挂载值、焦点闸门的扣住/补拉显示/
// 结算/不改写 state 四条。只读挂载同样要跑这一次首拉，否则只读态渲染不出「恢复」分支
// （focus 停在 null → 只有「暂停」）。
// 升级后补拉是 [readonly] 依赖变化带来的第二拉，delta 是 1 或 2 都放行。
// delta>=1 只是辅助判据（对「每轮都拉」也放行），真正抓 deps [] 的是「最终显示的
// 状态值」：本形态（桩首次回 null）靠下面「已暂停至 18:30」红；紧接着的 F2 阳性
// 控制形态（桩真实返回 A→B）靠「最终显示 B」红——[] 时 effect 只在挂载跑一次。
const focusDelta = ro.state.focusStatusCalls - focusCallsBefore;
check(focusDelta >= 1, "升级后 focus.status 应补拉（delta≥1，辅助判据），实际增 " + focusDelta + " 次");
check(upText.includes("已暂停至 18:30"), "升级后 focus 状态应补拉回来（期望显示「已暂停至 18:30」）");
const upFocusBtn = buttonsIn(upOut).find((b) => ["暂停", "恢复"].includes(textOf(b)));
check(upFocusBtn && !upFocusBtn.props.disabled, "升级后专注按钮应恢复可用");

// ── 第六遍附（F2）：阳性/增量控制——桩不再返回 null 的宿主形态 ──
// 上面那遍的判定依赖「首次 focus.status 回 null」这个人造契约；桩一换成真实返回
// （只读挂载也拿得到 paused），删 recheck / deps [] 的鉴别力就全靠这里：
//   挂载拉返回 A（18:30）→ 升级后 config.get 成功 → 补拉返回 B（19:00）。
// 断言界面最终显示 B：deps 写成 [] 时只在挂载拉一次，会停在 A，必红。
const abOpts = { connection: false, locale: false, focusMount: focusSnap(true, "18:30"), focusAfter: focusSnap(true, "19:00") };
const ab = boot(abOpts);
configValue = null;
abOpts.connection = "failOnce";
const abMount = await mountPage(ab.state.regComp, "config");
const abMountText = abMount.out.text.join(" ");
check(!abMount.err, "A→B 阳性控制挂载抛错：" + (abMount.err && (abMount.err.message || abMount.err)));
check(abMountText.includes("已暂停至 18:30"), "阳性控制：只读挂载应显示挂载值 A（已暂停至 18:30），实际 " + JSON.stringify(abMountText.slice(0, 200)));
const abFocusCallsBefore = ab.state.focusStatusCalls;
configValue = FULL_CONFIG;
abOpts.connection = true;
const abUp = await mountPage(ab.state.regComp, "config");
const abText = abUp.out.text.join(" ");
check(!abUp.err, "A→B 阳性控制升级挂载抛错：" + (abUp.err && (abUp.err.message || abUp.err)));
check(!hasClass(abUp.out, "hb-configReadonly"), "A→B 阳性控制：升级后不应再渲染只读横幅");
check(ab.state.configGetCalls > 0, "A→B 阳性控制：升级后应真的发出 config.get，实际 0 次");
check(ab.state.focusStatusCalls - abFocusCallsBefore >= 1, "A→B 阳性控制：升级后应补拉 focus.status（辅助判据）");
check(abText.includes("已暂停至 19:00"), "A→B 阳性控制：最终应显示 B（已暂停至 19:00）——deps 写成 [] 会停在上一条 A，实际 " + JSON.stringify(abText.slice(0, 200)));
check(!abText.includes("18:30"), "A→B 阳性控制：升级后不应再停在挂载时的 A（18:30）");

// ── 第七遍：升级成功后 connection 瞬时取不到 → 只升不降，仍可编辑、无只读横幅 ──
// 重新挂载会再强制重探一次；这次 ctx.get('connection') 返回 undefined。
// 探测只允许升级：已可用的 rpc 不能被一次失败打回 false（删掉 upgrade-only 判断就会红）。
const getsBefore = ro.state.configGetCalls;
roOpts.connection = "failOnce";
const downMount = await mountPage(roRegComp, "config");
const downErr = downMount.err;
const downOut = downMount.out;
const downText = downOut.text.join(" ");
check(!downErr, "升级后 connection 抖动的场景渲染抛错：" + (downErr && (downErr.message || downErr)));
check(!hasClass(downOut, "hb-configReadonly"), "升级后 connection 抖动不应降级回只读横幅");
check(!downText.includes("不支持在应用内改设置"), "升级后 connection 抖动不应再显示只读说明");
const downEng = engineInfo(downOut);
check(downEng.select && !downEng.select.props.disabled, "升级后 connection 抖动时引擎下拉应仍可用");
const downSave = saveButton(downOut);
check(downSave && !downSave.props.disabled, "升级后 connection 抖动时保存按钮应仍可用");
check(ro.state.configGetCalls > getsBefore, "升级后 connection 抖动时配置应正常加载（config.get 次数应增加）");

// ── 第八遍附（F3/F5）：闸门阳性控制——不卸载时迟到值确实落地并渲染 ──
// 「已结算」由 promise 的 resolve 链置位（stub 常驻观察者），不是 release 函数体里
// 自报。阳性控制证明下一遍的判定不是空转：同一闸门不卸载时放行，迟到值真的写进
// state 并渲染；若删掉 release 里的 resolve(...)，settled 永远 false，下面即红。
const statusBody = (version) => ({
  version,
  intervalMin: 60,
  quiet: false,
  cap: { used: 1, max: 10 },
  statusbar: { enabled: true, timeInjectMin: 25, lastTimeInjectAt: null, lastStatus: null },
  lastBeat: { at: 1763424000000, verdict: "silent", reason: "quiet-hours" },
});
statusValue = statusBody("7.7.7-late");
statusHoldPending = true;
await mountPage(regComp, "status");
const liveGate = statusGate;
check(liveGate !== null && liveGate.settled === false, "阳性控制：status 请求应被闸门扣住且尚未结算");
check(typeof releaseStatus === "function", "阳性控制：扣住时应拿到放行函数");
// 有界等待：resolve 被删掉时 settled 不会变 true，但用例不许永远挂住（变异要红，不是卡死）。
// 放行后 client 侧还要再走几跳 promise 链才写入 state，等一个宏任务再重渲染。
// 两道 typeof / 空值保护（F5）：闸门没建起来时也要把已记录的失败原样打印成 JSON。
if (typeof releaseStatus === "function") releaseStatus();
await Promise.race([liveGate ? liveGate.done : Promise.resolve(), sleep(200)]);
await sleep(0);
check(liveGate !== null && liveGate.settled === true, "阳性控制：放行后 promise 链应结算（settled 由 resolve 链置位，删 resolve 即红）");
const liveOut = rerender(regComp);
check(liveOut.text.join(" ").includes("v7.7.7-late"), "阳性控制：不卸载时迟到值应落地并渲染，实际 " + JSON.stringify(liveOut.text.join(" ").slice(0, 200)));

// ── 第八遍：旧挂载迟到的 rpc 值不许落进新挂载（卸载 cleanup）──
// 用假宿主的手动闸门扣住第一条 status，不设任何毫秒阈值（慢机上 mount 本身
// 超时会让「延迟 N 毫秒」假绿）。挂载后立刻重挂载、第二次请求正常返回；确认
// 闸门仍未结算后手动放行。迟到值若还活着就会写进新挂载的 cells——useAsync 的
// alive 闸门必须在 cleanup 里被置 false（假 React 的 cell 是全局槽位，等价于
// 真实 React 丢弃卸载组件的更新）。删掉 unmountEffects() → 本遍变红。
statusValue = statusBody("9.9.9-stale");
statusHoldPending = true;
await mountPage(regComp, "status");
const heldGate = statusGate;
check(heldGate !== null && heldGate.settled === false && typeof releaseStatus === "function", "旧挂载的 status 请求应被闸门扣住（本用例不依赖壁钟）");
statusValue = statusBody("2.3.0");
await mountPage(regComp, "status");
const freshCells = JSON.stringify(st.cells);
const freshLateOut = rerender(regComp);
check(freshLateOut.text.join(" ").includes("v2.3.0"), "重挂载后状态卡应显示新数据（v2.3.0）");
check(st.dirty === false, "重挂载收敛后不应还有待渲染的 state 更新");
check(heldGate !== null && heldGate.settled === false, "重挂载完成时旧挂载的迟到请求必须尚未结算");
// 失败路径保护（F5）：闸门没建起来（例如桩里的 statusHoldPending 块被删）时
// releaseStatus 是 null；无保护调用会抛 TypeError，进程退出前什么都打不出来。
if (typeof releaseStatus === "function") releaseStatus();
await Promise.race([heldGate ? heldGate.done : Promise.resolve(), sleep(200)]);
// 迟到值写入 state 还要再走几跳 promise 链；等一个宏任务再做「不许落进新挂载」的判定，
// 否则判定跑在 setState 之前，删掉 cleanup 也能假绿。
await sleep(0);
check(heldGate !== null && heldGate.settled === true, "放行后闸门应结算（放行本身要真的生效）");
const lateOut = rerender(regComp);
check(!lateOut.text.join(" ").includes("9.9.9-stale"), "旧挂载迟到的 status 值不应渲染进新挂载");
check(JSON.stringify(st.cells) === freshCells, "旧挂载迟到的 status 值不应改写新挂载的 state");
check(st.dirty === false, "旧挂载迟到的 status 值不应触发新挂载重渲染");
statusValue = null;
releaseStatus = null;
statusGate = null;

// ═══════════════════════════════════════════════════════════════════════════
// 第九遍（P1 正向点击面）：可编辑态下点控件必须真的有用。
// 前八遍只钉住「只读时不许点」；把 5 个开关与暂停/恢复的 onClick 全改成 undefined、
// 或把 focus 三元恒渲染成 resume，前八遍依旧全绿——守卫写对了和按钮彻底死了分不清。
// 这里逐控件点一次：渲染文案翻转 → 保存/动作 RPC 带出逐个键名与值。
// ═══════════════════════════════════════════════════════════════════════════

// 设置卡里按行标签定位控件：scoped 节点按渲染顺序收集，标签 span 之后第 index 个
// 同类型节点就是该行的控件（每个标签文案在同卡内唯一，见 client.js 的 paramRow；
// 静默时段这一行有两个 time 输入，用 index 区分起止）。
function nodeAfterLabel(out, label, type, index = 0) {
  const nodes = out.scoped || [];
  const li = nodes.findIndex((n) => n.type === "span" && textOf(n) === label);
  if (li < 0) return null;
  const hits = [];
  for (let i = li + 1; i < nodes.length; i++) if (nodes[i].type === type) hits.push(nodes[i]);
  return hits[index] || null;
}
function focusedBtn(out) {
  return buttonsIn(out).find((b) => ["暂停", "恢复"].includes(textOf(b))) || null;
}
async function editableMount(extra) {
  configValue = { ...FULL_CONFIG };
  configSetOk = true;
  const opts = { connection: true, locale: false, focusAfter: focusSnap(false, null), ...(extra || {}) };
  const b = boot(opts);
  const m = await mountPage(b.state.regComp, "config");
  return { opts, b, m };
}
async function setFocusMinutes(b, value) {
  const out = await settlePage(b.state.regComp, "专注分钟输入");
  const input = nodeAfterLabel(out, "专注模式", "input");
  check(input !== null, "可编辑态应渲染专注分钟输入框");
  check(input !== null && typeof input.props.onChange === "function", "专注分钟输入框必须挂 onChange（否则改不了 minutes）");
  if (input && typeof input.props.onChange === "function") input.props.onChange({ target: { value } });
  await sleep(20);
  return settlePage(b.state.regComp, "专注分钟改写后");
}

// ① 5 个开关各点一次 → 对应 draft 键翻转 → 保存后 config.set 逐个带出该键。
// 每个开关单独挂载，避免上一个开关的 draft 残留掩盖键名错配。
const EDIT_TOGGLES = [
  { label: "状态栏", key: "statusbar", base: true },
  { label: "静默收尾开关", key: "concludeSilentTurn", base: false },
  { label: "节省 token 模式", key: "tokenSaver", base: false },
  { label: "psy 分区", key: "psyEnabled", base: false },
  { label: "闲着模式", key: "idleMode", base: false },
];
const CONFIG_KEYS = ["intervalMin", "maxDailySend", "timeInjectMin", "statusbar", "idleMode", "tokenSaver", "visionEngine", "concludeSilentTurn", "psyEnabled", "quietStart", "quietEnd"];
// N28-D3 对照：等值集合本身要接受 var(...) 写法（换写法不假红）、拒绝 #000。
check(isOnTextColor("var(--dsw-alias-label-primary)") && isOnTextColor("#fff") && !isOnTextColor("#000"), "N28-D3 对照：开态文字色等值集合应接受 var(...) 与 #fff、拒绝 #000");
for (const tg of EDIT_TOGGLES) {
  const { b, m } = await editableMount();
  check(!m.err, "可编辑正向控制：" + tg.key + " 挂载抛错（" + (m.err && m.err.message) + "）");
  const btn = nodeAfterLabel(m.out, tg.label, "button");
  check(btn !== null, "可编辑态应渲染「" + tg.label + "」开关按钮");
  if (!btn) continue;
  const before = textOf(btn);
  check(before === (tg.base ? "☑ 开启" : "☐ 关闭"), "可编辑态 " + tg.key + " 初始文案应按 config.get 渲染，实际 " + JSON.stringify(before));
  // disabled 与 onClick 是两个独立的闸门：真实浏览器点不动的 disabled 开关，
  // 假 React 直接调 props.onClick 照样能点——不钉住它，整排开关 disabled:true 也全绿。
  // 判据用 !props.disabled（truthy 即禁用），与只读侧 === true 对称：
  // disabled: readonly || "yes" 这种 truthy 写法在真实 DOM 里同样整排禁用，必须红。
  check(!btn.props.disabled, "可编辑态 " + tg.key + " 开关不应 disabled");
  // 开关底色按状态选：开=高亮、关=ghost。只读侧那条只覆盖了「全关」的 ghost，
  // 可编辑态这里两条分支各钉一次（样式三元塌成一支必红）。
  // 样式断言钉两项：底色 + 文字色（只钉 background 的话，改文字色/压暗都能假绿）。
  // N28-D3：开态文字色走等值集合而不是 '=== "#fff"'——var(--dsw-alias-label-primary)
  // 是同一个颜色，钉字面量会在实现换写法时假红。
  const styleBg = btn.props.style ? String(btn.props.style.background) : "";
  const styleColor = btn.props.style ? String(btn.props.style.color) : "";
  check(tg.base ? styleBg.includes("#339CFF") && isOnTextColor(styleColor) : styleBg.includes("rgba(127,127,127") && styleColor.includes("--dsw-alias-label-primary"), "可编辑态 " + tg.key + " 开关样式应与状态一致（开=高亮+白字、关=ghost+正文色），实际 " + JSON.stringify({ bg: styleBg, color: styleColor }));
  // N28-D2：ghost 分支的 alpha 也要钉区间（前缀一致时 alpha=0 / .95 都不是灰底）。
  if (!tg.base) {
    const ghostA = ghostAlpha(btn.props.style);
    check(isGhostAlpha(ghostA), "N28-D2：关闭态 " + tg.key + " 的 ghost 底色 alpha 应落在 " + GHOST_ALPHA_MIN + "–" + GHOST_ALPHA_MAX + "，实际 " + JSON.stringify(ghostA));
  }
  check(typeof btn.props.onClick === "function", "可编辑态 " + tg.key + " 开关必须挂可调用的 onClick（按钮死掉的形态直接红）");
  if (typeof btn.props.onClick === "function") { btn.props.onClick(); await sleep(20); }
  const after = await settlePage(b.state.regComp, "开关点击后 " + tg.key);
  const btn2 = nodeAfterLabel(after, tg.label, "button");
  check(btn2 !== null && textOf(btn2) !== before, "点击 " + tg.key + " 后开关文案应翻转，实际 " + JSON.stringify(btn2 && textOf(btn2)));
  const sb = saveButton(after);
  check(sb !== null && typeof sb.props.onClick === "function", "可编辑态保存按钮必须可点（" + tg.key + " 保存）");
  if (sb && typeof sb.props.onClick === "function") { sb.props.onClick(); await sleep(20); }
  const sent = b.state.configSetArgs[b.state.configSetArgs.length - 1];
  check(!!sent && sent.endpoint === "config.set", "点击保存应发出 config.set（" + tg.key + "）");
  // 不只比对被点的那个键：其余键的值也必须等于当前配置（否则错绑到别的 draft
  // 会在基准值恰好等于期望翻转值时全绿）。期望 = 基准配置 + 本键翻转。
  const expected = { ...FULL_CONFIG, concludeSilentTurn: false, [tg.key]: !tg.base };
  const missing = CONFIG_KEYS.filter((k) => !sent || !(k in sent));
  check(missing.length === 0, "config.set 载荷缺键：" + missing.join(",") + "（" + tg.key + " 用例）");
  const wrong = CONFIG_KEYS.filter((k) => !sent || sent[k] !== expected[k]);
  check(wrong.length === 0, "config.set 载荷与期望不符的键：" + wrong.map((k) => k + "=" + JSON.stringify(sent && sent[k]) + "≠" + JSON.stringify(expected[k])).join(",") + "（" + tg.key + " 用例）");
}

// ①′ 6 个非开关键（number/time/select 三种控件）各走一遍「真实 onChange 改 draft →
// 保存 → config.set 带出新值」。基准值互不相同（60/10/25/01:00/08:00/native），
// 新值全部不等于基准：删掉控件的 onChange、或把载荷写死成基准常量都会红。
// visionEngine 的基准是 native，这里改成 auto（同样是合法引擎值）。
const FIELD_CASES = [
  { key: "intervalMin", label: "心跳间隔（分钟）", kind: "input", base: 60, value: "45", expected: 45 },
  { key: "maxDailySend", label: "每日表达上限（条）", kind: "input", base: 10, value: "7", expected: 7 },
  { key: "timeInjectMin", label: "时间注入间隔（分钟）", kind: "input", base: 25, value: "3", expected: 3 },
  { key: "quietStart", label: "静默时段", kind: "input", index: 0, base: "01:00", value: "02:15", expected: "02:15" },
  { key: "quietEnd", label: "静默时段", kind: "input", index: 1, base: "08:00", value: "09:45", expected: "09:45" },
  { key: "visionEngine", label: "识别引擎", kind: "select", base: "native", value: "auto", expected: "auto" },
];
for (const fc of FIELD_CASES) {
  const { b, m } = await editableMount();
  check(!m.err, "配置字段 " + fc.key + " 用例挂载抛错（" + (m.err && m.err.message) + "）");
  const pick = (o) => (fc.kind === "select" ? engineInfo(o).select : nodeAfterLabel(o, fc.label, "input", fc.index || 0));
  let out = await settlePage(b.state.regComp, "字段 " + fc.key + " 挂载");
  const ctl = pick(out);
  check(ctl !== null, "配置字段 " + fc.key + " 应渲染控件");
  // 挂载后、onChange 前：控件值必须等于配置值（配置→draft 同步 effect 的基线）。
  check(ctl !== null && String(ctl.props.value) === String(fc.base), "配置字段 " + fc.key + " 挂载后应回填配置值 " + JSON.stringify(fc.base) + "，实际 " + JSON.stringify(ctl && ctl.props.value));
  check(ctl !== null && typeof ctl.props.onChange === "function", "配置字段 " + fc.key + " 控件必须挂 onChange（控件死掉直接红）");
  if (ctl && typeof ctl.props.onChange === "function") { ctl.props.onChange({ target: { value: fc.value } }); await sleep(20); }
  out = await settlePage(b.state.regComp, "字段 " + fc.key + " onChange 后");
  const after = pick(out);
  check(after !== null && after.props.value === fc.value, "配置字段 " + fc.key + " 的 draft 应随 onChange 变为 " + JSON.stringify(fc.value) + "，实际 " + JSON.stringify(after && after.props.value));
  const sb = saveButton(out);
  check(sb !== null && typeof sb.props.onClick === "function", "配置字段 " + fc.key + " 用例：保存按钮应可点");
  if (sb && typeof sb.props.onClick === "function") { sb.props.onClick(); await sleep(20); }
  const sent = b.state.configSetArgs[b.state.configSetArgs.length - 1];
  check(!!sent && sent.endpoint === "config.set", "配置字段 " + fc.key + " 点击保存应发出 config.set");
  check(!!sent && sent[fc.key] === fc.expected, "config.set 的 " + fc.key + " 应为新值 " + JSON.stringify(fc.expected) + "，实际 " + JSON.stringify(sent && sent[fc.key]));
  const expected = { ...FULL_CONFIG, concludeSilentTurn: false, [fc.key]: fc.expected };
  const wrong = CONFIG_KEYS.filter((k) => !sent || sent[k] !== expected[k]);
  check(wrong.length === 0, "配置字段 " + fc.key + " 保存时其余键被带错：" + wrong.map((k) => k + "=" + JSON.stringify(sent && sent[k]) + "≠" + JSON.stringify(expected[k])).join(","));
}

// ①″ 非兜底配置：11 个键全部取与 client.js 兜底值不同的值，钉住「配置→draft」同步
// effect 的每一处赋值。FULL_CONFIG 的多数值恰好等于兜底（10/25/false…），
// 只靠它的话删掉一处 setDraftX 也看不出来（审核中3）。
const NON_DEFAULT = {
  intervalMin: 90, maxDailySend: 20, timeInjectMin: 40,
  statusbar: true, idleMode: true, tokenSaver: true,
  visionEngine: "modlens", psyEnabled: true, concludeSilentTurn: true,
  quietStart: "03:30", quietEnd: "07:45",
};
{
  configValue = { ...NON_DEFAULT };
  configSetOk = true;
  const b = boot({ connection: true, locale: false, focusAfter: focusSnap(false, null) });
  const m = await mountPage(b.state.regComp, "config");
  check(!m.err, "非兜底配置挂载抛错（" + (m.err && m.err.message) + "）");
  const out = m.out;
  const nums = (out.scoped || []).filter((n) => n.type === "input" && n.props.type === "number").map((n) => Number(n.props.value));
  check(JSON.stringify(nums.slice(0, 3)) === JSON.stringify([90, 20, 40]), "非兜底配置：三个数字输入应回填 90/20/40，实际 " + JSON.stringify(nums));
  const times = (out.scoped || []).filter((n) => n.type === "input" && n.props.type === "time").map((n) => n.props.value);
  check(JSON.stringify(times) === JSON.stringify(["03:30", "07:45"]), "非兜底配置：两个时间输入应回填 03:30/07:45，实际 " + JSON.stringify(times));
  check(engineInfo(out).selectedValue === "modlens", "非兜底配置：引擎下拉应选中 modlens，实际 " + JSON.stringify(engineInfo(out).selectedValue));
  for (const label of ["状态栏", "静默收尾开关", "节省 token 模式", "psy 分区", "闲着模式"]) {
    const btn = nodeAfterLabel(out, label, "button");
    check(btn !== null && textOf(btn) === "☑ 开启", "非兜底配置：" + label + " 应渲染「☑ 开启」，实际 " + JSON.stringify(btn && textOf(btn)));
  }
  configValue = { ...FULL_CONFIG };
}

// ② 点「暂停」→ focus.pause + minutes 取输入框当值（钳制规则实测：Number(v)||30 →
// 向下取整 → 钳到 [1,1440]）；点后状态翻转、按钮变「恢复」。
// ③ 点「恢复」→ focus.resume、文案回到「暂停」。
const CLAMP_CASES = [
  { input: "0", sent: 30, why: "Number('0') 是 0 → ||30 落到缺省 30" },
  { input: "", sent: 30, why: "空串同样落到缺省 30" },
  { input: "9999", sent: 1440, why: "超上限钳到 1440" },
  { input: "45.7", sent: 45, why: "向下取整 45" },
  { input: "-3", sent: 1, why: "低于下限钳到 1" },
];
for (const c of CLAMP_CASES) {
  const { b, m } = await editableMount();
  check(!m.err, "专注钳制通道 " + JSON.stringify(c.input) + " 挂载抛错（" + (m.err && m.err.message) + "）");
  const out = await setFocusMinutes(b, c.input);
  const pb = focusedBtn(out);
  check(pb !== null && textOf(pb) === "暂停", "未暂停时应渲染「暂停」按钮（输入 " + JSON.stringify(c.input) + "），实际 " + JSON.stringify(pb && textOf(pb)));
  check(pb !== null && typeof pb.props.onClick === "function", "可编辑态「暂停」按钮必须挂可调用的 onClick");
  check(pb !== null && !pb.props.disabled, "可编辑态「暂停」按钮不应 disabled");
  const callsBefore = b.state.focusActionCalls;
  if (pb && typeof pb.props.onClick === "function") { pb.props.onClick(); await sleep(20); }
  check(b.state.focusActionCalls === callsBefore + 1, "点击暂停应发一次 focus RPC（输入 " + JSON.stringify(c.input) + "）");
  const sent = b.state.focusActionArgs[b.state.focusActionArgs.length - 1];
  check(!!sent && sent.endpoint === "focus.pause", "点击暂停应发 focus.pause，实际 " + JSON.stringify(sent && sent.endpoint));
  check(!!sent && sent.minutes === c.sent, "minutes 输入 " + JSON.stringify(c.input) + " 应发 " + c.sent + "（" + c.why + "），实际 " + JSON.stringify(sent && sent.minutes));
  const pausedOut = await settlePage(b.state.regComp, "钳制 " + JSON.stringify(c.input) + " 暂停后");
  check(textOf(focusedBtn(pausedOut)) === "恢复", "暂停成功后按钮应变成「恢复」（输入 " + JSON.stringify(c.input) + "）");
  check(pausedOut.text.join(" ").includes("已暂停至 12:30"), "暂停成功后应显示「已暂停至 12:30」（setFocus 落地），实际 " + JSON.stringify(pausedOut.text.join(" ").slice(0, 200)));
}

// ③ 恢复：暂停后用同一个挂载点「恢复」
{
  const { b, m } = await editableMount();
  check(!m.err, "恢复用例挂载抛错（" + (m.err && m.err.message) + "）");
  const out = await setFocusMinutes(b, "45");
  const pb = focusedBtn(out);
  if (pb && typeof pb.props.onClick === "function") { pb.props.onClick(); await sleep(20); }
  const pausedOut = await settlePage(b.state.regComp, "恢复用例暂停后");
  const rb = focusedBtn(pausedOut);
  check(rb !== null && textOf(rb) === "恢复", "暂停后应渲染「恢复」按钮");
  check(rb !== null && typeof rb.props.onClick === "function", "可编辑态「恢复」按钮必须挂可调用的 onClick");
  const callsBefore = b.state.focusActionCalls;
  if (rb && typeof rb.props.onClick === "function") { rb.props.onClick(); await sleep(20); }
  check(b.state.focusActionCalls === callsBefore + 1, "点击恢复应发一次 focus RPC");
  const sent = b.state.focusActionArgs[b.state.focusActionArgs.length - 1];
  check(!!sent && sent.endpoint === "focus.resume", "点击恢复应发 focus.resume，实际 " + JSON.stringify(sent && sent.endpoint));
  const resumed = await settlePage(b.state.regComp, "恢复用例恢复后");
  check(textOf(focusedBtn(resumed)) === "暂停", "恢复成功后按钮应回到「暂停」");
  check(resumed.text.join(" ").includes("暂停期间不心跳"), "恢复成功后应回到 config.focusHint 文案");
}

// ⑤ 失败分支：focus.* 返回 error / 抛错 → 显示 config.focusFailed；下一次成功清掉。
for (const mode of ["focusFail", "focusThrow"]) {
  const { opts, b, m } = await editableMount({ [mode]: true });
  check(!m.err, mode + " 用例挂载抛错（" + (m.err && m.err.message) + "）");
  const out = await setFocusMinutes(b, "30");
  const pb = focusedBtn(out);
  if (pb && typeof pb.props.onClick === "function") { pb.props.onClick(); await sleep(20); }
  const failedOut = await settlePage(b.state.regComp, mode + " 失败后");
  check(failedOut.text.join(" ").includes("操作失败"), mode + "：focus 失败时应显示「操作失败：…」文案，实际 " + JSON.stringify(failedOut.text.join(" ").slice(0, 200)));
  check(textOf(focusedBtn(failedOut)) === "暂停", mode + "：失败后不应假装已暂停");
  opts[mode] = false;
  const retry = focusedBtn(failedOut);
  if (retry && typeof retry.props.onClick === "function") { retry.props.onClick(); await sleep(20); }
  const recovered = await settlePage(b.state.regComp, mode + " 恢复后");
  check(!recovered.text.join(" ").includes("操作失败"), mode + "：下一次成功后应清掉失败文案，实际 " + JSON.stringify(recovered.text.join(" ").slice(0, 200)));
  check(textOf(focusedBtn(recovered)) === "恢复", mode + "：成功后按钮应翻转成「恢复」");
}

// ── 低6：focus.status 的 alive 守卫 ──
// 用例 1：旧的一拉被扣住 → 升级挂载补拉回新值 → 再放行旧的。最终必须显示新值，
// 旧值不许覆盖（删掉 alive 判断即红）。判定不设壁钟阈值。
{
  const staleOpts = { connection: false, locale: false, focusMount: focusSnap(true, "19:30"), focusAfter: focusSnap(true, "20:00") };
  const stale = boot(staleOpts);
  configValue = null;
  focusStatusHoldPending = true;
  // 同第五遍：挂载那次探测取不到（保持只读），之后的 focus.status 才有 connection 能打进桩。
  staleOpts.connection = "failOnce";
  await mountPage(stale.state.regComp, "config");
  const staleGate = focusStatusGate;
  check(staleGate !== null && staleGate.settled === false && typeof releaseFocusStatus === "function", "焦点拉取：旧 focus.status 请求应被闸门扣住");
  configValue = FULL_CONFIG;
  staleOpts.connection = true;
  const upStale = await mountPage(stale.state.regComp, "config");
  check(upStale.out.text.join(" ").includes("已暂停至 20:00"), "焦点拉取：升级挂载应显示新补拉值（20:00），实际 " + JSON.stringify(upStale.out.text.join(" ").slice(0, 200)));
  const upStaleCells = JSON.stringify(st.cells);
  if (typeof releaseFocusStatus === "function") releaseFocusStatus();
  await Promise.race([staleGate ? staleGate.done : Promise.resolve(), sleep(200)]);
  await sleep(0);
  check(staleGate !== null && staleGate.settled === true, "焦点拉取：放行后旧闸门应结算");
  const lateFocus = rerender(stale.state.regComp);
  check(!lateFocus.text.join(" ").includes("19:30"), "焦点拉取：旧请求迟到的值不应覆盖新补拉值（alive 守卫）");
  check(JSON.stringify(st.cells) === upStaleCells, "焦点拉取：旧请求迟到的值不应改写 state");
  focusStatusHoldPending = false;
  releaseFocusStatus = null;
  focusStatusGate = null;
}
// 用例 2：旧挂载迟到的 focus 值不许落进新挂载（卸载 cleanup）。
{
  configValue = { ...FULL_CONFIG };
  const holdOpts = { connection: true, locale: false, focusAfter: focusSnap(true, "21:00") };
  const holdB = boot(holdOpts);
  focusStatusHoldPending = true;
  await mountPage(holdB.state.regComp, "config");
  const holdGate = focusStatusGate;
  check(holdGate !== null && holdGate.settled === false && typeof releaseFocusStatus === "function", "焦点拉取：新挂载前的那次 focus.status 应被扣住");
  holdOpts.focusAfter = focusSnap(false, null);
  const freshMount = await mountPage(holdB.state.regComp, "config");
  const freshFocusCells = JSON.stringify(st.cells);
  check(!freshMount.out.text.join(" ").includes("已暂停至 21:00"), "焦点拉取：新挂载应显示自己的补拉值（未暂停），不是上一挂载的 21:00");
  if (typeof releaseFocusStatus === "function") releaseFocusStatus();
  await Promise.race([holdGate ? holdGate.done : Promise.resolve(), sleep(200)]);
  await sleep(0);
  check(holdGate !== null && holdGate.settled === true, "焦点拉取：放行后旧闸门应结算");
  const staleFocusOut = rerender(holdB.state.regComp);
  check(!staleFocusOut.text.join(" ").includes("已暂停至 21:00"), "焦点拉取：卸载后迟到的 focus 值不应渲染进新挂载");
  check(JSON.stringify(st.cells) === freshFocusCells, "焦点拉取：卸载后迟到的 focus 值不应改写新挂载的 state");
  check(st.dirty === false, "焦点拉取：卸载后迟到的 focus 值不应触发新挂载重渲染");
  focusStatusHoldPending = false;
  releaseFocusStatus = null;
  focusStatusGate = null;
}

// ── 建议3：专注成功不许清掉保存回执（status 是共享格，focus 失败要有自己的槽）──
// 反例：focus 失败/成功都写 status，点一次暂停成功就把刚显示出来的「已保存」抹掉。
{
  const { b, m } = await editableMount();
  check(!m.err, "保存回执用例挂载抛错（" + (m.err && m.err.message) + "）");
  const before = await settlePage(b.state.regComp, "保存回执挂载");
  const sb = saveButton(before);
  check(sb !== null && typeof sb.props.onClick === "function", "保存回执用例：保存按钮应可点");
  if (sb && typeof sb.props.onClick === "function") { sb.props.onClick(); await sleep(20); }
  const savedOut = await settlePage(b.state.regComp, "保存成功后");
  check(savedOut.text.join(" ").includes("已保存"), "保存成功后应显示「已保存」回执");
  const pb = focusedBtn(savedOut);
  if (pb && typeof pb.props.onClick === "function") { pb.props.onClick(); await sleep(20); }
  const afterPause = await settlePage(b.state.regComp, "保存回执后暂停");
  check(afterPause.text.join(" ").includes("已保存"), "点暂停成功后「已保存」回执不应被清掉");
  check(textOf(focusedBtn(afterPause)) === "恢复", "保存回执用例：暂停成功应翻成「恢复」");
}

// ── 低2：saveErr 与 focusErr 互不干扰（两个方向都钉住）──
// 方向一：保存失败 → 红字在；此后暂停成功不许清它。
// 方向二：专注失败 → 红字在；此后保存成功不许清它。
{
  const { b, m } = await editableMount();
  check(!m.err, "隔离用例一挂载抛错（" + (m.err && m.err.message) + "）");
  configSetOk = false;
  let out = await settlePage(b.state.regComp, "隔离用例一挂载");
  const sb = saveButton(out);
  if (sb && typeof sb.props.onClick === "function") { sb.props.onClick(); await sleep(20); }
  out = await settlePage(b.state.regComp, "隔离用例一保存失败后");
  check(out.text.join(" ").includes("保存失败"), "隔离用例一：保存失败应显示「保存失败：…」");
  configSetOk = true;
  const pb = focusedBtn(out);
  if (pb && typeof pb.props.onClick === "function") { pb.props.onClick(); await sleep(20); }
  out = await settlePage(b.state.regComp, "隔离用例一暂停成功后");
  check(out.text.join(" ").includes("保存失败"), "隔离用例一：暂停成功后不应清掉保存失败文案");
  check(textOf(focusedBtn(out)) === "恢复", "隔离用例一：暂停成功应翻成「恢复」");
}
{
  const { b, m } = await editableMount({ focusFail: true });
  check(!m.err, "隔离用例二挂载抛错（" + (m.err && m.err.message) + "）");
  let out = await settlePage(b.state.regComp, "隔离用例二挂载");
  const pb = focusedBtn(out);
  if (pb && typeof pb.props.onClick === "function") { pb.props.onClick(); await sleep(20); }
  out = await settlePage(b.state.regComp, "隔离用例二专注失败后");
  check(out.text.join(" ").includes("操作失败"), "隔离用例二：专注失败应显示「操作失败：…」");
  const sb = saveButton(out);
  if (sb && typeof sb.props.onClick === "function") { sb.props.onClick(); await sleep(20); }
  out = await settlePage(b.state.regComp, "隔离用例二保存成功后");
  check(out.text.join(" ").includes("已保存"), "隔离用例二：保存成功应显示「已保存」");
  check(out.text.join(" ").includes("操作失败"), "隔离用例二：保存成功不应清掉专注失败文案");
}

// ── 低1：失败方向也要互不清（双双失败，谁先谁后都不许清对方的红字）──
// 形态一：专注先失败 → 保存也失败 → 两条红字都在。
{
  const { b, m } = await editableMount({ focusFail: true });
  check(!m.err, "双失败用例一挂载抛错（" + (m.err && m.err.message) + "）");
  let out = await settlePage(b.state.regComp, "双失败一挂载");
  const pb = focusedBtn(out);
  if (pb && typeof pb.props.onClick === "function") { pb.props.onClick(); await sleep(20); }
  out = await settlePage(b.state.regComp, "双失败一专注失败后");
  check(out.text.join(" ").includes("操作失败"), "双失败一：专注失败应先出现「操作失败」");
  configSetOk = false;
  const sb = saveButton(out);
  if (sb && typeof sb.props.onClick === "function") { sb.props.onClick(); await sleep(20); }
  out = await settlePage(b.state.regComp, "双失败一保存也失败后");
  check(out.text.join(" ").includes("操作失败"), "双失败一：保存失败不应清掉专注失败文案");
  check(out.text.join(" ").includes("保存失败"), "双失败一：两条红字应同时在场");
}
// 形态二：保存先失败 → 专注也失败 → 两条红字都在。
// N26：这一格同时是「focus 失败分支不许动 saveErr」的钉子——先造出保存失败文案，
// 再让 focus.pause 失败，若 catch 里写 setSaveErr("")（或写别的值）本格即红（实测）。
{
  const { opts, b, m } = await editableMount();
  check(!m.err, "双失败用例二挂载抛错（" + (m.err && m.err.message) + "）");
  configSetOk = false;
  let out = await settlePage(b.state.regComp, "双失败二挂载");
  const sb = saveButton(out);
  if (sb && typeof sb.props.onClick === "function") { sb.props.onClick(); await sleep(20); }
  out = await settlePage(b.state.regComp, "双失败二保存失败后");
  check(out.text.join(" ").includes("保存失败"), "双失败二：保存失败应先出现「保存失败」");
  opts.focusFail = true;
  const pb = focusedBtn(out);
  if (pb && typeof pb.props.onClick === "function") { pb.props.onClick(); await sleep(20); }
  out = await settlePage(b.state.regComp, "双失败二专注也失败后");
  check(out.text.join(" ").includes("保存失败"), "双失败二：专注失败不应清掉保存失败文案");
  check(out.text.join(" ").includes("操作失败"), "双失败二：两条红字应同时在场");
}
// 形态三：保存成功（已保存）→ 专注失败 → 「已保存」不许被失败分支清掉。
{
  const { opts, b, m } = await editableMount();
  check(!m.err, "双失败用例三挂载抛错（" + (m.err && m.err.message) + "）");
  let out = await settlePage(b.state.regComp, "双失败三挂载");
  const sb = saveButton(out);
  if (sb && typeof sb.props.onClick === "function") { sb.props.onClick(); await sleep(20); }
  out = await settlePage(b.state.regComp, "双失败三保存成功后");
  check(out.text.join(" ").includes("已保存"), "双失败三：保存成功应显示「已保存」");
  opts.focusFail = true;
  const pb = focusedBtn(out);
  if (pb && typeof pb.props.onClick === "function") { pb.props.onClick(); await sleep(20); }
  out = await settlePage(b.state.regComp, "双失败三专注失败后");
  check(out.text.join(" ").includes("已保存"), "双失败三：专注失败不应清掉「已保存」回执");
  check(out.text.join(" ").includes("操作失败"), "双失败三：专注失败文案应同时出现");
}

// ── 建议4：config.get 的迟到写同样要被 alive 守卫挡掉（与 focus.status 同款）──
// 扣住挂载 A 的 config.get（intervalMin=111）→ 重挂载拉回 222 → 再放行 A：
// 输入框必须仍是 222，旧值不许覆盖（删掉 config.get 的 alive 判断即红）。
{
  configValue = { ...FULL_CONFIG, intervalMin: 111 };
  configSetOk = true;
  const opts = { connection: true, locale: false, focusAfter: focusSnap(false, null) };
  const b = boot(opts);
  configGetHoldCount = 1;
  configGetGates = [];
  await mountPage(b.state.regComp, "config");
  const cfgGate = configGetGate;
  check(cfgGate !== null && cfgGate.settled === false && typeof releaseConfigGet === "function", "config 拉取：第一拉应被闸门扣住");
  configValue = { ...FULL_CONFIG, intervalMin: 222 };
  const freshMount = await mountPage(b.state.regComp, "config");
  const freshNums = (freshMount.out.scoped || []).filter((n) => n.type === "input" && n.props.type === "number");
  check(freshNums.length > 0 && Number(freshNums[0].props.value) === 222, "config 拉取：新挂载应显示新值 222，实际 " + JSON.stringify(freshNums[0] && freshNums[0].props.value));
  const freshCfgCells = JSON.stringify(st.cells);
  if (typeof releaseConfigGet === "function") releaseConfigGet();
  await Promise.race([cfgGate ? cfgGate.done : Promise.resolve(), sleep(200)]);
  await sleep(0);
  check(cfgGate !== null && cfgGate.settled === true, "config 拉取：放行后旧闸门应结算");
  const lateCfgOut = rerender(b.state.regComp);
  const lateNums = (lateCfgOut.scoped || []).filter((n) => n.type === "input" && n.props.type === "number");
  check(lateNums.length > 0 && Number(lateNums[0].props.value) === 222, "config 拉取：旧请求迟到的值不应覆盖新值（alive 守卫），实际 " + JSON.stringify(lateNums[0] && lateNums[0].props.value));
  check(JSON.stringify(st.cells) === freshCfgCells, "config 拉取：旧请求迟到的值不应改写 state");
  configGetHoldCount = 0;
  configGetGates = [];
  releaseConfigGet = null;
  configGetGate = null;
}

// ── 低1：config.get 的 error 分支同样要守 alive ──
// 两次挂载的 config.get 都扣住；让旧挂载那一拉以错误结算，新挂载仍是「加载中」，
// 不许蹦出旧请求的「加载失败」。再放行新挂载自己的请求，界面应正常载入。
// 删掉 error 回调里的 if (alive) 即红。
{
  configValue = { ...FULL_CONFIG, intervalMin: 222 };
  configSetOk = true;
  const opts = { connection: true, locale: false, focusAfter: focusSnap(false, null) };
  const b = boot(opts);
  configGetHoldCount = 2;
  configGetGates = [];
  await mountPage(b.state.regComp, "config");
  const gateA = configGetGates[0];
  await mountPage(b.state.regComp, "config");
  const gateB = configGetGates[1];
  check(gateA && gateB && gateA.settled === false && gateB.settled === false, "config 错误分支：两次挂载的 config.get 都应被扣住");
  const beforeErr = rerender(b.state.regComp);
  check(!beforeErr.text.join(" ").includes("加载失败"), "config 错误分支：新挂载加载中时不应已有失败文案");
  if (gateA) gateA.release(anyLeaf); // 旧挂载那一拉以 rpc 错误结算
  const settledA = await Promise.race([gateA ? gateA.done : Promise.resolve(), sleep(200)]);
  await sleep(0);
  // 正向信号：这一拉真的以错误结算（桩若吞掉 reject 参数，下面的「不许污染」就空转了）。
  check(!!settledA && settledA.ok !== true, "config 错误分支：旧挂载那一拉确实以错误结算");
  check(gateA !== null && gateA.settled === true, "config 错误分支：旧请求应已结算");
  const afterOldErr = rerender(b.state.regComp);
  check(!afterOldErr.text.join(" ").includes("加载失败"), "config 错误分支：旧挂载迟到的失败不应让新挂载显示「加载失败」（error 分支 alive 守卫）");
  if (gateB) gateB.release();
  await Promise.race([gateB ? gateB.done : Promise.resolve(), sleep(200)]);
  await sleep(0);
  // 载入后 draft 同步 effect 还要跑一轮才把 draftInterval 写成 222，用 flush 而不是裸 render。
  const loaded = await flush(React.createElement(b.state.regComp, { view: "page" }), "config 错误分支载入");
  const loadedNums = (loaded.out.scoped || []).filter((n) => n.type === "input" && n.props.type === "number");
  check(loadedNums.length > 0 && Number(loadedNums[0].props.value) === 222, "config 错误分支：放行自己的请求后应正常载入 222，实际 " + JSON.stringify(loadedNums[0] && loadedNums[0].props.value));
  check(!loaded.out.text.join(" ").includes("加载失败"), "config 错误分支：正常载入后不应残留失败文案");
  configGetHoldCount = 0;
  configGetGates = [];
  releaseConfigGet = null;
  configGetGate = null;
}

// ── 中2：config.get 自己失败必须有阳性控制 ──
// 让 config.get 直接以 rpc 错误返回（configValue=null → anyLeaf）：挂载后必须出现
// 「加载失败」且不出现「加载中」。删掉 error 回调、接错 setter、或删掉
// 「loadErr && !value → 加载失败」分支，下面都会红。
{
  configValue = null;
  configSetOk = true;
  const b = boot({ connection: true, locale: false, focusAfter: focusSnap(false, null) });
  const m = await mountPage(b.state.regComp, "config");
  const text = m.out.text.join(" ");
  check(b.state.configGetCalls > 0, "config 失败阳性控制：应真的发出 config.get");
  check(text.includes("加载失败"), "config.get 失败时应显示「加载失败」文案，实际 " + JSON.stringify(text.slice(0, 160)));
  check(!text.includes("加载中"), "config.get 失败后不应停在「加载中」");
  configValue = { ...FULL_CONFIG };
}

// ── N28-D5：状态栏的 {error} 占位必须真的渲染出失败文案 ──
// status 以 rpc 错误结算时 StatusCard 走 `if (error) → 状态获取失败：{error}`；
// 删掉那条分支、或让 {error} 落空，此前整遍仍绿。
{
  statusValue = null; // 保持默认桩契约；错误由 opts.statusFail 结构化给出
  const b = boot({ connection: true, locale: false, statusFail: true });
  const m = await mountPage(b.state.regComp, "status");
  const text = m.out.text.join(" ");
  check(b.state.statusCalls > 0, "N28-D5：状态页应真的发出 status 请求");
  check(text.includes("状态获取失败"), "N28-D5：status 失败时应渲染「状态获取失败：…」占位，实际 " + JSON.stringify(text.slice(0, 160)));
  check(text.includes("status rpc exploded"), "N28-D5：失败占位应带出 rpc 错误详情（{error} 不是空占位），实际 " + JSON.stringify(text.slice(0, 160)));
  check(!text.includes("加载中"), "N28-D5：失败后不应停在「加载中」");
}

// ── N28-D4：settlePage 必须把 flush 的超轮次/渲染错误变成整遍失败 ──
// 命中口径：一个「每次渲染都 setState」的组件在 flush 里永远不收敛，settlePage
// 必须推一条带原因的失败；这里把它消费掉再断言内容，既证明判据在场、也不污染本轮。
{
  const spin = () => {
    const [n, setN] = React.useState(0);
    setN(n + 1);
    return React.createElement("span", null, String(n));
  };
  const before = failures.length;
  await settlePage(spin, "D4 不收敛自测");
  const extra = failures.splice(before);
  check(extra.length === 1 && extra[0].includes("未收敛") && extra[0].includes("D4 不收敛自测"), "N28-D4：不收敛的渲染必须让 settlePage 失败并带出原因，实际 " + JSON.stringify(extra));
}

if (failures.length) {
  console.log(JSON.stringify({ ok: false, failures }, null, 2));
  process.exit(1);
}
console.log("panel smoke OK: 槽位 " + slotName + " / key " + regOpts.key + " / " + TABS.length + " 个 tab 渲染通过 / 设置卡断言 + 只读 + 晚注册 + 只升不降断言通过");
