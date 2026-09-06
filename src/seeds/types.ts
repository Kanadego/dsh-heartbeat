// Material pool ("素材池") types. Charter (axiom 3): this pool is a CACHE,
// not memory - volatile, evictable, burnable; long-term memory only absorbs
// conversation-validated content. Everything here may be destroyed.

export type SeedTag = 'news' | 'fandom' | 'scene' | 'promise';
export type SeedSource = 'chat' | 'screen' | 'browse' | 'hand' | 'profile';
export type SeedRetireReason = 'consumed' | 'expired' | 'cold_bench' | 'pool_cap' | 'completed';

export interface Seed {
  id: string;
  /** Short brief shown to the reflection prompt. */
  text: string;
  /** Merge key (§4.3): same-topic actives collapse into one. */
  topic: string;
  tag: SeedTag;
  source: SeedSource;
  /** 0..1 trust level; handwriting and high-confidence profile sources gain eviction protection. */
  confidence: number;
  /** Eviction protection (§4.2 pool-cap rule): handwritten / high-confidence profile sources. */
  protected: boolean;
  /** Times this seed surfaced in an actual expression. */
  used: number;
  bornAt: string;
  /** bornAt + ttlDays[tag]; archived when passed (rule 2). */
  expiresAt: string;
  lastUsedAt: string | null;
  /** Fresh-evidence watermark: rule 1 spares seeds with evidence newer than last use. */
  lastEvidenceAt: string;
  status: 'active' | 'archived';
  retireReason?: SeedRetireReason;
  retiredAt?: string;
}

export interface SeedDb {
  seq: number;
  seeds: Seed[];
}

export function emptySeedDb(): SeedDb {
  return { seq: 0, seeds: [] };
}

export const SEED_SOURCE_DEFAULT_CONFIDENCE: Record<SeedSource, number> = {
  hand: 1.0,
  profile: 0.7,
  chat: 0.6,
  screen: 0.4,
  browse: 0.4,
};
