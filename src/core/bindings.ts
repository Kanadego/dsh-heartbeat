// Session bindings (design doc D13): binding = ①被心跳观察对话事件（inbox
// 来源）＋ ②主动消息投递目标。Canonical storage: data/settings/bindings.json
// (user layer - survives uninstall/reinstall, D15). Edited via CLI or hand.

import fs from 'node:fs';
import path from 'node:path';
import type { PathGuard } from './path-guard.js';

export interface SessionBinding {
  sessionId: string;
  /** Deliver heartbeat expressions into this session's inbox (live only). */
  deliver: boolean;
  /** Observe this session's new user messages into the profile inbox. */
  observe: boolean;
  addedAt: string;
}

export interface BindingsFile {
  bindings: SessionBinding[];
}

export function bindingsFilePath(settingsDir: string): string {
  return path.join(settingsDir, 'bindings.json');
}

export function loadBindings(guard: PathGuard, settingsDir: string): BindingsFile {
  const file = bindingsFilePath(settingsDir);
  try {
    const raw = JSON.parse(fs.readFileSync(guard.assert(file), 'utf8')) as BindingsFile;
    return { bindings: Array.isArray(raw.bindings) ? raw.bindings : [] };
  } catch {
    return { bindings: [] };
  }
}

export function saveBindings(guard: PathGuard, settingsDir: string, data: BindingsFile): void {
  const file = guard.assert(bindingsFilePath(settingsDir));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

export function addBinding(
  guard: PathGuard,
  settingsDir: string,
  sessionId: string,
  opts: { deliver?: boolean; observe?: boolean } = {},
): SessionBinding {
  const data = loadBindings(guard, settingsDir);
  const existing = data.bindings.find((b) => b.sessionId === sessionId);
  if (existing) {
    existing.deliver = opts.deliver ?? existing.deliver;
    existing.observe = opts.observe ?? existing.observe;
    saveBindings(guard, settingsDir, data);
    return existing;
  }
  const binding: SessionBinding = {
    sessionId,
    deliver: opts.deliver ?? true,
    observe: opts.observe ?? false,
    addedAt: new Date().toISOString(),
  };
  data.bindings.push(binding);
  saveBindings(guard, settingsDir, data);
  return binding;
}

export function removeBinding(guard: PathGuard, settingsDir: string, sessionId: string): boolean {
  const data = loadBindings(guard, settingsDir);
  const before = data.bindings.length;
  data.bindings = data.bindings.filter((b) => b.sessionId !== sessionId);
  if (data.bindings.length === before) return false;
  saveBindings(guard, settingsDir, data);
  return true;
}

export function deliverTargets(data: BindingsFile): SessionBinding[] {
  return data.bindings.filter((b) => b.deliver);
}

export function observeTargets(data: BindingsFile): SessionBinding[] {
  return data.bindings.filter((b) => b.observe);
}
