/**
 * Split text into ~size-char chunks with `overlap`-char carryover between them.
 * Splits on paragraph boundaries when possible, falling back to hard slicing
 * for oversized paragraphs. Character-based (not token-based) to stay dep-free;
 * size defaults are chosen to sit comfortably under the embed model's limit.
 */
export const chunkText = (text: string, size = 1200, overlap = 200): string[] => {
  const clean = text.trim();
  if (!clean) return [];
  if (clean.length <= size) return [clean];

  const paras = clean
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  let buf = "";
  const flush = () => {
    if (buf.trim()) chunks.push(buf.trim());
    buf = buf.length > overlap ? buf.slice(buf.length - overlap) : "";
  };

  for (const para of paras) {
    if (para.length > size) {
      if (buf.trim()) flush();
      for (let i = 0; i < para.length; i += size - overlap) {
        chunks.push(para.slice(i, i + size));
      }
      buf = "";
      continue;
    }
    if (buf.length + para.length + 2 > size) flush();
    buf += (buf ? "\n\n" : "") + para;
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks;
};
