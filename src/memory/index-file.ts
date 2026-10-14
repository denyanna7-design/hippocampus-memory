// Compact on-disk index: one file `index.bin` = codec(JSON header + "\n" + binary edge table).
//  - nodes: redundant fields dropped (keywords are recomputed from the vector, default fid/tags/flags omitted,
//    short summaries omitted because they equal the text), vectors quantised to 2 decimals as "term:w" strings,
//    sha256 stored as base64.
//  - edges: node-index pairs + weight quantised to uint8 (1/255), 5 bytes per edge.
//  - whole file compressed with zstd-19 (brotli-11 fallback). Index metadata only; memory CONTENT is untouched.
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { codec, hasZstd } from "./codecs.js";
import { topTerms } from "./text.js";
import type { MemoryNode } from "./engine.js";

export const HASH_HEX = 16; // 64-bit integrity tags
const T0 = 1.7e12;
/** Sparsify the association graph: keep each node's strongest K edges (an edge survives if either end keeps it). */
export const EDGE_TOP_K = 6, EDGE_MIN = 0.08;
const CODEC = hasZstd ? "zstd-19" : "brotli-11";
const q2 = (x: number) => Math.round(x * 100) / 100;
const b64 = (hex?: string) => hex ? Buffer.from(hex, "hex").toString("base64").replace(/=+$/, "") : undefined;
const hex = (b?: string) => b ? Buffer.from(b, "base64").toString("hex") : undefined;

function packNode(n: MemoryNode, derivableVector: boolean): Record<string, unknown> {
  const o: Record<string, unknown> = { ...n };
  delete o.keywords; delete o.members; delete o.summary; // derivable: members from each node's `schema`, summary from text
  if (n.keeps) { const k = n.keeps; o.keeps = [k.cool, k.cold, k.total, k.fidCool.rouge, k.fidCool.char, k.fidCold.rouge, k.fidCold.char]; }
  if (derivableVector) delete o.vector; else o.vector = Object.entries(n.vector).map(([k, w]) => (q2(w) === 1 ? k : `${k}:${q2(w)}`)).join(" ");
  // integrity tag: only the hash that readRaw() verifies is needed (original for lossless, reconstruction for lossy),
  // truncated to 64 bits — ample for corruption/tamper detection of a few-hundred-byte blob.
  delete o.sha256; delete o.reconSha; o.h = b64((n.lossy ? n.reconSha : n.sha256)!.slice(0, HASH_HEX));
  o.createdAt = Math.round((n.createdAt - T0) / 1000); o.lastAccess = Math.round((n.lastAccess - n.createdAt) / 1000);
  if (n.fid.rouge === 1 && n.fid.char === 1) delete o.fid;
  if (!n.tags.length) delete o.tags;
  if (n.kind === "episodic") delete o.kind; if (n.tier === 0) delete o.tier;
  if (!n.lossy) delete o.lossy; if (!n.pinned) delete o.pinned;
  if (n.keeps && n.keeps.total <= 1 && n.keeps.fidCold.rouge === 1) delete o.keeps;
  o.stability = Math.round(n.stability * 1e4) / 1e4;
  if (!o.lastAccess) delete o.lastAccess; if (!n.accessCount) delete o.accessCount;
  return o;
}
function unpackNode(o: Record<string, any>): MemoryNode {
  const vector: Record<string, number> = {}; const k = o.keeps;
  if (Array.isArray(k)) o.keeps = { cool: k[0], cold: k[1], total: k[2], fidCool: { rouge: k[3], char: k[4] }, fidCold: { rouge: k[5], char: k[6] } };
  for (const t of String(o.vector ?? "").split(" ").filter(Boolean)) { const i = t.lastIndexOf(":"); if (i > 0 && !isNaN(+t.slice(i + 1))) vector[t.slice(0, i)] = +t.slice(i + 1); else vector[t] = 1; }
  const n = { ...o, vector, kind: o.kind ?? "episodic", tier: o.tier ?? 0, sha256: o.lossy ? "" : hex(o.h)!, reconSha: o.lossy ? hex(o.h) : undefined, createdAt: o.createdAt * 1000 + T0, fid: o.fid ?? { rouge: 1, char: 1 }, tags: o.tags ?? [],
    lossy: !!o.lossy, lastAccess: o.createdAt * 1000 + T0 + (o.lastAccess ?? 0) * 1000, accessCount: o.accessCount ?? 0 } as MemoryNode;
  n.keywords = Object.keys(topTerms(vector, 6)); if (o.vector === undefined) (n as { vector?: unknown }).vector = undefined; // engine re-derives
  return n;
}

export function writeIndex(file: string, nodes: Map<string, MemoryNode>, edges: Map<string, number>, meta: unknown, derivableVector: (n: MemoryNode) => boolean = () => false) {
  const ids = [...nodes.keys()]; const pos = new Map(ids.map((id, i) => [id, i]));
  const live = sparsify(edges, pos);
  const eb = Buffer.alloc(live.length * 5);
  live.forEach(([k, w], i) => { const [a, b] = k.split("|"); eb.writeUInt16LE(pos.get(a)!, i * 5); eb.writeUInt16LE(pos.get(b)!, i * 5 + 2); eb.writeUInt8(Math.round(Math.min(1, Math.max(0, w)) * 255), i * 5 + 4); });
  const head = Buffer.from(JSON.stringify({ v: 1, meta, nodes: ids.map(id => packNode(nodes.get(id)!, derivableVector(nodes.get(id)!))) }) + "\n");
  const body = codec(CODEC).compress(Buffer.concat([head, eb]));
  writeFileSync(file + ".tmp", Buffer.concat([Buffer.from(CODEC + "\n"), body])); renameSync(file + ".tmp", file);
}
export function readIndex(file: string) {
  if (!existsSync(file)) return null;
  const b = readFileSync(file); const nl = b.indexOf(10);
  const body = codec(b.subarray(0, nl).toString()).decompress(b.subarray(nl + 1)); const n2 = body.indexOf(10);
  const h = JSON.parse(body.subarray(0, n2).toString()); const nodes = (h.nodes as Record<string, unknown>[]).map(unpackNode);
  const eb = body.subarray(n2 + 1); const edges = new Map<string, number>();
  for (let i = 0; i + 5 <= eb.length; i += 5) { const a = nodes[eb.readUInt16LE(i)].id, c = nodes[eb.readUInt16LE(i + 2)].id; edges.set(a < c ? `${a}|${c}` : `${c}|${a}`, eb.readUInt8(i + 4) / 255); }
  return { nodes, edges, meta: h.meta };
}

export function sparsify(edges: Map<string, number>, pos?: Map<string, number>): [string, number][] {
  const per = new Map<string, [string, number][]>();
  for (const e of edges) { if (e[1] < EDGE_MIN) continue; const [a, b] = e[0].split("|"); if (pos && !(pos.has(a) && pos.has(b))) continue; for (const x of [a, b]) { if (!per.has(x)) per.set(x, []); per.get(x)!.push(e); } }
  const keep = new Set<string>(); for (const l of per.values()) l.sort((x, y) => y[1] - x[1]).slice(0, EDGE_TOP_K).forEach(e => keep.add(e[0]));
  return [...edges].filter(([k]) => keep.has(k)).sort(([a], [b]) => (a < b ? -1 : 1));
}
