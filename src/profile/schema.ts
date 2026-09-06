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

export function loadProfileSchema(paths: { configDir: string; settingsDir: string }): ProfileSchema {
  const userPath = path.join(paths.settingsDir, 'profile-schema.json');
  const file = fs.existsSync(userPath) ? userPath : path.join(paths.configDir, 'profile-schema.json');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as ProfileSchema;
    if (!raw.partitions) throw new Error('partitions missing');
    return raw;
  } catch (e) {
    throw new Error(`profile-schema unreadable at ${file}: ${String(e)}`);
  }
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
