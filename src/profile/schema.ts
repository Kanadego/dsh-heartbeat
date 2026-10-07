// profile-schema.json loading + ADD validation (r4 B10: temporal tier is an
// ENTRY-level attribute; the schema declares, per sub_topic, the ALLOWED tier
// set and the DEFAULT. Unlisted defaults to 'stable'.)

import fs from 'node:fs';
import path from 'node:path';
import type { Partition, Temporal } from './types.js';

export interface SubTopicDecl {
  allowed?: Temporal[];
  default?: Temporal;
}

export interface ProfileSchema {
  version: number;
  partitions: Partial<Record<Partition, {
    topics: Record<string, { subtopics: Record<string, SubTopicDecl> }>;
  }>>;
}

export interface SchemaLoad {
  /** The schema to use, or undefined when even the factory copy is unusable. */
  schema?: ProfileSchema;
  /** Where the returned schema came from. */
  source: 'user' | 'factory' | 'none';
  /** Set when the chosen schema is not the first choice (H-17 fallback). */
  fallbackReason?: string;
}

/**
 * H-17: three-tier load. This file is user-editable by design, so a broken
 * comma used to throw on every beat — `runConsolidation` aborted before
 * `inboxClear`, the inbox grew forever and the profile froze with no way back.
 * Now: a bad user copy falls back to the factory copy (audited by the caller);
 * an unusable factory copy yields `undefined`, which callers read as "no
 * whitelist" instead of a fatal error.
 */
export function loadProfileSchema(paths: { configDir: string; settingsDir: string }): SchemaLoad {
  const userPath = path.join(paths.settingsDir, 'profile-schema.json');
  const factoryPath = path.join(paths.configDir, 'profile-schema.json');
  const read = (file: string): { schema?: ProfileSchema; error: string } => {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as ProfileSchema;
      if (!raw.partitions) return { error: 'partitions missing' };
      return { schema: raw, error: '' };
    } catch (e) {
      return { error: String(e) };
    }
  };
  const user = fs.existsSync(userPath) ? read(userPath) : null;
  if (user?.schema) return { schema: user.schema, source: 'user' };
  const factory = read(factoryPath);
  if (factory.schema) {
    return user
      ? {
          schema: factory.schema,
          source: 'factory',
          fallbackReason: `user profile-schema.json unusable (${user.error}) — fell back to the factory copy`,
        }
      : { schema: factory.schema, source: 'factory' };
  }
  return {
    source: 'none',
    fallbackReason: `no usable profile-schema.json (user: ${user?.error ?? 'absent'}; factory: ${factory.error})`,
  };
}

export interface SchemaCheck {
  ok: boolean;
  reason?: string;
  temporal: Temporal;
}

/**
 * Validate an ADD against the whitelist and resolve the entry's temporal tier:
 * LLM nominates within the sub_topic's allowed set; missing nomination falls
 * back to the declared default; fully unlisted -> reject (charter boundary).
 */
export function checkAddAgainstSchema(
  schema: ProfileSchema,
  partition: Partition,
  topic: string,
  subTopic: string,
  nominated?: Temporal,
): SchemaCheck {
  const p = schema.partitions[partition];
  if (!p) return { ok: false, reason: `partition not in schema: ${partition}`, temporal: 'stable' };
  const t = p.topics[topic];
  if (!t) return { ok: false, reason: `topic not in schema: ${partition}/${topic}`, temporal: 'stable' };
  const st = t.subtopics[subTopic];
  if (!st) return { ok: false, reason: `sub_topic not in schema: ${partition}/${topic}/${subTopic}`, temporal: 'stable' };
  const allowed: Temporal[] = st.allowed && st.allowed.length > 0 ? st.allowed : ['stable'];
  const def: Temporal = st.default && allowed.includes(st.default) ? st.default : allowed[0]!;
  if (!nominated) return { ok: true, temporal: def };
  if (!allowed.includes(nominated)) {
    return {
      ok: false,
      reason: `temporal "${nominated}" not allowed for ${partition}/${topic}/${subTopic} (allowed: ${allowed.join('|')})`,
      temporal: def,
    };
  }
  return { ok: true, temporal: nominated };
}
