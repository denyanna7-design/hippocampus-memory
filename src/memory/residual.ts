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

/** Order hunks by importance and find how many are needed to reach each fidelity floor.
 *  Dropped hunks revert to the schema's wording — schema-based "filling in", as in human recall. */
export function plan(schema: string, text: string, floors: number[]) {
  const all = diff(schema, text).sort((x, y) => y.s - x.s || x.p - y.p);
  const keeps = floors.map(f => {
    for (let k = 0; k <= all.length; k++) if (rougeL(text, apply(schema, all.slice(0, k))) >= f) return k;
    return all.length;
  });
  return { hunks: all, keeps, fid: keeps.map(k => { const r = apply(schema, all.slice(0, k)); return { rouge: rougeL(text, r), char: charSim(text, r) }; }) };
}
/** Compact on-disk form: [[p,d,"i"],...] in importance order (score not stored; order is enough). */
export const packHunks = (h: Hunk[]) => Buffer.from(JSON.stringify(h.map(x => x.d ? [x.p, x.d, x.i] : [x.p, x.i])));
export const unpackHunks = (b: Buffer): Hunk[] => (JSON.parse(b.toString()) as (number | string)[][]).map(a => a.length === 2 ? { p: a[0] as number, d: 0, i: a[1] as string, s: 0 } : { p: a[0] as number, d: a[1] as number, i: a[2] as string, s: 0 });
