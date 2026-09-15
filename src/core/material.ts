// Material delivery (redesign 2026-09-16): the engine room prepares
// a raw material package, and the persona (ambaka, the voice session) decides
// whether/how to say something. All logic here is pure and unit-testable; the
// orchestrator only threads data through.
//
// Material package = three sections (decision 2026-09-16):
//   ① an opening declaration: "this is heartbeat plugin material delivery..."
//   ② the 2-3 materials, each as ONE sentence, no reasons, not sorted
//   ③ a conditional line, ONLY when 2+ of the 3 materials have been used
//     (used >= 1) before: "or you can also say something heartfelt (no material)"
//
// The materials come from the active seed pool (never the archive). Attribution
// (attributionIds) = explicit seed_ids first, containment match fallback.

export interface MaterialInput {
  id: string;
  text: string;
  used: number;
}

/** ① opening declaration (section ① of the package). */
export const PACKAGE_DECLARE =
  '这是心跳插件素材投递,请你根据当前处境判断要不要选一条说';

/** ② each material as ONE sentence (already compressed); no reasons, no order. */
export function materialLines(materials: MaterialInput[]): string[] {
  return materials.map((m) => m.text.trim());
}

/** ③ conditional "heartfelt" option: true only when 2+ of the given materials
 *  have been used (used >= 1) before. threshold = 2 by default. */
export function wantHonestOption(materials: MaterialInput[], threshold = 2): boolean {
  return materials.filter((m) => m.used >= 1).length >= threshold;
}

/**
 * Build the persona-facing material-package prompt (sections ①+②, plus ③ when
 * wantHonestOption). This is what the voice session (ambaka) reads and decides on.
 */
export function buildMaterialPrompt(
  materials: MaterialInput[],
  opts: { threshold?: number } = {},
): string {
  const lines: string[] = [PACKAGE_DECLARE];
  const items = materialLines(materials);
  for (const it of items) lines.push('- ' + it);
  if (wantHonestOption(materials, opts.threshold ?? 2)) {
    lines.push('(或者也可以说一句真心话,不带素材)');
  }
  return lines.join('\n');
}

/**
 * A2 attribution (redesign): explicit seed_ids first, then containment-match
 * fallback against the delivered materials. Only the materials actually present in this
 * package are eligible (never archive-sourced). A candidate is credited when the
 * persona's actual output contains a >=8-char prefix of the material text, or the
 * material contains a >=8-char prefix of the output.
 */
export function attributionIds(
  candidates: MaterialInput[],
  output: string,
  explicitIds: string[] = [],
): string[] {
  const used = new Set(explicitIds);
  const b = output.trim();
  for (const c of candidates) {
    const a = c.text.trim();
    if (a.length >= 8 && (b.includes(a.slice(0, Math.min(20, a.length))) || a.includes(b.slice(0, Math.min(20, b.length))))) {
      used.add(c.id);
    }
  }
  return [...used];
}

/**
 * The engine-room rumination prompt: pick <= max materials from the active
 * candidates and compress each into one sentence; the model still returns the D23 JSON
 * {speak,text,seed_ids} (text = one sentence per line).
 */
export function buildRuminationPrompt(input: {
  digestTact: string;
  digestTopic: string;
  staleLedger: string;
  candidates: string; // "id: text" lines (top N)
  max?: number;
}): string {
  const max = input.max ?? 3;
  const lines = [
    '这是心跳轮次的反刍备料环节:从候选素材里挑(最多 ' + max + ' 条),把每条压缩成一句话。',
    '素材只从下面给的候选里挑,不要自己编;没合适的就少挑,甚至可以不挑。',
    '不要使用任何工具。只输出一个 JSON 对象:',
    '- 有想递的:{"speak":true,"text":"第1条素材\n第2条素材...","seed_ids":["s1","s2"]}',
    '- 一条都不合适:{"speak":false,"seed_ids":[]}',
    '- text = 挑出的素材,每条素材单独一行;seed_ids = 对应的素材 id。',
    '',
    '## 此刻处境', input.digestTact,
    '## 画像话题', input.digestTopic,
    '## 账本待跟进', input.staleLedger || '(空)',
    '## 素材池候选(id: 内容)', input.candidates || '(空)',
  ];
  return lines.join('\n');
}
