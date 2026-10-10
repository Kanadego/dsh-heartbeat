import {
  createPathGuard,
  deepMerge,
  describeInstall,
  installBundledPreset,
  loadPolicy,
  updateUserPolicy,
  userPresetRoot
} from "./chunk-ZLV4NMFX.js";
import {
  addBinding,
  loadBindings,
  removeBinding
} from "./chunk-TY6UP74X.js";
import {
  StatusReader,
  applyHeartbeatInterval,
  buildDigest,
  buildSeedReportTool,
  getLastBeat,
  homeSessionId,
  inQuietHours,
  readSentState,
  readStatus,
  reportFilePath,
  resetHomeSession,
  sessionEventCount,
  sessionEvents,
  startOrchestrator
} from "./chunk-AJ5HLAL7.js";
import {
  appendEntry,
  ledgerFilePath,
  listWeeklyReports,
  markDone,
  readLedger,
  readWeeklyReport,
  scanPending
} from "./chunk-IG6YMUHW.js";
import {
  getRuntime,
  setRuntime
} from "./chunk-3QJJRXIR.js";
import {
  activeSeeds,
  archiveSeedById,
  archivedSeeds,
  deleteSeed,
  loadPool,
  restoreSeed,
  seedsFilePath
} from "./chunk-JDH2LDFS.js";
import "./chunk-3MDBU6WY.js";
import "./chunk-IV2ZWQA3.js";
import "./chunk-KB5SMG3F.js";
import {
  appendAuditLine,
  loadProfile,
  profileFilePath
} from "./chunk-CUOSICYJ.js";
import {
  initWorkspace,
  writeText
} from "./chunk-K5Y6JP2B.js";
import {
  atomicWriteFileSync,
  atomicWriteJsonSync
} from "./chunk-WRUTATW4.js";

// node_modules/@deepseek-ai/cosmokit/lib/index.js
function isNullable(value) {
  return value === null || value === void 0;
}
function isPlainObject(data) {
  return data && typeof data === "object" && !Array.isArray(data);
}
function filterKeys(object, filter) {
  return Object.fromEntries(Object.entries(object).filter(([key, value]) => filter(key, value)));
}
function mapValues(object, transform) {
  return Object.fromEntries(Object.entries(object).map(([key, value]) => [key, transform(value, key)]));
}
function pick(source, keys, forced) {
  if (!keys) return { ...source };
  const result = {};
  for (const key of keys) if (forced || source[key] !== void 0) result[key] = source[key];
  return result;
}
var write = /* @__PURE__ */ Symbol.for("cosmokit.volatile.write");
function snapshot(value, ancestors = /* @__PURE__ */ new Set()) {
  if (typeof value === "function") throw new TypeError("volatile config cannot contain functions");
  if (value === null || typeof value !== "object") return value;
  if (ancestors.has(value)) throw new TypeError("volatile config cannot contain cycles");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return Object.freeze(value.map((item) => snapshot(item, ancestors)));
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new TypeError("volatile config objects must be plain objects or arrays");
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, snapshot(item, ancestors)])));
  } finally {
    ancestors.delete(value);
  }
}
function createVolatile(value) {
  let current = snapshot(value);
  return Object.freeze({
    get: () => current,
    [write]: (value2) => {
      current = value2;
    }
  });
}
function isVolatile(value) {
  return typeof value === "object" && value !== null && write in value;
}
function is(type, value) {
  if (arguments.length === 1) return (value2) => is(type, value2);
  return type in globalThis && value instanceof globalThis[type] || Object.prototype.toString.call(value).slice(8, -1) === type;
}
function isArrayBufferLike(value) {
  return is("ArrayBuffer", value) || is("SharedArrayBuffer", value);
}
function isArrayBufferSource(value) {
  return isArrayBufferLike(value) || ArrayBuffer.isView(value);
}
var Binary;
(function(Binary2) {
  Binary2.is = isArrayBufferLike;
  Binary2.isSource = isArrayBufferSource;
  function fromSource(source) {
    if (ArrayBuffer.isView(source)) return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
    else return source;
  }
  Binary2.fromSource = fromSource;
  function toBase64(source) {
    source = fromSource(source);
    if (typeof Buffer !== "undefined") return Buffer.from(source).toString("base64");
    let binary = "";
    const bytes = new Uint8Array(source);
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }
  Binary2.toBase64 = toBase64;
  function fromBase64(source) {
    if (typeof Buffer !== "undefined") return fromSource(Buffer.from(source, "base64"));
    return Uint8Array.from(atob(source), (c) => c.charCodeAt(0));
  }
  Binary2.fromBase64 = fromBase64;
  function toHex(source) {
    source = fromSource(source);
    if (typeof Buffer !== "undefined") return Buffer.from(source).toString("hex");
    return Array.from(new Uint8Array(source), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  Binary2.toHex = toHex;
  function fromHex(source) {
    if (typeof Buffer !== "undefined") return fromSource(Buffer.from(source, "hex"));
    const hex = source.length % 2 === 0 ? source : source.slice(0, source.length - 1);
    const buffer = [];
    for (let i = 0; i < hex.length; i += 2) buffer.push(parseInt(`${hex[i]}${hex[i + 1]}`, 16));
    return Uint8Array.from(buffer).buffer;
  }
  Binary2.fromHex = fromHex;
})(Binary || (Binary = {}));
var base64ToArrayBuffer = Binary.fromBase64;
var arrayBufferToBase64 = Binary.toBase64;
var hexToArrayBuffer = Binary.fromHex;
var arrayBufferToHex = Binary.toHex;
function clone(source, refs = /* @__PURE__ */ new Map()) {
  if (!source || typeof source !== "object") return source;
  if (is("Date", source)) return new Date(source.valueOf());
  if (is("RegExp", source)) return new RegExp(source.source, source.flags);
  if (isArrayBufferLike(source)) return source.slice(0);
  if (ArrayBuffer.isView(source)) return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
  const cached = refs.get(source);
  if (cached) return cached;
  if (Array.isArray(source)) {
    const result2 = [];
    refs.set(source, result2);
    source.forEach((value, index) => {
      result2[index] = Reflect.apply(clone, null, [value, refs]);
    });
    return result2;
  }
  const result = Object.create(Object.getPrototypeOf(source));
  refs.set(source, result);
  for (const key of Reflect.ownKeys(source)) {
    const descriptor = { ...Reflect.getOwnPropertyDescriptor(source, key) };
    if ("value" in descriptor) descriptor.value = Reflect.apply(clone, null, [descriptor.value, refs]);
    Reflect.defineProperty(result, key, descriptor);
  }
  return result;
}
function deepEqual(a, b, strict) {
  const ancestors = /* @__PURE__ */ new Set();
  function compare(a2, b2) {
    if (a2 === b2) return true;
    if (isVolatile(a2) || isVolatile(b2)) return isVolatile(a2) && isVolatile(b2);
    if (!strict && isNullable(a2) && isNullable(b2)) return true;
    if (typeof a2 !== typeof b2 || typeof a2 !== "object" || !a2 || !b2) return false;
    if (ancestors.has(a2)) return false;
    function check(test, then) {
      return test(a2) ? test(b2) ? then(a2, b2) : false : test(b2) ? false : void 0;
    }
    ancestors.add(a2);
    try {
      return check(Array.isArray, (a3, b3) => {
        if (a3.length !== b3.length) return false;
        for (let index = 0; index < a3.length; index++) if (!compare(a3[index], b3[index])) return false;
        return true;
      }) ?? check(is("Date"), (a3, b3) => a3.valueOf() === b3.valueOf()) ?? check(is("URL"), (a3, b3) => a3.href === b3.href) ?? check(is("RegExp"), (a3, b3) => a3.source === b3.source && a3.flags === b3.flags) ?? check(isArrayBufferLike, (a3, b3) => {
        if (a3.byteLength !== b3.byteLength) return false;
        const viewA = new Uint8Array(a3);
        const viewB = new Uint8Array(b3);
        for (let i = 0; i < viewA.length; i++) if (viewA[i] !== viewB[i]) return false;
        return true;
      }) ?? ((!strict || [a2, b2].every((value) => Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) && Object.keys({
        ...a2,
        ...b2
      }).every((key) => compare(a2[key], b2[key])));
    } finally {
      ancestors.delete(a2);
    }
  }
  return compare(a, b);
}
var Time;
(function(Time2) {
  Time2.millisecond = 1;
  Time2.second = 1e3;
  Time2.minute = Time2.second * 60;
  Time2.hour = Time2.minute * 60;
  Time2.day = Time2.hour * 24;
  Time2.week = Time2.day * 7;
  let timezoneOffset = (/* @__PURE__ */ new Date()).getTimezoneOffset();
  function setTimezoneOffset(offset) {
    timezoneOffset = offset;
  }
  Time2.setTimezoneOffset = setTimezoneOffset;
  function getTimezoneOffset() {
    return timezoneOffset;
  }
  Time2.getTimezoneOffset = getTimezoneOffset;
  function getDateNumber(date2 = /* @__PURE__ */ new Date(), offset) {
    if (typeof date2 === "number") date2 = new Date(date2);
    if (offset === void 0) offset = timezoneOffset;
    return Math.floor((date2.valueOf() / Time2.minute - offset) / 1440);
  }
  Time2.getDateNumber = getDateNumber;
  function fromDateNumber(value, offset) {
    const date2 = new Date(value * Time2.day);
    if (offset === void 0) offset = timezoneOffset;
    return new Date(+date2 + offset * Time2.minute);
  }
  Time2.fromDateNumber = fromDateNumber;
  const numeric = /\d+(?:\.\d+)?/.source;
  const timeRegExp = new RegExp(`^${[
    "w(?:eek(?:s)?)?",
    "d(?:ay(?:s)?)?",
    "h(?:our(?:s)?)?",
    "m(?:in(?:ute)?(?:s)?)?",
    "s(?:ec(?:ond)?(?:s)?)?"
  ].map((unit) => `(${numeric}${unit})?`).join("")}$`);
  function parseTime(source) {
    const capture = timeRegExp.exec(source);
    if (!capture) return 0;
    return (parseFloat(capture[1]) * Time2.week || 0) + (parseFloat(capture[2]) * Time2.day || 0) + (parseFloat(capture[3]) * Time2.hour || 0) + (parseFloat(capture[4]) * Time2.minute || 0) + (parseFloat(capture[5]) * Time2.second || 0);
  }
  Time2.parseTime = parseTime;
  function parseDate(date2) {
    const parsed = parseTime(date2);
    if (parsed) date2 = Date.now() + parsed;
    else if (/^\d{1,2}(:\d{1,2}){1,2}$/.test(date2)) date2 = `${(/* @__PURE__ */ new Date()).toLocaleDateString()}-${date2}`;
    else if (/^\d{1,2}-\d{1,2}-\d{1,2}(:\d{1,2}){1,2}$/.test(date2)) date2 = `${(/* @__PURE__ */ new Date()).getFullYear()}-${date2}`;
    return date2 ? new Date(date2) : /* @__PURE__ */ new Date();
  }
  Time2.parseDate = parseDate;
  function format(ms) {
    const abs = Math.abs(ms);
    if (abs >= Time2.day - Time2.hour / 2) return Math.round(ms / Time2.day) + "d";
    else if (abs >= Time2.hour - Time2.minute / 2) return Math.round(ms / Time2.hour) + "h";
    else if (abs >= Time2.minute - Time2.second / 2) return Math.round(ms / Time2.minute) + "m";
    else if (abs >= Time2.second) return Math.round(ms / Time2.second) + "s";
    return ms + "ms";
  }
  Time2.format = format;
  function toDigits(source, length = 2) {
    return source.toString().padStart(length, "0");
  }
  Time2.toDigits = toDigits;
  function template(template2, time = /* @__PURE__ */ new Date()) {
    return template2.replace("yyyy", time.getFullYear().toString()).replace("yy", time.getFullYear().toString().slice(2)).replace("MM", toDigits(time.getMonth() + 1)).replace("dd", toDigits(time.getDate())).replace("hh", toDigits(time.getHours())).replace("mm", toDigits(time.getMinutes())).replace("ss", toDigits(time.getSeconds())).replace("SSS", toDigits(time.getMilliseconds(), 3));
  }
  Time2.template = template;
})(Time || (Time = {}));

// node_modules/@deepseek-ai/schemastery/lib/index.mjs
var kSchema = /* @__PURE__ */ Symbol.for("schemastery");
var kValidationError = /* @__PURE__ */ Symbol.for("ValidationError");
globalThis.__schemastery_index__ ??= 0;
globalThis.__schemastery_refs__ = void 0;
var ValidationError = class extends TypeError {
  options;
  name = "ValidationError";
  constructor(message, options) {
    let prefix = "$";
    for (const segment of options.path || []) if (typeof segment === "string") prefix += "." + segment;
    else if (typeof segment === "number") prefix += "[" + segment + "]";
    else if (typeof segment === "symbol") prefix += `[Symbol(${segment.toString()})]`;
    if (prefix.startsWith(".")) prefix = prefix.slice(1);
    super((prefix === "$" ? "" : `${prefix} `) + message);
    this.options = options;
  }
  static is(error) {
    return !!error?.[kValidationError];
  }
};
Object.defineProperty(ValidationError.prototype, kValidationError, { value: true });
var Schema = function(options) {
  const schema = function(data, options2 = {}) {
    return Schema.resolve(data, schema, options2)[0];
  };
  if (options.refs) {
    const refs = mapValues(options.refs, (options2) => new Schema(options2));
    const getRef = (uid) => refs[uid];
    for (const key in refs) {
      const options2 = refs[key];
      options2.sKey = getRef(options2.sKey);
      options2.inner = getRef(options2.inner);
      options2.list = options2.list && options2.list.map(getRef);
      options2.dict = options2.dict && mapValues(options2.dict, getRef);
    }
    return refs[options.uid];
  }
  Object.assign(schema, options);
  if (typeof schema.callback === "string") try {
    schema.callback = new Function("return " + schema.callback)();
  } catch {
  }
  Object.defineProperty(schema, "uid", { value: globalThis.__schemastery_index__++ });
  Object.setPrototypeOf(schema, Schema.prototype);
  schema.meta ||= {};
  schema.toString = schema.toString.bind(schema);
  return schema;
};
Schema.prototype = Object.create(Function.prototype);
Schema.prototype[kSchema] = true;
Object.defineProperty(Schema.prototype, "~standard", { get() {
  return {
    version: 1,
    vendor: "schemastery",
    validate: (value) => {
      try {
        return { value: Schema.resolve(value, this, {})[0] };
      } catch (error) {
        if (ValidationError.is(error)) return { issues: [{
          message: error.message,
          path: error.options.path
        }] };
        throw error;
      }
    }
  };
} });
Schema.ValidationError = ValidationError;
Schema.prototype.toJSON = function toJSON() {
  if (globalThis.__schemastery_refs__) {
    globalThis.__schemastery_refs__[this.uid] ??= JSON.parse(JSON.stringify({ ...this }));
    return this.uid;
  }
  globalThis.__schemastery_refs__ = { [this.uid]: { ...this } };
  globalThis.__schemastery_refs__[this.uid] = JSON.parse(JSON.stringify({ ...this }));
  const result = {
    uid: this.uid,
    refs: globalThis.__schemastery_refs__
  };
  globalThis.__schemastery_refs__ = void 0;
  return result;
};
Schema.prototype.set = function set(key, value) {
  this.dict[key] = value;
  return this;
};
Schema.prototype.push = function push(value) {
  this.list.push(value);
  return this;
};
function mergeDesc(original, messages) {
  const result = typeof original === "string" ? { "": original } : { ...original };
  for (const locale in messages) {
    const value = messages[locale];
    if (value?.$description || value?.$desc) result[locale] = value.$description || value.$desc;
    else if (typeof value === "string") result[locale] = value;
  }
  return result;
}
function getInner(value) {
  return value?.$value ?? value?.$inner;
}
function extractKeys(data) {
  return filterKeys(data ?? {}, (key) => !key.startsWith("$"));
}
Schema.prototype.i18n = function i18n(messages) {
  const schema = Schema(this);
  const desc = mergeDesc(schema.meta.description, messages);
  if (Object.keys(desc).length) schema.meta.description = desc;
  if (schema.dict) schema.dict = mapValues(schema.dict, (inner, key) => {
    return inner.i18n(mapValues(messages, (data) => getInner(data)?.[key] ?? data?.[key]));
  });
  if (schema.list) schema.list = schema.list.map((inner, index) => {
    return inner.i18n(mapValues(messages, (data = {}) => {
      if (Array.isArray(getInner(data))) return getInner(data)[index];
      if (Array.isArray(data)) return data[index];
      return extractKeys(data);
    }));
  });
  if (schema.inner) schema.inner = schema.inner.i18n(mapValues(messages, (data) => {
    if (getInner(data)) return getInner(data);
    return extractKeys(data);
  }));
  if (schema.sKey) schema.sKey = schema.sKey.i18n(mapValues(messages, (data) => data?.$key));
  return schema;
};
Schema.prototype.extra = function extra(key, value) {
  const schema = Schema(this);
  schema.meta = {
    ...schema.meta,
    [key]: value
  };
  return schema;
};
for (const key of [
  "required",
  "disabled",
  "collapse",
  "hidden",
  "loose"
]) Object.assign(Schema.prototype, { [key](value = true) {
  const schema = Schema(this);
  schema.meta = {
    ...schema.meta,
    [key]: value
  };
  return schema;
} });
Schema.prototype.deprecated = function deprecated() {
  const schema = Schema(this);
  schema.meta.badges ||= [];
  schema.meta.badges.push({
    text: "deprecated",
    type: "danger"
  });
  return schema;
};
Schema.prototype.experimental = function experimental() {
  const schema = Schema(this);
  schema.meta.badges ||= [];
  schema.meta.badges.push({
    text: "experimental",
    type: "warning"
  });
  return schema;
};
Schema.prototype.pattern = function pattern(regexp) {
  const schema = Schema(this);
  const pattern2 = pick(regexp, ["source", "flags"]);
  schema.meta = {
    ...schema.meta,
    pattern: pattern2
  };
  return schema;
};
Schema.prototype.simplify = function simplify(value) {
  if (isVolatile(value)) value = value.get();
  if (deepEqual(value, this.meta.default, this.type === "dict")) return null;
  if (isNullable(value)) return value;
  if (this.type === "object" || this.type === "dict") {
    const result = {};
    for (const key in value) {
      const item = (this.type === "object" ? this.dict[key] : this.inner)?.simplify(value[key]);
      if (this.type === "dict" || !isNullable(item)) result[key] = item;
    }
    if (deepEqual(result, this.meta.default, this.type === "dict")) return null;
    return result;
  } else if (this.type === "array" || this.type === "tuple") {
    const result = [];
    value.forEach((value2, index) => {
      const schema = this.type === "array" ? this.inner : this.list[index];
      const item = schema ? schema.simplify(value2) : value2;
      result.push(item);
    });
    return result;
  } else if (this.type === "intersect") {
    const result = {};
    for (const item of this.list) Object.assign(result, item.simplify(value));
    return result;
  } else if (this.type === "union") for (const schema of this.list) try {
    Schema.resolve(value, schema, {});
    return schema.simplify(value);
  } catch {
  }
  return value;
};
Schema.prototype.toString = function toString(inline) {
  return formatters[this.type]?.(this, inline) ?? `Schema<${this.type}>`;
};
Schema.prototype.role = function role(role, extra2) {
  const schema = Schema(this);
  schema.meta = {
    ...schema.meta,
    role,
    extra: extra2
  };
  return schema;
};
for (const key of [
  "default",
  "link",
  "comment",
  "description",
  "max",
  "min",
  "step"
]) Object.assign(Schema.prototype, { [key](value) {
  const schema = Schema(this);
  schema.meta = {
    ...schema.meta,
    [key]: value
  };
  return schema;
} });
Schema.prototype.volatile = function volatile() {
  if (this.meta.volatile) throw new TypeError("volatile schema is already wrapped");
  return this.extra("volatile", true);
};
var resolvers = {};
var checkedVolatile = /* @__PURE__ */ Symbol("checked-volatile-schema");
function validateVolatileSchema(schema, path5 = [], blocked = false, seen = /* @__PURE__ */ new Map()) {
  const states = seen.get(schema) ?? /* @__PURE__ */ new Set();
  if (states.has(blocked)) return;
  states.add(blocked);
  seen.set(schema, states);
  if (schema.meta?.volatile && blocked) throw new ValidationError("volatile fields require a fixed object path without an enclosing volatile field", { path: path5 });
  const nested = blocked || !!schema.meta?.volatile;
  if (schema.dict) for (const [key, child] of Object.entries(schema.dict)) validateVolatileSchema(child, [...path5, key], nested, seen);
  if (schema.sKey) validateVolatileSchema(schema.sKey, [...path5, "<key>"], true, seen);
  if (schema.inner && (schema.type !== "lazy" || schema.inner[kSchema])) validateVolatileSchema(schema.inner, [...path5, "*"], true, seen);
  if (schema.list) for (let index = 0; index < schema.list.length; index++) validateVolatileSchema(schema.list[index], [...path5, String(index)], true, seen);
}
Schema.extend = function extend(type, resolve2) {
  resolvers[type] = resolve2;
};
Schema.resolve = function resolve(data, schema, options = {}, strict = false) {
  if (!schema) return [data];
  if (!options[checkedVolatile]) {
    validateVolatileSchema(schema, options.path);
    options = {
      ...options,
      [checkedVolatile]: true
    };
  }
  if (schema.meta?.volatile) {
    const inner = Schema(schema);
    inner.meta = {
      ...schema.meta,
      volatile: false
    };
    const [value, adapted] = Schema.resolve(data, inner, options, strict);
    try {
      return [createVolatile(value), adapted];
    } catch (error) {
      throw new ValidationError(error instanceof Error ? error.message : String(error), options);
    }
  }
  if (options.ignore?.(data, schema)) return [data];
  if (isNullable(data) && schema.type !== "lazy") {
    if (schema.meta.required) throw new ValidationError(`missing required value`, options);
    let current = schema;
    let fallback = schema.meta.default;
    while (current?.type === "intersect" && isNullable(fallback)) {
      current = current.list[0];
      fallback = current?.meta.default;
    }
    if (isNullable(fallback)) return [data];
    data = clone(fallback);
  }
  const callback = resolvers[schema.type];
  if (!callback) throw new ValidationError(`unsupported type "${schema.type}"`, options);
  try {
    return callback(data, schema, options, strict);
  } catch (error) {
    if (!schema.meta.loose) throw error;
    return [schema.meta.default];
  }
};
Schema.from = function from(source) {
  if (isNullable(source)) return Schema.any();
  else if ([
    "string",
    "number",
    "boolean"
  ].includes(typeof source)) return Schema.const(source).required();
  else if (source[kSchema]) return source;
  else if (typeof source === "function") switch (source) {
    case String:
      return Schema.string().required();
    case Number:
      return Schema.number().required();
    case Boolean:
      return Schema.boolean().required();
    case Function:
      return Schema.function().required();
    default:
      return Schema.is(source).required();
  }
  else throw new TypeError(`cannot infer schema from ${source}`);
};
Schema.lazy = function lazy(builder) {
  const toJSON2 = () => {
    if (!schema.inner[kSchema]) {
      schema.inner = schema.builder();
      schema.inner.meta = {
        ...schema.meta,
        ...schema.inner.meta
      };
    }
    return schema.inner.toJSON();
  };
  const schema = new Schema({
    type: "lazy",
    builder,
    inner: { toJSON: toJSON2 }
  });
  return schema;
};
Schema.natural = function natural() {
  return Schema.number().step(1).min(0);
};
Schema.percent = function percent() {
  return Schema.number().step(0.01).min(0).max(1).role("slider");
};
Schema.date = function date() {
  return Schema.union([Schema.is(Date), Schema.transform(Schema.string().role("datetime"), (value, options) => {
    const date2 = new Date(value);
    if (isNaN(+date2)) throw new ValidationError(`invalid date "${value}"`, options);
    return date2;
  }, true)]);
};
Schema.regExp = function regExp(flag = "") {
  return Schema.union([Schema.is(RegExp), Schema.transform(Schema.string().role("regexp", { flag }), (value, options) => {
    try {
      return new RegExp(value, flag);
    } catch (e) {
      throw new ValidationError(e.message, options);
    }
  }, true)]);
};
Schema.arrayBuffer = function arrayBuffer(encoding) {
  return Schema.union([
    Schema.is(ArrayBuffer),
    Schema.is(SharedArrayBuffer),
    Schema.transform(Schema.any(), (value, options) => {
      if (Binary.isSource(value)) return Binary.fromSource(value);
      throw new ValidationError(`expected ArrayBufferSource but got ${value}`, options);
    }, true),
    ...encoding ? [Schema.transform(Schema.string(), (value, options) => {
      try {
        return encoding === "base64" ? Binary.fromBase64(value) : Binary.fromHex(value);
      } catch (e) {
        throw new ValidationError(e.message, options);
      }
    }, true)] : []
  ]);
};
Schema.extend("lazy", (data, schema, options, strict) => {
  if (!schema.inner[kSchema]) {
    schema.inner = schema.builder();
    schema.inner.meta = {
      ...schema.meta,
      ...schema.inner.meta
    };
    validateVolatileSchema(schema.inner, options.path, true);
  }
  return Schema.resolve(data, schema.inner, options, strict);
});
Schema.extend("any", (data) => {
  return [data];
});
Schema.extend("never", (data, _, options) => {
  throw new ValidationError(`expected nullable but got ${data}`, options);
});
Schema.extend("const", (data, { value }, options) => {
  if (deepEqual(data, value)) return [value];
  throw new ValidationError(`expected ${value} but got ${data}`, options);
});
function checkWithinRange(data, meta, description, options, skipMin = false) {
  const { max = Infinity, min = -Infinity } = meta;
  if (data > max) throw new ValidationError(`expected ${description} <= ${max} but got ${data}`, options);
  if (data < min && !skipMin) throw new ValidationError(`expected ${description} >= ${min} but got ${data}`, options);
}
Schema.extend("string", (data, { meta }, options) => {
  if (typeof data !== "string") throw new ValidationError(`expected string but got ${data}`, options);
  if (meta.pattern) {
    const regexp = new RegExp(meta.pattern.source, meta.pattern.flags);
    if (!regexp.test(data)) throw new ValidationError(`expect string to match regexp ${regexp}`, options);
  }
  checkWithinRange(data.length, meta, "string length", options);
  return [data];
});
function decimalShift(data, digits) {
  const str = data.toString();
  if (str.includes("e")) return data * Math.pow(10, digits);
  const index = str.indexOf(".");
  if (index === -1) return data * Math.pow(10, digits);
  const frac = str.slice(index + 1);
  const integer = str.slice(0, index);
  if (frac.length <= digits) return +(integer + frac.padEnd(digits, "0"));
  return +(integer + frac.slice(0, digits) + "." + frac.slice(digits));
}
function isMultipleOf(data, min, step) {
  step = Math.abs(step);
  if (!/^\d+\.\d+$/.test(step.toString())) return (data - min) % step === 0;
  const index = step.toString().indexOf(".");
  const digits = step.toString().slice(index + 1).length;
  return Math.abs(decimalShift(data, digits) - decimalShift(min, digits)) % decimalShift(step, digits) === 0;
}
Schema.extend("number", (data, { meta }, options) => {
  if (typeof data !== "number") throw new ValidationError(`expected number but got ${data}`, options);
  checkWithinRange(data, meta, "number", options);
  const { step } = meta;
  if (step && !isMultipleOf(data, meta.min ?? 0, step)) throw new ValidationError(`expected number multiple of ${step} but got ${data}`, options);
  return [data];
});
Schema.extend("boolean", (data, _, options) => {
  if (typeof data === "boolean") return [data];
  throw new ValidationError(`expected boolean but got ${data}`, options);
});
Schema.extend("bitset", (data, { bits, meta }, options) => {
  let value = 0, keys = [];
  if (typeof data === "number") {
    value = data;
    for (const key in bits) if (data & bits[key]) keys.push(key);
  } else if (Array.isArray(data)) {
    keys = data;
    for (const key of keys) {
      if (typeof key !== "string") throw new ValidationError(`expected string but got ${key}`, options);
      if (key in bits) value |= bits[key];
    }
  } else throw new ValidationError(`expected number or array but got ${data}`, options);
  if (value === meta.default) return [value];
  return [value, keys];
});
Schema.extend("function", (data, _, options) => {
  if (typeof data === "function") return [data];
  throw new ValidationError(`expected function but got ${data}`, options);
});
Schema.extend("is", (data, { constructor }, options) => {
  if (typeof constructor === "function") {
    if (data instanceof constructor) return [data];
    throw new ValidationError(`expected ${constructor.name} but got ${data}`, options);
  } else {
    if (isNullable(data)) throw new ValidationError(`expected ${constructor} but got ${data}`, options);
    let prototype = Object.getPrototypeOf(data);
    while (prototype) {
      if (prototype.constructor?.name === constructor) return [data];
      prototype = Object.getPrototypeOf(prototype);
    }
    throw new ValidationError(`expected ${constructor} but got ${data}`, options);
  }
});
function property(data, key, schema, options) {
  try {
    const [value, adapted] = Schema.resolve(data[key], schema, {
      ...options,
      path: [...options.path || [], key]
    });
    if (adapted !== void 0) data[key] = adapted;
    return value;
  } catch (e) {
    if (!options?.autofix) throw e;
    delete data[key];
    return schema.meta.volatile ? createVolatile(schema.meta.default) : schema.meta.default;
  }
}
Schema.extend("array", (data, { inner, meta }, options) => {
  if (!Array.isArray(data)) throw new ValidationError(`expected array but got ${data}`, options);
  checkWithinRange(data.length, meta, "array length", options, !isNullable(inner.meta.default));
  return [data.map((_, index) => property(data, index, inner, options))];
});
Schema.extend("dict", (data, { inner, sKey }, options, strict) => {
  if (!isPlainObject(data)) throw new ValidationError(`expected object but got ${data}`, options);
  const result = {};
  for (const key in data) {
    let rKey;
    try {
      rKey = Schema.resolve(key, sKey, options)[0];
    } catch (error) {
      if (strict) continue;
      throw error;
    }
    result[rKey] = property(data, key, inner, options);
    data[rKey] = data[key];
    if (key !== rKey) delete data[key];
  }
  return [result];
});
Schema.extend("tuple", (data, { list }, options, strict) => {
  if (!Array.isArray(data)) throw new ValidationError(`expected array but got ${data}`, options);
  const result = list.map((inner, index) => property(data, index, inner, options));
  if (strict) return [result];
  result.push(...data.slice(list.length));
  return [result];
});
function merge(result, data) {
  for (const key in data) {
    if (key in result) continue;
    result[key] = data[key];
  }
}
Schema.extend("object", (data, { dict }, options, strict) => {
  if (!isPlainObject(data)) throw new ValidationError(`expected object but got ${data}`, options);
  const result = {};
  for (const key in dict) {
    const value = property(data, key, dict[key], options);
    if (!isNullable(value) || key in data) result[key] = value;
  }
  if (!strict) merge(result, data);
  return [result];
});
Schema.extend("union", (data, { list, toString: toString2 }, options, strict) => {
  const messages = [];
  for (const inner of list) try {
    return Schema.resolve(data, inner, options, strict);
  } catch (error) {
    messages.push(error);
  }
  throw new ValidationError(`expected ${toString2()} but got ${JSON.stringify(data)}`, options);
});
Schema.extend("intersect", (data, { list, toString: toString2 }, options, strict) => {
  if (!list.length) return [data];
  let result;
  for (const inner of list) {
    const value = Schema.resolve(data, inner, options, true)[0];
    if (isNullable(value)) continue;
    if (isNullable(result)) result = value;
    else if (typeof result !== typeof value) throw new ValidationError(`expected ${toString2()} but got ${JSON.stringify(data)}`, options);
    else if (typeof value === "object") merge(result ??= {}, value);
    else if (result !== value) throw new ValidationError(`expected ${toString2()} but got ${JSON.stringify(data)}`, options);
  }
  if (!strict && isPlainObject(data)) merge(result, data);
  return [result];
});
Schema.extend("transform", (data, { inner, callback, preserve }, options) => {
  const [result, adapted = data] = Schema.resolve(data, inner, options, true);
  if (preserve) return [callback(result)];
  else return [callback(result), callback(adapted)];
});
var formatters = {};
function defineMethod(name2, keys, format) {
  formatters[name2] = format;
  Object.assign(Schema, { [name2](...args) {
    const schema = new Schema({ type: name2 });
    keys.forEach((key, index) => {
      switch (key) {
        case "sKey":
          schema.sKey = args[index] ?? Schema.string();
          break;
        case "inner":
          schema.inner = Schema.from(args[index]);
          break;
        case "list":
          schema.list = args[index].map(Schema.from);
          break;
        case "dict":
          schema.dict = mapValues(args[index], Schema.from);
          break;
        case "bits":
          schema.bits = {};
          for (const key2 in args[index]) {
            if (typeof args[index][key2] !== "number") continue;
            schema.bits[key2] = args[index][key2];
          }
          break;
        case "callback": {
          const callback = schema.callback = args[index];
          callback["toJSON"] ||= () => callback.toString();
          break;
        }
        case "constructor": {
          const constructor = schema.constructor = args[index];
          if (typeof constructor === "function") constructor["toJSON"] ||= () => constructor["name"];
          break;
        }
        default:
          schema[key] = args[index];
      }
    });
    if (name2 === "object" || name2 === "dict") schema.meta.default = {};
    else if (name2 === "array" || name2 === "tuple") schema.meta.default = [];
    else if (name2 === "bitset") schema.meta.default = 0;
    return schema;
  } });
}
defineMethod("is", ["constructor"], ({ constructor }) => {
  if (typeof constructor === "function") return constructor.name;
  else return constructor;
});
defineMethod("any", [], () => "any");
defineMethod("never", [], () => "never");
defineMethod("const", ["value"], ({ value }) => typeof value === "string" ? JSON.stringify(value) : value);
defineMethod("string", [], () => "string");
defineMethod("number", [], () => "number");
defineMethod("boolean", [], () => "boolean");
defineMethod("bitset", ["bits"], () => "bitset");
defineMethod("function", [], () => "function");
defineMethod("array", ["inner"], ({ inner }) => `${inner.toString(true)}[]`);
defineMethod("dict", ["inner", "sKey"], ({ inner, sKey }) => `{ [key: ${sKey.toString()}]: ${inner.toString()} }`);
defineMethod("tuple", ["list"], ({ list }) => `[${list.map((inner) => inner.toString()).join(", ")}]`);
defineMethod("object", ["dict"], ({ dict }) => {
  if (Object.keys(dict).length === 0) return "{}";
  return `{ ${Object.entries(dict).map(([key, inner]) => {
    return `${key}${inner.meta.required ? "" : "?"}: ${inner.toString()}`;
  }).join(", ")} }`;
});
defineMethod("union", ["list"], ({ list }, inline) => {
  const result = list.map(({ toString: format }) => format()).join(" | ");
  return inline ? `(${result})` : result;
});
defineMethod("intersect", ["list"], ({ list }) => {
  return `${list.map((inner) => inner.toString(true)).join(" & ")}`;
});
defineMethod("transform", [
  "inner",
  "callback",
  "preserve"
], ({ inner }, isInner) => inner.toString(isInner));

// src/config/ui-config.ts
import fs from "fs";
import path from "path";
var USER_UI_FILE = "ui.json";
var RANGES = {
  intervalMin: { min: 1, max: 1440 },
  maxDailySend: { min: 1, max: 50 },
  timeInjectMin: { min: 0, max: 1440 }
};
function sanitize(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const r = raw;
  const out = {};
  for (const key of ["intervalMin", "maxDailySend", "timeInjectMin"]) {
    const v = r[key];
    if (typeof v === "number" && Number.isFinite(v) && v >= RANGES[key].min && v <= RANGES[key].max) {
      out[key] = Math.floor(v);
    }
  }
  if (typeof r.statusbar === "boolean") out.statusbar = r.statusbar;
  if (typeof r.idleMode === "boolean") out.idleMode = r.idleMode;
  if (typeof r.tokenSaver === "boolean") out.tokenSaver = r.tokenSaver;
  return out;
}
function uiConfigPath(settingsDir) {
  return path.join(settingsDir, USER_UI_FILE);
}
function loadUiConfig(guard, settingsDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(guard.assert(uiConfigPath(settingsDir)), "utf8"));
    return sanitize(raw);
  } catch {
    return {};
  }
}
function saveUiConfig(guard, settingsDir, patch) {
  const merged = sanitize({ ...loadUiConfig(guard, settingsDir), ...patch });
  const file = guard.assert(uiConfigPath(settingsDir));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWriteFileSync(file, JSON.stringify(merged, null, 2) + "\n");
  return merged;
}

// src/rpc.ts
import { spawn } from "child_process";
import fs4 from "fs";
import os from "os";
import path4 from "path";

// src/browse/interests-edit.ts
import fs2 from "fs";
import path2 from "path";
var MAX_INTERESTS = 32;
var MAX_INTEREST_LEN = 60;
var MAX_WINDOWS = 6;
var HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
function userInterestsPath(paths) {
  return path2.join(paths.settingsDir, "interests.json");
}
function factoryInterestsPath(paths) {
  return path2.join(paths.configDir, "interests.json");
}
function readDoc(file) {
  try {
    const raw = JSON.parse(fs2.readFileSync(file, "utf8"));
    if (!Array.isArray(raw.interests)) return null;
    return { ...raw, interests: raw.interests.map(String) };
  } catch {
    return null;
  }
}
function readEffective(paths) {
  return readDoc(userInterestsPath(paths)) ?? readDoc(factoryInterestsPath(paths)) ?? { interests: [] };
}
function ensureUserLayer(guard, paths) {
  const existing = readDoc(userInterestsPath(paths));
  if (existing) return existing;
  const doc = readDoc(factoryInterestsPath(paths)) ?? { interests: [] };
  saveDoc(guard, userInterestsPath(paths), doc);
  return doc;
}
function saveDoc(guard, file, doc) {
  fs2.mkdirSync(path2.dirname(file), { recursive: true });
  fs2.writeFileSync(guard.assert(file), JSON.stringify(doc, null, 2), "utf8");
}
function normalizeInterest(text) {
  return text.trim().replace(/\s+/g, " ");
}
function addInterest(guard, paths, rawText) {
  const text = normalizeInterest(rawText);
  if (!text) return { ok: false, reason: "empty", doc: readEffective(paths) };
  if (text.length > MAX_INTEREST_LEN) {
    return { ok: false, reason: `too-long (max ${MAX_INTEREST_LEN})`, doc: readEffective(paths) };
  }
  const current = readEffective(paths);
  if (current.interests.some((t) => normalizeInterest(t).toLowerCase() === text.toLowerCase())) {
    return { ok: false, reason: "duplicate", doc: current };
  }
  if (current.interests.length >= MAX_INTERESTS) {
    return { ok: false, reason: `cap (${MAX_INTERESTS})`, doc: current };
  }
  const doc = ensureUserLayer(guard, paths);
  doc.interests.push(text);
  saveDoc(guard, userInterestsPath(paths), doc);
  return { ok: true, doc };
}
function removeInterest(guard, paths, rawText) {
  const current = readEffective(paths);
  const text = normalizeInterest(rawText);
  if (!current.interests.some((t) => normalizeInterest(t) === text)) {
    return { ok: false, reason: "not-found", doc: current };
  }
  const doc = ensureUserLayer(guard, paths);
  doc.interests = doc.interests.filter((t) => normalizeInterest(t) !== text);
  saveDoc(guard, userInterestsPath(paths), doc);
  return { ok: true, doc };
}
function parseWindow(w) {
  if (typeof w !== "object" || w === null) return { ok: false, reason: "not-an-object" };
  const { id, start, end } = w;
  if (typeof start !== "string" || !HHMM.test(start)) return { ok: false, reason: `bad start ${JSON.stringify(start)}` };
  if (typeof end !== "string" || !HHMM.test(end)) return { ok: false, reason: `bad end ${JSON.stringify(end)}` };
  if (start >= end) return { ok: false, reason: `start ${start} must be before end ${end}` };
  return { ok: true, window: { id: typeof id === "string" && id ? id : `${start}-${end}`, start, end } };
}
function setWanderWindows(guard, paths, rawWindows) {
  const fail = (reason) => ({ ok: false, reason, doc: readEffective(paths) });
  if (!Array.isArray(rawWindows)) return fail("windows-must-be-array");
  if (rawWindows.length === 0) return fail("at-least-one-window");
  if (rawWindows.length > MAX_WINDOWS) return fail(`cap (${MAX_WINDOWS})`);
  const windows = [];
  for (const raw of rawWindows) {
    const parsed = parseWindow(raw);
    if (!parsed.ok) return fail(parsed.reason);
    windows.push(parsed.window);
  }
  const sorted = [...windows].sort((a, b) => a.start.localeCompare(b.start));
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].start < sorted[i - 1].end) {
      return fail(`windows overlap: ${sorted[i - 1].id} / ${sorted[i].id}`);
    }
  }
  const doc = ensureUserLayer(guard, paths);
  doc._schedule = { ...doc._schedule, windows };
  saveDoc(guard, userInterestsPath(paths), doc);
  return { ok: true, doc };
}

// src/statusbar/time-inject.ts
import fs3 from "fs";
import path3 from "path";
function shouldInjectTime(input) {
  if (input.step !== 1) return false;
  if (!input.originIsInboxSplice) return false;
  if (input.intervalMs <= 0) return false;
  return input.now - input.lastInjectAt >= input.intervalMs;
}
function turnOriginIsInboxSplice(session) {
  const events = sessionEvents(session);
  let splicedIdx = -1;
  let turnEndIdx = -1;
  for (let i = events.length - 1; i >= 0 && (splicedIdx < 0 || turnEndIdx < 0); i--) {
    const t = events[i].type;
    if (t === "agent/inbox/spliced" && splicedIdx < 0) splicedIdx = i;
    else if (t === "turn/end" && turnEndIdx < 0) turnEndIdx = i;
  }
  if (splicedIdx < 0) return false;
  return splicedIdx > turnEndIdx;
}
function formatElapsed(ms) {
  const minutes = Math.max(1, Math.round(ms / 6e4));
  if (minutes < 60) return `${minutes} \u5206\u949F`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} \u5C0F\u65F6` : `${hours} \u5C0F\u65F6 ${rest} \u5206\u949F`;
}
function localFormatter(timeZone) {
  const options = {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "shortOffset"
  };
  if (timeZone !== void 0) return new Intl.DateTimeFormat("zh-CN", { ...options, timeZone });
  return new Intl.DateTimeFormat("zh-CN", options);
}
function renderTimeText(input) {
  let timeLine;
  try {
    const parts = localFormatter(input.timeZone).formatToParts(new Date(input.now));
    const get = (type) => parts.find((p) => p.type === type)?.value ?? "";
    timeLine = `\u5F53\u524D\u672C\u5730\u65F6\u95F4\uFF1A${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}\uFF08${parts.find((p) => p.type === "timeZoneName")?.value ?? ""}\uFF09\u3002`;
  } catch {
    timeLine = `\u5F53\u524D\u672C\u5730\u65F6\u95F4\uFF1A${new Date(input.now).toISOString()}\u3002`;
  }
  const elapsedLine = input.lastMessageTime === void 0 ? "" : `
\u8DDD\u672C\u4F1A\u8BDD\u4E0A\u4E00\u6761\u6D88\u606F\u5DF2\u8FC7\u53BB ${formatElapsed(input.now - input.lastMessageTime)}\u3002`;
  return timeLine + elapsedLine;
}
function lastMessageTime(session) {
  const events = sessionEvents(session);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    const t = e.time;
    if (typeof t === "number" && /user\/message|assistant\/message|tool\/result/.test(e.type)) return t;
  }
  return void 0;
}
function timeInjectStatePath(dataDir) {
  return path3.join(dataDir, "time-inject-state.json");
}
function loadTimeInjectState(guard, dataDir) {
  try {
    const parsed = JSON.parse(fs3.readFileSync(guard.assert(timeInjectStatePath(dataDir)), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
function saveTimeInjectState(guard, dataDir, state) {
  atomicWriteJsonSync(guard.assert(timeInjectStatePath(dataDir)), state);
}
function registerTimeInjection(ctx, guard, dataDir, opts) {
  const state = loadTimeInjectState(guard, dataDir);
  ctx.on("agent/pre-step", async (payload, next) => {
    const decision = await next();
    if (decision.kind === "reject" || payload.signal?.aborted) return decision;
    const sessionId = payload.agent.session.id;
    const now = Date.now();
    const track = payload.step === 1 ? opts.pinTrack(sessionId, payload.agent.session) : void 0;
    const intervalMs = Math.max(0, opts.getTimeInjectMin()) * 6e4;
    if (!shouldInjectTime({
      step: payload.step,
      originIsInboxSplice: payload.step === 1 ? turnOriginIsInboxSplice(payload.agent.session) : false,
      lastInjectAt: state[sessionId] ?? 0,
      now,
      intervalMs
    })) return decision;
    try {
      const { createUserMessage } = await import("@deepseek-ai/dsh-llm");
      let text = renderTimeText({
        now,
        timeZone: opts.timeZone,
        lastMessageTime: lastMessageTime(payload.agent.session)
      });
      if (opts.getStatusLine && track) {
        const statusLine = opts.getStatusLine(payload.agent.session, track);
        if (statusLine) text += `
${statusLine}`;
      }
      const message = createUserMessage({
        content: [{ type: "text", text }],
        // 0.1.7 V4: producer-owned kind (retired generic 'plugin' is refused).
        source: { kind: "heartbeat", plugin: "heartbeat", form: "snapshot", sections: [{ name: "heartbeat-time", text }] }
      });
      state[sessionId] = now;
      saveTimeInjectState(guard, dataDir, state);
      appendAuditLine(opts.paths.logsDir + "/heartbeat.jsonl", {
        event: "time_injected",
        sessionId,
        intervalMin: opts.getTimeInjectMin()
      });
      return { ...decision, messages: [...decision.messages, message] };
    } catch (e) {
      opts.onError(e);
      return decision;
    }
  }, { prepend: true });
}

// src/rpc.ts
var RPC_ROUTE_PATH = "/api/heartbeat";
var DESTRUCTIVE_ENDPOINTS = /* @__PURE__ */ new Set([
  "seeds.delete",
  "migrate.import",
  "bindings.remove",
  "config.set",
  "profile.export",
  "interests.remove"
]);
var ok = (value) => ({ ok: true, value });
var err = (code, message) => ({ ok: false, error: { code, message, details: {} } });
var cachedVersion = null;
function pluginVersion(paths) {
  if (cachedVersion) return cachedVersion;
  try {
    const pkg = JSON.parse(fs4.readFileSync(path4.join(paths.packageRoot, "package.json"), "utf8"));
    cachedVersion = typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    cachedVersion = "unknown";
  }
  return cachedVersion;
}
function seedAuditSink(paths) {
  return (entry) => {
    try {
      appendAuditLine(paths.logsDir + "/heartbeat.jsonl", entry);
    } catch {
    }
  };
}
function auditInterests(paths, action, r, detail) {
  try {
    appendAuditLine(paths.logsDir + "/heartbeat.jsonl", {
      event: `interests_${r.ok ? "edit" : "edit_failed"}`,
      action,
      detail: typeof detail === "string" ? detail.slice(0, 80) : null
    });
  } catch {
  }
}
function loadSessionTitles() {
  const titles = {};
  const take = (id, value) => {
    const t = value;
    const row = t?.rows?.title ?? t?.title;
    if (row && typeof row.val === "string" && row.val && !titles[id]) titles[id] = row.val;
  };
  try {
    const dir = path4.join(os.homedir(), ".dsh", "storages", "session_projcache", "sessions");
    for (const file of fs4.readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      const id = file.slice(0, -".json".length);
      if (!id.startsWith("session-")) continue;
      try {
        const record = JSON.parse(fs4.readFileSync(path4.join(dir, file), "utf8"));
        take(id, record.record);
      } catch {
      }
    }
  } catch {
  }
  try {
    const raw = JSON.parse(fs4.readFileSync(path4.join(os.homedir(), ".dsh", "storages", "session_projcache.json"), "utf8"));
    const walk = (node) => {
      if (!node || typeof node !== "object") return;
      for (const [key, value] of Object.entries(node)) {
        if (key.startsWith("session-") && value && typeof value === "object") {
          take(key, value);
        }
        walk(value);
      }
    };
    walk(raw);
    return titles;
  } catch {
    return titles;
  }
}
function loadVisibleSessionIds(registryFile) {
  try {
    const file = registryFile ?? path4.join(os.homedir(), ".dsh", "storages", "workspace.json");
    const j = JSON.parse(fs4.readFileSync(file, "utf8"));
    const archived = new Set(
      (Array.isArray(j.global?.archivedSessionIds) ? j.global.archivedSessionIds : []).map((s) => String(s))
    );
    const isArchived = (id) => archived.has(id) || archived.has(id.replace(/^session-/, ""));
    const visible = /* @__PURE__ */ new Set();
    for (const ws of Object.values(j.tables?.workspaces ?? {})) {
      const ids = Array.isArray(ws?.sessionIds) ? ws.sessionIds : [];
      for (const raw of ids) {
        const id = String(raw);
        if (!isArchived(id)) visible.add(id);
      }
    }
    return { visible, registryFound: true };
  } catch {
    return { visible: /* @__PURE__ */ new Set(), registryFound: false };
  }
}
function buildEndpoints(deps, isLive) {
  const { guard, paths, policy } = deps;
  return {
    async status() {
      const now = Date.now();
      const sent = readSentState(guard, paths, now);
      const beat = getLastBeat();
      let lastTimeInjectAt = null;
      try {
        const state = loadTimeInjectState(guard, paths.dataDir);
        for (const v of Object.values(state)) {
          if (typeof v === "number" && v > (lastTimeInjectAt ?? 0)) lastTimeInjectAt = v;
        }
      } catch {
      }
      let flags = { statusbarEnabled: true, timeInjectMin: 25, idleMode: false };
      try {
        const { getRuntime: getRuntime2 } = await import("./runtime-W2OWJIHY.js");
        const f = getRuntime2().flags;
        flags = { statusbarEnabled: f.statusbarEnabled(), timeInjectMin: f.timeInjectMin(), idleMode: f.idleMode() };
      } catch {
      }
      return ok({
        now: new Date(now).toISOString(),
        version: pluginVersion(paths),
        intervalMin: policy.heartbeat.intervalMin,
        idleMode: policy.heartbeat.idleMode,
        cap: { used: sent.items.length, max: policy.gate.maxDailySend },
        quiet: inQuietHours(policy, now),
        lastBeat: beat,
        homeSessionId: homeSessionId(guard, paths),
        bindings: loadBindings(guard, paths.settingsDir).bindings.length,
        statusbar: {
          enabled: flags.statusbarEnabled,
          timeInjectMin: flags.timeInjectMin,
          lastStatus: readStatus(guard, paths),
          lastTimeInjectAt: lastTimeInjectAt === null ? null : new Date(lastTimeInjectAt).toISOString()
        }
      });
    },
    "sessions.list"() {
      const root = path4.join(os.homedir(), ".dsh", "sessions");
      const bindings = loadBindings(guard, paths.settingsDir).bindings;
      const home = homeSessionId(guard, paths);
      const titles = loadSessionTitles();
      const { visible, registryFound } = loadVisibleSessionIds();
      const out = [];
      if (fs4.existsSync(root)) {
        for (const slug of fs4.readdirSync(root)) {
          for (const id of fs4.readdirSync(path4.join(root, slug))) {
            if (registryFound && id !== home && !visible.has(id)) continue;
            const binding = bindings.find((b) => b.sessionId === id);
            out.push({
              id,
              title: titles[id] ?? null,
              cwdSlug: slug,
              live: isLive(id),
              home: id === home,
              deliver: binding?.deliver ?? false,
              observe: binding?.observe ?? false
            });
          }
        }
      }
      return ok({ sessions: out });
    },
    "bindings.get": () => ok(loadBindings(guard, paths.settingsDir)),
    "bindings.add"(p) {
      const id = String(p.sessionId ?? "");
      if (!id.startsWith("session-")) return err("bad-request", "sessionId must look like session-...");
      const home = homeSessionId(guard, paths);
      if (id === home) return err("bad-request", "\u8BE5\u4F1A\u8BDD\u662F\u5FC3\u8DF3\u6B63\u8EAB\uFF0C\u65E0\u9700\u7ED1\u5B9A\uFF08\u51B3\u7B56\u8F6E\u6B21\u56FA\u5B9A\u53D1\u751F\u5728\u6B63\u8EAB\uFF09");
      const b = addBinding(guard, paths.settingsDir, id, {
        deliver: p.deliver !== false,
        observe: p.observe === true
      });
      return ok(b);
    },
    "bindings.remove"(p) {
      const id = String(p.sessionId ?? "");
      const removed = removeBinding(guard, paths.settingsDir, id);
      const homeReset = resetHomeSession(guard, paths, id);
      return ok({ removed, homeReset });
    },
    "seeds.list"() {
      const db = loadPool(guard, seedsFilePath(paths.dataDir));
      return ok({
        active: activeSeeds(db),
        archived: archivedSeeds(db),
        cap: policy.seeds.maxActive
      });
    },
    "seeds.archive"(p) {
      const s = archiveSeedById(guard, seedsFilePath(paths.dataDir), String(p.id ?? ""), "completed", Date.now(), seedAuditSink(paths));
      return s ? ok(s) : err("not-found", "active seed not found");
    },
    "seeds.restore"(p) {
      const r = restoreSeed(guard, seedsFilePath(paths.dataDir), policy, String(p.id ?? ""), Date.now(), seedAuditSink(paths));
      return r.ok ? ok(r.seed) : err("restore-failed", r.reason);
    },
    "seeds.delete"(p) {
      return ok({ deleted: deleteSeed(guard, seedsFilePath(paths.dataDir), String(p.id ?? ""), seedAuditSink(paths)) });
    },
    // ── 兴趣范围 / 浏览时段（v1.4.0；首编继承出厂，见 interests-edit.ts）──
    "interests.list": () => ok(readEffective(paths)),
    "interests.add"(p) {
      const r = addInterest(guard, paths, String(p.text ?? ""));
      auditInterests(paths, "add", r, p.text);
      return r.ok ? ok(r.doc) : err("bad-request", r.reason ?? "add failed");
    },
    "interests.remove"(p) {
      const r = removeInterest(guard, paths, String(p.text ?? ""));
      auditInterests(paths, "remove", r, p.text);
      return r.ok ? ok(r.doc) : err("not-found", r.reason ?? "remove failed");
    },
    "interests.setWindows"(p) {
      const r = setWanderWindows(guard, paths, p.windows);
      auditInterests(paths, "set-windows", r, JSON.stringify(p.windows ?? null));
      return r.ok ? ok(r.doc) : err("bad-request", r.reason ?? "setWindows failed");
    },
    "config.get": () => ok(deps.ui.get()),
    "config.set"(p) {
      const patch = p;
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
        return err("bad-request", "config.set needs a patch object");
      }
      const keys = Object.keys(patch).filter(
        (k) => ["intervalMin", "maxDailySend", "timeInjectMin", "statusbar", "idleMode", "tokenSaver", "psyEnabled"].includes(k)
      );
      if (keys.length === 0) return err("bad-request", "config.set has no recognized field");
      try {
        deps.ui.set(patch);
      } catch (e) {
        return err("bad-request", String(e).slice(0, 120));
      }
      appendAuditLine(guard.assert(paths.logsDir + "/heartbeat.jsonl"), { event: "ui_config_set", keys });
      return ok(deps.ui.get());
    },
    "profile.digest"() {
      const d = buildDigest(guard, paths, policy, {});
      return ok({
        tact: d.tact,
        topic: d.topic,
        wander: d.wander,
        withinBudget: d.withinBudget
      });
    },
    "profile.export"() {
      const doc = loadProfile(guard, profileFilePath(paths.dataDir));
      const lines = [`# \u753B\u50CF\u5BFC\u51FA ${(/* @__PURE__ */ new Date()).toISOString()}`, ""];
      for (const part of ["interest", "projects", "comm", "psy"]) {
        lines.push(`## ${part}`);
        for (const e of doc.partitions[part].entries) {
          if (e.validTo !== null) continue;
          lines.push(`- [${e.topic}/${e.subTopic}] ${e.content} (conf ${e.confidence.toFixed(2)}, ${e.temporal})`);
        }
      }
      const out = path4.join(paths.exportsDir, `profile-export-${Date.now()}.md`);
      writeText(guard, out, lines.join("\n") + "\n");
      return ok({ path: out });
    },
    "ledger.open"() {
      const f = ledgerFilePath(paths.dataDir);
      if (!fs4.existsSync(guard.assert(f))) fs4.writeFileSync(f, "# \u8D26\u672C\n", "utf8");
      spawn("cmd", ["/c", "start", "", f], { detached: true, stdio: "ignore" }).unref();
      return ok({ path: f });
    },
    "weekly.list": () => ok({ reports: listWeeklyReports(guard, paths.dataDir) }),
    "weekly.get"(p) {
      const file = String(p.file ?? "");
      const rep = readWeeklyReport(guard, paths.dataDir, file);
      if (!rep) return err("bad-request", `no such report: ${file}`);
      return ok(rep);
    },
    async "migrate.export"(p) {
      const passphrase = String(p.passphrase ?? "");
      if (!passphrase) return err("bad-request", "\u9700\u8981\u8BBE\u7F6E\u53E3\u4EE4");
      const { collectMigrationEntries, encryptContainer } = await import("./migrate-D4VKAKYT.js");
      const { entries } = collectMigrationEntries(guard, paths);
      if (entries.length === 0) return err("bad-request", "\u6CA1\u6709\u53EF\u6253\u5305\u7684\u8BB0\u5FC6\u6587\u4EF6\uFF08data/ \u662F\u7A7A\u7684\uFF09");
      const out = path4.join(paths.exportsDir, `heartbeat-memory-${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}.hbmig`);
      writeText(guard, out, encryptContainer(entries, passphrase));
      appendAuditLine(guard.assert(paths.logsDir + "/heartbeat.jsonl"), { event: "migrate_export", files: entries.length });
      return ok({ path: out, count: entries.length });
    },
    async "migrate.import"(p) {
      const passphrase = String(p.passphrase ?? "");
      const file = String(p.file ?? "");
      if (!passphrase || !file) return err("bad-request", "\u9700\u8981\u5BB9\u5668\u8DEF\u5F84\u4E0E\u53E3\u4EE4");
      const { decryptContainer, applyMigrationEntries } = await import("./migrate-D4VKAKYT.js");
      let text;
      try {
        text = fs4.readFileSync(file, "utf8");
      } catch {
        return err("bad-request", `\u8BFB\u4E0D\u5230\u8FC1\u79FB\u5305\uFF1A${file}`);
      }
      let container;
      try {
        container = decryptContainer(text, passphrase);
      } catch (e) {
        return err("bad-request", String(e instanceof Error ? e.message : e));
      }
      const result = applyMigrationEntries(guard, paths, container.files);
      appendAuditLine(guard.assert(paths.logsDir + "/heartbeat.jsonl"), {
        event: "migrate_import",
        restored: result.restored.length,
        backedUp: result.backedUp.length,
        skipped: result.skipped.length,
        rolledBack: result.rolledBack?.length ?? 0,
        error: result.error ?? null
      });
      return ok(result);
    }
  };
}
function installHeartbeatRpc(ctx, deps) {
  ctx.inject(["connection"], (scoped) => {
    const remoteCtx = scoped;
    const isLive = (sessionId) => {
      try {
        return !!remoteCtx.agents.get(sessionId);
      } catch {
        return false;
      }
    };
    const endpoints = buildEndpoints(deps, isLive);
    const gate = remoteCtx.connection;
    const hostGuarded = typeof gate.admit === "function" || typeof gate.requestRejection === "function";
    if (!hostGuarded) {
      try {
        appendAuditLine(deps.guard.assert(deps.paths.logsDir + "/heartbeat.jsonl"), {
          event: "rpc_host_gate_missing",
          detail: "connection.admit/requestRejection absent; destructive endpoints disabled",
          destructive: [...DESTRUCTIVE_ENDPOINTS]
        });
      } catch {
      }
    }
    const handler = async (endpoint, payload) => {
      const p = payload ?? {};
      const fn = typeof endpoint === "string" ? endpoints[endpoint] : void 0;
      if (!fn) return err("bad-request", `unknown endpoint ${JSON.stringify(endpoint)}`);
      if (!hostGuarded && DESTRUCTIVE_ENDPOINTS.has(endpoint)) {
        return err("forbidden", `host gate unavailable; ${endpoint} is refused (H-41)`);
      }
      try {
        return await fn(p);
      } catch (e) {
        return err("internal", String(e).slice(0, 200));
      }
    };
    remoteCtx.effect(
      () => remoteCtx.connection.fetch.register({
        path: RPC_ROUTE_PATH,
        methods: ["POST"],
        requestBody: "buffered",
        fetch: async (request) => {
          let envelope;
          try {
            envelope = await request.json();
          } catch {
            return new Response("body is not JSON", { status: 400 });
          }
          const rpcId = envelope?.rpcId;
          if (envelope?.type !== "client-request" || typeof rpcId !== "string" || typeof envelope.payload !== "object" || envelope.payload === null) {
            return new Response("invalid envelope", { status: 400 });
          }
          const p = envelope.payload;
          const endpoint = typeof p.endpoint === "string" ? p.endpoint : "(missing endpoint)";
          const result = await handler(endpoint, p);
          return Response.json({ type: "server-response", rpcId, result });
        }
      }),
      "heartbeat: rpc route"
    );
    ctx.logger.info("heartbeat: rpc route ready (%s)", RPC_ROUTE_PATH);
    try {
      appendAuditLine(deps.guard.assert(deps.paths.logsDir + "/heartbeat.jsonl"), { event: "rpc_registered", route: RPC_ROUTE_PATH });
    } catch {
    }
  });
}

// src/statusbar/track.ts
var capabilityCache = /* @__PURE__ */ new Map();
function supportsInHistory(session) {
  const key = session.id;
  const len = sessionEventCount(session);
  const hit = capabilityCache.get(key);
  if (hit && hit.scannedUpTo === len) return hit.supported;
  const from2 = hit && len >= hit.scannedUpTo ? hit.scannedUpTo : 0;
  let supported = false;
  if (from2 !== 0 && hit) supported = hit.supported;
  const readTail = (fromSeq) => {
    if (typeof session.snapshotEvents === "function") {
      try {
        const slice = session.snapshotEvents(fromSeq);
        if (Array.isArray(slice)) return slice;
      } catch {
      }
    }
    return sessionEvents(session).slice(fromSeq);
  };
  for (const e of readTail(from2)) {
    if (e.type === "request/context") {
      supported = e.data?.systemPromptUpdate === "in-history";
    }
  }
  capabilityCache.set(key, { scannedUpTo: len, supported });
  return supported;
}
var SCENE_LABELS = {
  "quiet-hours": "\u9759\u9ED8\u65F6\u6BB5\uFF0C\u4E16\u754C\u7761\u4E86",
  "just-spoke": "\u521A\u53BB\u548C\u4F60\u8BF4\u8FC7\u8BDD",
  wandering: "\u6B63\u5728\u95F2\u901B\u770B\u65B0\u4E1C\u897F",
  busy: "\u770B\u5230\u4F60\u5728\u5FD9\uFF0C\u4E0D\u53BB\u6253\u6270",
  present: "\u5728\u573A\u5F85\u7740",
  away: "\u4F60\u4E0D\u5728\uFF0C\u81EA\u5DF1\u5F85\u7740"
};
function renderStatusText(status, opts) {
  if (!status) return "";
  const label = SCENE_LABELS[status.scene] ?? "\u5728\u573A";
  const note = opts?.withNote === false ? "" : status.note ? `\u2014\u2014${status.note}` : "";
  return `\u5FC3\u8DF3\u6B64\u523B\uFF1A${label}${note}\u3002`;
}
var pinnedTrack = /* @__PURE__ */ new Map();
function pinTrack(sessionId, session) {
  const track = trackFor(session);
  pinnedTrack.set(sessionId, track);
  return track;
}
function pinnedTrackFor(sessionId, session) {
  return pinnedTrack.get(sessionId) ?? trackFor(session);
}
var lastTrack = /* @__PURE__ */ new Map();
function noteTrack(auditFile, sessionId, track) {
  if (lastTrack.get(sessionId) === track) return;
  lastTrack.set(sessionId, track);
  try {
    appendAuditLine(auditFile, { event: "statusbar_track", sessionId, track });
  } catch {
  }
}
function trackFor(session) {
  return supportsInHistory(session) ? "system-prompt" : "pre-step";
}
function registerStatusbarSection(ctx, guard, paths, opts) {
  ctx.inject(["systemPrompt"], (scoped) => {
    const spCtx = scoped;
    const section = spCtx.systemPrompt?.section;
    if (typeof section !== "function") {
      spCtx.logger?.warn("heartbeat: systemPrompt service has no section API, statusbar Track A unavailable");
      return;
    }
    spCtx.effect(() => section.call(spCtx.systemPrompt, {
      name: "heartbeat:status",
      order: 5e3,
      // between the persona prefix (0) and the harness block (10000)
      text: (context) => {
        if (!opts.enabled()) {
          noteTrack(paths.logsDir + "/heartbeat.jsonl", context.agent?.session.id ?? "(none)", "off");
          return "";
        }
        const agent = context.agent;
        if (!agent?.session) return "";
        const track = pinnedTrackFor(agent.session.id, agent.session);
        noteTrack(paths.logsDir + "/heartbeat.jsonl", agent.session.id, track);
        if (track !== "system-prompt") return "";
        return renderStatusText(opts.reader.read(guard, paths), { withNote: false });
      }
    }), "heartbeat: statusbar section");
  });
}

// src/core/preset-definition.ts
function heartbeatPresetDefinition(id = "heartbeat") {
  return {
    id,
    name: "\u5FC3\u8DF3\u6A21\u5F0F",
    description: "\u5FC3\u8DF3 agent \u4E13\u7528\uFF1A\u4EC5 web_search + \u4E0A\u4E0B\u6587\u6298\u53E0\uFF1B\u65E0 shell\u3001\u65E0\u6587\u4EF6\u3001\u65E0\u5B50\u4EE3\u7406\u3002",
    order: 20,
    plugins: [
      {
        id: "compaction",
        name: "cordis:group",
        group: true,
        isolate: { compaction: true, toolResultPruner: true },
        config: [
          { id: "compaction-basic", name: "@deepseek-ai/dsh-compaction-basic" },
          { id: "command-compact", name: "@deepseek-ai/dsh-command-compact" },
          {
            id: "tool-result-pruner",
            name: "@deepseek-ai/dsh-compaction-tool-result-pruner",
            config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 }
          }
        ]
      },
      { id: "tool-web", name: "@deepseek-ai/dsh-tool-web", config: { fetch: false, searchTimeoutMs: 6e4 } }
    ]
  };
}
async function registerHeartbeatPreset(service, id = "heartbeat", enabled = true) {
  if (!enabled) return { action: "skipped-disabled", id };
  const registrar = service;
  if (registrar === void 0 || registrar === null || typeof registrar.register !== "function") {
    return { action: "skipped-no-api", id };
  }
  try {
    await registrar.register(heartbeatPresetDefinition(id));
    return { action: "registered", id };
  } catch (e) {
    return { action: "error", id, detail: String(e).slice(0, 200) };
  }
}

// src/ledger/tool.ts
var MAX_TEXT = 120;
function clean(v) {
  return String(v ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
}
function fmtEntry(e) {
  return `#${e.id} [${e.status}] ${e.date} ${e.text}`;
}
function buildLedgerTool(guard, file) {
  return {
    name: "ledger",
    description: '\u5171\u4EAB\u8D26\u672C\u5DE5\u5177\uFF08\u5FC3\u8DF3\u63D2\u4EF6\u7684\u5F85\u529E\u4E0E\u4E8B\u9879\u8BB0\u5F55\uFF09\u3002\u5F53\u7528\u6237\u63D0\u5230\u8BA1\u5212\u3001\u5F85\u529E\u3001\u627F\u8BFA\u3001\u60F3\u505A\u7684\u4E8B\uFF0C\u6216\u8005\u67D0\u4EF6\u4E8B\u5DF2\u7ECF\u5B8C\u6210\u65F6\uFF0C\u4E3B\u52A8\u8C03\u7528\u672C\u5DE5\u5177\u767B\u8BB0\u6216\u52FE\u6389\u2014\u2014\u4E0D\u9700\u8981\u7B49\u7528\u6237\u660E\u786E\u8BF4"\u8BB0\u4E00\u4E0B"\u3002action=add \u767B\u8BB0\u65B0\u4E8B\u9879\uFF08text \u5FC5\u586B\uFF09\uFF1Baction=list \u67E5\u770B\u5F53\u524D\u672A\u5B8C\u6210\u4E8B\u9879\uFF1Baction=done \u52FE\u6389\u4E00\u6761\uFF08key \u4E3A #id \u6216\u6587\u672C\u5B50\u4E32\uFF09\u3002',
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "list", "done"], description: "add=\u767B\u8BB0\uFF0Clist=\u67E5\u672A\u5B8C\u6210\uFF0Cdone=\u52FE\u6389" },
        text: { type: "string", description: "action=add \u65F6\u5FC5\u586B\uFF1A\u4E8B\u9879\u5185\u5BB9\uFF08\u4E00\u53E5\u8BDD\uFF09" },
        key: { type: "string", description: "action=done \u65F6\u5FC5\u586B\uFF1A#id \u6216\u4E8B\u9879\u6587\u672C\u7684\u552F\u4E00\u5B50\u4E32" }
      },
      required: ["action"],
      additionalProperties: false
    },
    output: {
      schema: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          message: { type: "string" }
        },
        required: ["ok", "message"],
        additionalProperties: false
      },
      render: (_args, value) => {
        const v = value;
        return [{ type: "text", text: String(v.message ?? "") }];
      }
    },
    timeoutMs: 5e3,
    // Ledger writes go through read-modify-write on one file; never parallel.
    isConcurrencySafe: () => false,
    async execute(args) {
      const a = args ?? {};
      const action = String(a.action ?? "");
      if (action === "add") {
        const text = clean(a.text);
        if (!text) return { ok: false, message: "add \u9700\u8981\u975E\u7A7A text" };
        const e = appendEntry(guard, file, text);
        return { ok: true, message: `\u5DF2\u767B\u8BB0 ${fmtEntry(e)}` };
      }
      if (action === "done") {
        const key = clean(a.key);
        if (!key) return { ok: false, message: "done \u9700\u8981 key\uFF08#id \u6216\u6587\u672C\u5B50\u4E32\uFF09" };
        const e = markDone(guard, file, key);
        if (!e) return { ok: false, message: `\u6CA1\u6709\u627E\u5230\u5339\u914D\u300C${key}\u300D\u7684\u672A\u5B8C\u6210\u4E8B\u9879\uFF08\u5148\u7528 list \u67E5\uFF09` };
        return { ok: true, message: `\u5DF2\u5B8C\u6210 ${fmtEntry(e)}` };
      }
      if (action === "list") {
        const items = scanPending(guard, file).map(fmtEntry);
        return { ok: true, message: items.length > 0 ? `\u5F53\u524D\u672A\u5B8C\u6210 ${items.length} \u9879\uFF1A
${items.join("\n")}` : "\u8D26\u672C\u91CC\u6CA1\u6709\u672A\u5B8C\u6210\u4E8B\u9879" };
      }
      const total = readLedger(guard, file).entries.length;
      return { ok: false, message: `\u672A\u77E5 action\uFF0C\u8D26\u672C\u5171 ${total} \u6761` };
    }
  };
}

// src/index.ts
var name = "heartbeat";
var inject = ["agents", "settings"];
var Config = Schema.object({
  /** Override the runtime data dir (workspace guard boundary). Empty = default (<packageRoot>/data). */
  dataDir: Schema.string().default(""),
  /** UI-editable: heartbeat interval in minutes. 0 = use policy file / factory. */
  intervalMin: Schema.number().default(0),
  /** UI-editable: daily expression cap. 0 = use policy file / factory. */
  maxDailySend: Schema.number().default(0),
  /**
   * Agent preset the heartbeat agent joins (`<dshHome>/.agent-presets/<id>/`).
   * Without a preset the agent is a BARE agent: tools/prompt sections resolve
   * against the empty global layer, so it cannot even see `web_search`.
   */
  agentPreset: Schema.string().default("heartbeat"),
  /**
   * Install the bundled preset (see `agentPreset`) into the roster's user root
   * on first run, so setup needs no manual file copy. An existing preset is
   * never overwritten; set false to manage the preset entirely by hand.
   */
  installPreset: Schema.boolean().default(true),
  /** Self-built time injection interval (D20, §17.6). 0 disables injection. */
  timeInjectMin: Schema.number().default(25),
  /** IANA timezone for the injected clock; empty = process zone. */
  timeZone: Schema.string().default(""),
  /** Statusbar master switch (D19). Off = no section/pre-step status; time injection unaffected. */
  statusbar: Schema.boolean().default(true),
  /** v1.6.3 闲着模式：素材池为空时用画像话题兜底主动搭话（默认关）。 */
  idleMode: Schema.boolean().default(false),
  /** v1.7.0 节省 token 模式：用户离开（闲置 ≥30 分钟）或锁屏时整跳暂停（默认关）。 */
  tokenSaver: Schema.boolean().default(false),
  /** v1.8.0 账本工具：向所有日常会话 agent 注册共享账本工具（默认开）。 */
  ledgerTool: Schema.boolean().default(true),
  /** v1.9.0 素材报账工具：投递后由陪伴 agent 主动报账（默认开）。 */
  seedReportTool: Schema.boolean().default(true),
  /** v1.8.0 引擎室追加工具：逗号分隔的全局工具名，存在才加入白名单（bili 压缩工具自动探测，无需手填）。 */
  extraTools: Schema.string().default("")
});
function apply(ctx, config = {}) {
  const paths = initWorkspace(config.dataDir ? { dataDir: config.dataDir } : {});
  const guard = createPathGuard(paths.dataDir);
  let policy = loadPolicy(guard, paths.configDir, paths.settingsDir);
  const ui = loadUiConfig(guard, paths.settingsDir);
  if (ui.intervalMin && ui.intervalMin >= 1) {
    policy = { ...policy, heartbeat: { ...policy.heartbeat, intervalMin: ui.intervalMin } };
  }
  if (ui.maxDailySend && ui.maxDailySend >= 1) {
    policy = { ...policy, gate: { ...policy.gate, maxDailySend: ui.maxDailySend } };
  }
  if (config.intervalMin && config.intervalMin >= 1) {
    policy = { ...policy, heartbeat: { ...policy.heartbeat, intervalMin: config.intervalMin } };
  }
  if (config.maxDailySend && config.maxDailySend >= 1) {
    policy = { ...policy, gate: { ...policy.gate, maxDailySend: config.maxDailySend } };
  }
  const deps = {
    ctx,
    paths,
    guard,
    policy,
    agentPreset: config.agentPreset || "heartbeat",
    extraTools: (config.extraTools ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    presetRegistration: () => presetRegistration ?? Promise.resolve()
  };
  setRuntime({
    paths,
    guard,
    policy,
    flags: {
      statusbarEnabled: () => statusbarEnabledRef,
      timeInjectMin: () => timeInjectMinRef,
      idleMode: () => idleModeRef,
      tokenSaver: () => tokenSaverRef
    }
  });
  let presetRegistration;
  ctx.inject(["agentPresets"], (presetCtx) => {
    const service = presetCtx.agentPresets;
    const presetId = config.agentPreset || "heartbeat";
    const installEnabled = config.installPreset !== false;
    const audit = (entry) => {
      try {
        appendAuditLine(guard.assert(paths.logsDir + "/heartbeat.jsonl"), entry);
      } catch (e) {
        ctx.logger.warn("heartbeat: preset audit failed (%s)", String(e).slice(0, 120));
      }
    };
    presetRegistration = registerHeartbeatPreset(service, presetId, installEnabled).then((result2) => {
      audit({ event: "preset_register", ...result2 });
      if (result2.action === "error") {
        ctx.logger.warn("heartbeat: preset register failed (%s) \u2014 the engine room runs without it", result2.detail ?? "");
      } else if (result2.action === "registered") {
        ctx.logger.info("heartbeat: preset %s registered at runtime", result2.id);
      } else {
        ctx.logger.info("heartbeat: preset registration skipped (%s)", result2.action);
      }
    });
    const root = userPresetRoot(service?.roots);
    const result = installBundledPreset({
      moduleUrl: import.meta.url,
      id: presetId,
      ...root === void 0 ? { rosterKnown: service !== void 0 } : { root },
      enabled: installEnabled
    });
    audit({ event: "preset_install", ...result });
    const line = describeInstall(result);
    if (result.action === "error" || result.action === "skipped-no-root") {
      ctx.logger.warn("heartbeat: %s", line);
    } else {
      ctx.logger.info("heartbeat: %s", line);
    }
  });
  let sectionSource = null;
  let timeInjectMinRef = ui.timeInjectMin ?? (config.timeInjectMin ?? 25);
  let statusbarEnabledRef = ui.statusbar ?? config.statusbar !== false;
  let idleModeRef = ui.idleMode ?? config.idleMode === true;
  let tokenSaverRef = ui.tokenSaver ?? config.tokenSaver === true;
  const applyLiveSettings = (v) => {
    if (v.intervalMin && v.intervalMin >= 1) applyHeartbeatInterval(deps, v.intervalMin);
    if (v.maxDailySend && v.maxDailySend >= 1) getRuntime().policy.gate.maxDailySend = v.maxDailySend;
    if (typeof v.timeInjectMin === "number" && v.timeInjectMin >= 0) timeInjectMinRef = v.timeInjectMin;
    if (typeof v.statusbar === "boolean") statusbarEnabledRef = v.statusbar;
    if (typeof v.idleMode === "boolean") {
      idleModeRef = v.idleMode;
      getRuntime().policy.heartbeat.idleMode = v.idleMode;
    }
    if (typeof v.tokenSaver === "boolean") tokenSaverRef = v.tokenSaver;
  };
  const applySettingsOverrides = () => {
    try {
      const v = sectionSource?.();
      if (!v) return;
      applyLiveSettings(v);
      ctx.logger.info("heartbeat: settings overrides live (interval %s, cap %s, timeInject %s)", v.intervalMin ?? "-", v.maxDailySend ?? "-", v.timeInjectMin ?? "-");
    } catch (e) {
      ctx.logger.warn("heartbeat: settings override failed (%s)", String(e).slice(0, 120));
    }
  };
  void (async () => {
    try {
      const settingsService = ctx.get("settings");
      if (settingsService && typeof settingsService.installSection === "function") {
        settingsService.installSection(ctx, "heartbeat", Config, config, {
          setSource: (current) => {
            sectionSource = current;
          },
          onChange: () => {
            applySettingsOverrides();
          }
        });
        applySettingsOverrides();
        ctx.logger.info("heartbeat: settings section registered (0.1.5 settings service)");
        return;
      }
      if (settingsService && typeof settingsService.describe === "function") {
        sectionSource = () => config;
        applySettingsOverrides();
        ctx.logger.info("heartbeat: config served by the 0.1.7 profile form (edits reload the plugin)");
        return;
      }
      const legacy = await import("@deepseek-ai/dsh-settings");
      if (typeof legacy.installSettingsSection === "function" && typeof legacy.settingsNamespace === "function") {
        legacy.installSettingsSection(ctx, legacy.settingsNamespace("heartbeat"), Config, config, {
          setSource: (current) => {
            sectionSource = current;
          },
          onChange: () => {
            applySettingsOverrides();
          }
        });
        applySettingsOverrides();
        ctx.logger.info("heartbeat: settings section registered (legacy 0.1.1 settings)");
        return;
      }
      ctx.logger.warn("heartbeat: no settings integration found; policy file values only");
    } catch (e) {
      ctx.logger.warn("heartbeat: settings section unavailable (%s)", String(e).slice(0, 120));
    }
  })();
  appendAuditLine(
    guard.assert(paths.logsDir + "/heartbeat.jsonl"),
    { event: "plugin_init", dataDir: paths.dataDir }
  );
  if (paths.relocation) {
    const auditFile = guard.assert(paths.logsDir + "/heartbeat.jsonl");
    if (paths.relocation.action === "relocated") {
      appendAuditLine(auditFile, {
        event: "data_dir_relocated",
        from: paths.relocation.srcDir,
        to: paths.relocation.dstDir,
        files: paths.relocation.files,
        bytes: paths.relocation.bytes,
        warnings: paths.relocation.warnings,
        leftovers: paths.relocation.leftovers
      });
      ctx.logger.info(
        "heartbeat: data dir moved out of the package (%s files, %s bytes)",
        paths.relocation.files,
        paths.relocation.bytes
      );
    } else if (paths.relocation.action === "failed") {
      appendAuditLine(auditFile, {
        event: "data_dir_relocate_failed",
        stage: paths.relocation.stage,
        problems: paths.relocation.problems
      });
      ctx.logger.warn(
        "heartbeat: data dir relocation failed (%s); continuing in the package dir",
        paths.relocation.stage
      );
    }
  }
  const uiGet = () => ({
    intervalMin: getRuntime().policy.heartbeat.intervalMin,
    maxDailySend: getRuntime().policy.gate.maxDailySend,
    timeInjectMin: timeInjectMinRef,
    statusbar: statusbarEnabledRef,
    idleMode: idleModeRef,
    tokenSaver: tokenSaverRef,
    psyEnabled: getRuntime().policy.profile.psyEnabled
  });
  const uiSet = (patch) => {
    if (typeof patch.psyEnabled === "boolean") {
      updateUserPolicy(guard, paths.settingsDir, { profile: { psyEnabled: patch.psyEnabled } });
      getRuntime().policy.profile.psyEnabled = patch.psyEnabled;
    }
    const merged = saveUiConfig(guard, paths.settingsDir, patch);
    applyLiveSettings(merged);
  };
  installHeartbeatRpc(ctx, { paths, guard, policy, ui: { get: uiGet, set: uiSet } });
  const registerGlobalTool = (name2, build) => {
    ctx.inject(["tools"], (scoped) => {
      const audit = (entry) => {
        try {
          appendAuditLine(guard.assert(paths.logsDir + "/heartbeat.jsonl"), entry);
        } catch {
        }
      };
      try {
        const tools = scoped.tools;
        if (!tools || typeof tools.register !== "function") throw new Error("ToolRuntime.register unavailable on this host");
        tools.register(build());
        audit({ event: `${name2}_tool_registered` });
      } catch (e) {
        audit({ event: `${name2}_tool_register_failed`, error: String(e).slice(0, 160) });
      }
    });
  };
  if (config.ledgerTool !== false) {
    registerGlobalTool("ledger", () => buildLedgerTool(guard, ledgerFilePath(paths.dataDir)));
  }
  if (config.seedReportTool !== false) {
    registerGlobalTool("seed_report", () => buildSeedReportTool(guard, reportFilePath(paths.dataDir)));
  }
  startOrchestrator(deps);
  const statusReader = new StatusReader();
  registerStatusbarSection(ctx, guard, paths, {
    enabled: () => statusbarEnabledRef,
    reader: statusReader
  });
  ctx.effect(() => {
    registerTimeInjection(ctx, guard, paths.dataDir, {
      getTimeInjectMin: () => timeInjectMinRef,
      timeZone: config.timeZone || void 0,
      paths,
      logger: ctx.logger,
      onError: (e) => ctx.logger.warn("heartbeat: time injection skipped (%s)", String(e).slice(0, 120)),
      pinTrack: (sessionId, session) => {
        const track = pinTrack(sessionId, session);
        noteTrack(paths.logsDir + "/heartbeat.jsonl", sessionId, track);
        return track;
      },
      getStatusLine: (session, track) => {
        if (!statusbarEnabledRef) {
          noteTrack(paths.logsDir + "/heartbeat.jsonl", session.id, "off");
          return "";
        }
        return track === "pre-step" ? renderStatusText(statusReader.read(guard, paths)) : "";
      }
    });
    return void 0;
  }, "heartbeat: time injection");
  ctx.effect(() => {
    return () => {
      ctx.logger.info("heartbeat: disposed, timers cleaned up");
    };
  }, "heartbeat: lifecycle");
}
export {
  Config,
  apply,
  deepMerge,
  inject,
  name
};
//# sourceMappingURL=index.js.map