// Schema + residual encoding (lossy-capable), and fidelity metrics.
export interface Hunk { p: number; d: number; i: string; s: number } // at schema token p, delete d tokens, insert i; s = importance

/** Exhaustive tokenizer: join(tokens) === text. Whitespace runs, single CJK chars, other runs. */
export function xtok(t: string): string[] {
  return t.match(/\s+|[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]|[^\s\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]+/g) ?? [];
}
function lcsTable(a: string[], b: string[]) {
  const n = a.length, m = b.length; const T = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) T[i][j] = a[i] === b[j] ? T[i + 1][j + 1] + 1 : Math.max(T[i + 1][j], T[i][j + 1]);
  return T;
}
/** Token diff of `text` against `schema` → hunks (exact: applying all hunks reproduces text). */
export function diff(schema: string, text: string): Hunk[] {
  const a = xtok(schema), b = xtok(text); const T = lcsTable(a, b); const hunks: Hunk[] = [];
  let i = 0, j = 0, cur: Hunk | null = null;
  const flush = () => { if (cur) { cur.s = importance(cur.i, cur.d); hunks.push(cur); cur = null; } };
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { flush(); i++; j++; }
    else if (j < b.length && (i === a.length || T[i][j + 1] >= T[i + 1][j])) { cur ??= { p: i, d: 0, i: "", s: 0 }; cur.i += b[j++]; }
    else { cur ??= { p: i, d: 0, i: "", s: 0 }; cur.d++; i++; }
  }
  flush();
  return hunks;
}
export function apply(schema: string, hunks: Hunk[]): string {
  const a = xtok(schema); const hs = [...hunks].sort((x, y) => x.p - y.p); let out = "", i = 0;
  for (const h of hs) { while (i < h.p) out += a[i++]; out += h.i; i += h.d; }
  while (i < a.length) out += a[i++];
  return out;
}
/** Detail importance: numbers, names and CJK content weigh more; whitespace-only edits weigh ~0. */
function importance(ins: string, del: number): number {
  let w = 0.3 * del;
  for (const t of xtok(ins)) {
    if (/^\s+$/.test(t)) continue;
    w += /\d/.test(t) ? 3 : /^[A-Z]/.test(t) ? 2 : /[\u4e00-\u9fff]/.test(t) ? 1.5 : 1;
  }
  return w / (Buffer.byteLength(ins) + 6);
}

const content = (t: string) => xtok(t).filter(x => !/^\s+$/.test(x));
/** Surface-token Jaccard. Independent of the stemmed TF vector used for cosine. */
export function tokenOverlap(a: string, b: string): number {
  const A = new Set(content(a)), B = new Set(content(b));
  if (!A.size && !B.size) return 1; if (!A.size || !B.size) return 0;
  let inter = 0; for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}
/** Character-trigram Jaccard. Cheap char overlap for schema membership (compression still uses `charSim`). */
export function charOverlap(a: string, b: string): number {
  const grams = (s: string) => {
    const g = new Set<string>(); const t = s.toLowerCase();
    if (t.length < 3) { if (t) g.add(t); return g; }
    for (let i = 0; i + 3 <= t.length; i++) g.add(t.slice(i, i + 3));
    return g;
  };
  const A = grams(a), B = grams(b);
  if (!A.size && !B.size) return 1; if (!A.size || !B.size) return 0;
  let inter = 0; for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}
/** How much of `text` the schema already reconstructs with no residual hunks. */
export function residualFidelity(schema: string, text: string): number { return rougeL(text, schema); }
/** Second schema signal: token overlap, char overlap, or residual-plan fidelity — whichever is strongest. */
export function schemaSecondScore(schema: string, text: string): number {
  return Math.max(tokenOverlap(schema, text), charOverlap(schema, text), residualFidelity(schema, text));
}
/** ROUGE-L F1 over content tokens. */
export function rougeL(ref: string, hyp: string): number {
  const a = content(ref), b = content(hyp);
  if (!a.length && !b.length) return 1; if (!a.length || !b.length) return 0;
  const l = lcsTable(a, b)[0][0]; const p = l / b.length, r = l / a.length;
  return p + r ? (2 * p * r) / (p + r) : 0;
}
/** Character-level similarity: 1 − Levenshtein / max(len). */
export function charSim(a: string, b: string): number {
  if (a === b) return 1; const n = a.length, m = b.length; if (!n || !m) return 0;
  let prev = new Uint32Array(m + 1).map((_, j) => j), cur = new Uint32Array(m + 1);
  for (let i = 1; i <= n; i++) { cur[0] = i; for (let j = 1; j <= m; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); [prev, cur] = [cur, prev]; }
  return 1 - prev[m] / Math.max(n, m);
}

export interface FloorSpec { rouge: number; char?: number; semantic?: number }
export type Floor = number | FloorSpec;
export interface Fid { rouge: number; char: number; semantic?: number }
function normalizeFloor(f: Floor): { rouge: number; char: number; semantic?: number } {
  if (typeof f === "number") return { rouge: f, char: f }; // a bare tier floor gates ROUGE-L and char similarity together
  return { rouge: f.rouge, char: f.char ?? f.rouge, semantic: f.semantic };
}
/** Order hunks by importance and find how many are needed to clear every fidelity gate.
 *  A keep count is accepted only when ROUGE-L and char similarity both clear the tier floor
 *  (and semantic similarity, when a floor and scorer are given). Dropped hunks revert to the
 *  schema's wording — schema-based "filling in", as in human recall. */
export function plan(schema: string, text: string, floors: Floor[], semantic?: (hyp: string) => number) {
  const all = diff(schema, text).sort((x, y) => y.s - x.s || x.p - y.p);
  const spec = floors.map(normalizeFloor);
  const keeps = spec.map(() => all.length);
  const fidAt: Fid[] = spec.map(() => ({ rouge: 0, char: 0 }));
  const accepted = spec.map(() => false);
  for (let k = 0; k <= all.length && accepted.some(ok => !ok); k++) {
    const hyp = apply(schema, all.slice(0, k));
    const fid: Fid = { rouge: rougeL(text, hyp), char: charSim(text, hyp) };
    if (semantic) fid.semantic = semantic(hyp);
    spec.forEach((f, i) => {
      if (accepted[i]) return;
      const semOk = f.semantic === undefined || (semantic !== undefined && (fid.semantic ?? 0) >= f.semantic);
      if ((fid.rouge >= f.rouge && fid.char >= f.char && semOk) || k === all.length) {
        keeps[i] = k; fidAt[i] = fid; accepted[i] = true;
      }
    });
  }
  return { hunks: all, keeps, fid: fidAt };
}
/** Compact on-disk form: [[p,d,"i"],...] in importance order (score not stored; order is enough). */
export const packHunks = (h: Hunk[]) => Buffer.from(JSON.stringify(h.map(x => x.d ? [x.p, x.d, x.i] : [x.p, x.i])));
export const unpackHunks = (b: Buffer): Hunk[] => (JSON.parse(b.toString()) as (number | string)[][]).map(a => a.length === 2 ? { p: a[0] as number, d: 0, i: a[1] as string, s: 0 } : { p: a[0] as number, d: a[1] as number, i: a[2] as string, s: 0 });
