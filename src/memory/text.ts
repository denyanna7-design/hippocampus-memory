// Tokenization, stop words, extractive summarization (no API keys needed).
const STOP = new Set(("a an the and or but if then of to in on at for with by from as is are was were be been being it its this that these those i you he she we they me my your our their his her them us do does did have has had not no so too very can will would should could just about into over than also there here what which who whom when where why how all any some more most other such only own same up down out off again further once").split(" "));

export function tokenize(text: string): string[] {
  const out: string[] = [];
  const lower = text.toLowerCase();
  for (const m of lower.matchAll(/[a-z0-9][a-z0-9'-]*|[\u4e00-\u9fff]+/g)) {
    const w = m[0];
    if (/[\u4e00-\u9fff]/.test(w)) {
      // CJK: character bigrams (unigram if single char)
      if (w.length === 1) out.push(w);
      for (let i = 0; i + 1 < w.length; i++) out.push(w.slice(i, i + 2));
    } else {
      const s = stem(w.replace(/'s$/, ""));
      if (s.length > 1 && !STOP.has(w)) out.push(s);
    }
  }
  return out;
}

function stem(w: string): string {
  if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith("ed")) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

export function termFreq(text: string): Record<string, number> {
  const tf: Record<string, number> = {};
  for (const t of tokenize(text)) tf[t] = (tf[t] ?? 0) + 1;
  return tf;
}

export function topTerms(v: Record<string, number>, n: number): Record<string, number> {
  return Object.fromEntries(Object.entries(v).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, n));
}

export function cosine(a: Record<string, number>, b: Record<string, number>): number {
  let dot = 0, na = 0, nb = 0;
  for (const k in a) { na += a[k] ** 2; if (k in b) dot += a[k] * b[k]; }
  for (const k in b) nb += b[k] ** 2;
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export function sentences(text: string): string[] {
  return text.split(/(?<=[.!?。！？])\s*/).map(s => s.trim()).filter(Boolean);
}

/** Deterministic extractive summary: keep highest-scoring sentences (term-frequency centrality), original order. */
export function extractiveSummary(text: string, ratio = 0.4, maxChars = 220): string {
  const ss = sentences(text);
  if (ss.length <= 1) return text.length > maxChars ? text.slice(0, maxChars - 1) + "…" : text;
  const tf = termFreq(text);
  const scored = ss.map((s, i) => {
    const toks = tokenize(s);
    const score = toks.reduce((acc, t) => acc + (tf[t] ?? 0), 0) / Math.sqrt(toks.length || 1);
    return { s, i, score };
  });
  const keep = Math.max(1, Math.round(ss.length * ratio));
  const chosen = [...scored].sort((a, b) => b.score - a.score).slice(0, keep).sort((a, b) => a.i - b.i);
  let out = chosen.map(c => c.s).join(" ");
  if (out.length > maxChars) out = out.slice(0, maxChars - 1) + "…";
  return out;
}
