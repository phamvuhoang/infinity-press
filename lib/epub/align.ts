// Automatic bilingual passage alignment. Pure and deterministic: the chunks of two editions of one
// work (ebook_search_chunks, already in reading order) in, chunk pairs out. There is no manual step
// anywhere: a resource this cannot pair simply has no compare.

export type AlignChunk = { id: string; href: string; ordinal: number; length: number };
export type AlignmentPair = { sourceId: string; targetId: string; confidence: number };

// href groups in order of first appearance, which is the resource (spine) order.
function groupByHref(chunks: AlignChunk[]): AlignChunk[][] {
  const groups = new Map<string, AlignChunk[]>();
  for (const chunk of chunks) {
    const group = groups.get(chunk.href);
    if (group) group.push(chunk);
    else groups.set(chunk.href, [chunk]);
  }
  return [...groups.values()];
}

// Each chunk's midpoint as a fraction of its group's total length, so two languages of different
// verbosity line up by relative position.
function midpoints(group: AlignChunk[]): number[] {
  const total = group.reduce((sum, chunk) => sum + chunk.length, 0);
  let before = 0;
  return group.map((chunk, index) => {
    const mid = total > 0 ? (before + chunk.length / 2) / total : (index + 0.5) / group.length;
    before += chunk.length;
    return mid;
  });
}

export function alignChunks(
  source: AlignChunk[],
  target: AlignChunk[],
): { pairs: AlignmentPair[]; coverage: number } {
  const sourceGroups = groupByHref(source);
  const targetGroups = groupByHref(target);
  const pairs: AlignmentPair[] = [];

  for (let g = 0; g < Math.min(sourceGroups.length, targetGroups.length); g += 1) {
    const from = sourceGroups[g];
    const to = targetGroups[g];
    if (from.length === to.length) {
      from.forEach((chunk, index) => pairs.push({ sourceId: chunk.id, targetId: to[index].id, confidence: 1 }));
      continue;
    }
    if (Math.abs(from.length - to.length) > 0.1 * Math.max(from.length, to.length)) continue;
    const toMid = midpoints(to);
    midpoints(from).forEach((mid, index) => {
      // Strict < keeps the earlier target on a tie.
      let best = 0;
      for (let t = 1; t < toMid.length; t += 1) {
        if (Math.abs(toMid[t] - mid) < Math.abs(toMid[best] - mid)) best = t;
      }
      pairs.push({ sourceId: from[index].id, targetId: to[best].id, confidence: 0.6 });
    });
  }

  return { pairs, coverage: source.length > 0 ? pairs.length / source.length : 0 };
}
