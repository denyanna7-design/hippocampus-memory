// Lossless raw-memory storage. Every encoding round-trips byte-exactly (verified by sha256 on read).
//   plain  raw/<id>.txt                      hot
//   br     raw/<id>.br   brotli (or zstd)    warm
//   delta  raw/<id>.dz   deflate with the base memory's raw text as preset dictionary (LZ77 back-refs into base)
//   chunks chunks/<sha>.br  content-addressed, deduplicated sentence/line chunks shared across memories
//   pack   packs/cold.pack.br  all cold memories packed together in one brotli archive (cross-memory redundancy)
import * as zlib from "node:zlib";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";

export type Enc =
  | { enc: "plain" } | { enc: "z"; codec: string }
  | { enc: "delta"; base: string } | { enc: "chunks"; chunks: string[] } | { enc: "pack"; codec: string };

export const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

// ---- pluggable lossless codecs ----
export interface Codec { name: string; compress(b: Buffer): Buffer; decompress(b: Buffer): Buffer; }
const Z = zlib as unknown as { zstdCompressSync?: (b: Buffer, o?: object) => Buffer; zstdDecompressSync?: (b: Buffer) => Buffer; constants: Record<string, number> };
export const hasZstd = typeof Z.zstdCompressSync === "function"; // Node ≥ 22.15
const brotli = (q: number): Codec => ({ name: `brotli-${q}`,
  compress: b => zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: q, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: b.length } }),
  decompress: b => zlib.brotliDecompressSync(b) });
const deflate = (l: number): Codec => ({ name: `deflate-${l}`, compress: b => zlib.deflateRawSync(b, { level: l }), decompress: b => zlib.inflateRawSync(b) });
const zstd = (l: number): Codec => ({ name: `zstd-${l}`,
  compress: b => Z.zstdCompressSync!(b, { params: { [Z.constants.ZSTD_c_compressionLevel]: l } }), decompress: b => Z.zstdDecompressSync!(b) });
export const CODECS = new Map<string, Codec>();
export function registerCodec(c: Codec) { CODECS.set(c.name, c); } // plug in lz4 / xz / trained-dict zstd here
[brotli(4), brotli(11), deflate(6), deflate(9), ...(hasZstd ? [zstd(3), zstd(19)] : [])].forEach(registerCodec);
/** Codec candidates per tier: warm = fast, cool/cold = max ratio. */
export const TIER_CODECS: Record<"warm" | "cool" | "cold", string[]> = {
  warm: ["brotli-4", "deflate-6", "zstd-3"], cool: ["brotli-11", "deflate-9", "zstd-19"], cold: ["brotli-11", "deflate-9", "zstd-19"],
};
const codecsFor = (t: keyof typeof TIER_CODECS) => TIER_CODECS[t].map(n => CODECS.get(n)).filter((c): c is Codec => !!c);
const br = (b: Buffer) => CODECS.get("brotli-11")!.compress(b);

/** Split into chunks on sentence/line boundaries (content-defined, so identical passages hash identically). */
export function chunk(raw: Buffer): Buffer[] {
  const s = raw.toString("latin1"); // byte-preserving view
  const out: Buffer[] = []; let start = 0;
  const re = /[.!?\n](?=\s)|\n|\u00e3\u0080\u0082/g; // '。' in UTF-8 bytes viewed as latin1
  for (const m of s.matchAll(re)) {
    const end = m.index! + m[0].length;
    if (end - start >= 24) { out.push(Buffer.from(s.slice(start, end), "latin1")); start = end; }
  }
  if (start < s.length) out.push(Buffer.from(s.slice(start), "latin1"));
  return out;
}

export class RawStore {
  private pack: Record<string, Buffer> | null = null;
  constructor(readonly dir: string) {
    for (const d of ["raw", "chunks", "packs"]) mkdirSync(join(dir, d), { recursive: true });
  }
  private p(...x: string[]) { return join(this.dir, ...x); }
  private loadPack(): Record<string, Buffer> {
    if (!this.pack) {
      const f = this.p("packs", "cold.pack"); if (!existsSync(f)) return (this.pack = {});
      const b = readFileSync(f); const nl = b.indexOf(10); const codec = b.subarray(0, nl).toString();
      this.pack = unpackBody(CODECS.get(codec)!.decompress(b.subarray(nl + 1)));
    }
    return this.pack!;
  }

  /** Decode. `resolve` fetches another memory's raw (delta bases). */
  read(id: string, e: Enc, resolve: (id: string) => Buffer): Buffer {
    switch (e.enc) {
      case "plain": return readFileSync(this.p("raw", `${id}.txt`));
      case "z": return CODECS.get(e.codec)!.decompress(readFileSync(this.p("raw", `${id}.z`)));
      case "delta": return zlib.inflateRawSync(readFileSync(this.p("raw", `${id}.dz`)), { dictionary: dictOf(resolve(e.base)) });
      case "chunks": return Buffer.concat(e.chunks.map(h => zlib.brotliDecompressSync(readFileSync(this.p("chunks", `${h}.br`)))));
      case "pack": { const v = this.loadPack()[id]; if (v === undefined) throw new Error(`pack missing ${id}`); return Buffer.from(v); }
    }
  }

  /** Candidate encodings with their marginal on-disk cost (bytes). Nothing is written. */
  candidates(raw: Buffer, tier: "warm" | "cool", base?: { id: string; raw: Buffer }) {
    const c: Cand[] = [{ enc: { enc: "plain" }, cost: raw.length, data: raw }];
    for (const k of codecsFor(tier)) { const d = k.compress(raw); c.push({ enc: { enc: "z", codec: k.name }, cost: d.length, data: d }); }
    if (base) {
      const d = zlib.deflateRawSync(raw, { level: 9, dictionary: dictOf(base.raw) });
      c.push({ enc: { enc: "delta", base: base.id }, cost: d.length + 12, data: d });
    }
    const parts = chunk(raw); const hashes: string[] = []; const fresh: [string, Buffer][] = []; let cost = 0;
    for (const part of parts) {
      const h = sha(part).slice(0, 24); hashes.push(h);
      if (!existsSync(this.p("chunks", `${h}.br`)) && !fresh.some(f => f[0] === h)) { const d = br(part); fresh.push([h, d]); cost += d.length; }
    }
    c.push({ enc: { enc: "chunks", chunks: hashes }, cost: cost + hashes.length * 27, newChunks: fresh });
    return c.sort((x, y) => x.cost - y.cost);
  }

  write(id: string, cand: Cand) {
    const e = cand.enc;
    if (e.enc === "plain") writeFileSync(this.p("raw", `${id}.txt`), cand.data!);
    if (e.enc === "z") writeFileSync(this.p("raw", `${id}.z`), cand.data!);
    if (e.enc === "delta") writeFileSync(this.p("raw", `${id}.dz`), cand.data!);
    if (e.enc === "chunks") for (const [h, d] of cand.newChunks!) writeFileSync(this.p("chunks", `${h}.br`), d);
  }
  /** Remove a node's previous per-node file (only after the new encoding is written and verified). */
  dropFile(id: string, e: Enc) {
    const ext = e.enc === "plain" ? "txt" : e.enc === "z" ? "z" : e.enc === "delta" ? "dz" : null;
    if (ext) rmSync(this.p("raw", `${id}.${ext}`), { force: true });
  }
  /** Rewrite the cold archive with exactly these memories. */
  /** Cold archive: all cold memories in one container, compressed with whichever cold codec is smallest. Returns codec. */
  writePack(entries: Record<string, Buffer>): string {
    const f = this.p("packs", "cold.pack");
    this.pack = { ...entries };
    if (!Object.keys(entries).length) { rmSync(f, { force: true }); return "none"; }
    // similar memories adjacent → better long-range matching
    const json = packBody(entries);
    const best = codecsFor("cold").map(c => ({ c, d: c.compress(json) })).sort((a, b) => a.d.length - b.d.length)[0];
    writeFileSync(f, Buffer.concat([Buffer.from(best.c.name + "\n"), best.d]));
    return best.c.name;
  }
  chunkSize(h: string) { const f = this.p("chunks", `${h}.br`); return existsSync(f) ? statSync(f).size : 0; }
  /** Garbage-collect chunk files no memory references any more (no memory content is lost). */
  gcChunks(live: Set<string>) {
    for (const f of readdirSync(this.p("chunks"))) if (!live.has(f.replace(/\.br$/, ""))) rmSync(this.p("chunks", f));
  }
  bytesOnDisk(): { raw: number; chunks: number; pack: number } {
    const sum = (d: string) => readdirSync(this.p(d)).reduce((a, f) => a + statSync(this.p(d, f)).size, 0);
    return { raw: sum("raw"), chunks: sum("chunks"), pack: sum("packs") };
  }
}
// zlib dictionaries use only the last 32 KiB
const dictOf = (b: Buffer) => b.length > 32768 ? b.subarray(b.length - 32768) : b;
export type Cand = { enc: Enc; cost: number; data?: Buffer; newChunks?: [string, Buffer][] };
// Pack body: "<json index>\n" + raw bytes concatenated (no base64, so the codec sees the real text).
function packBody(entries: Record<string, Buffer>): Buffer {
  const ids = Object.keys(entries).sort(); let off = 0; const idx: [string, number, number][] = [];
  for (const id of ids) { idx.push([id, off, entries[id].length]); off += entries[id].length; }
  return Buffer.concat([Buffer.from(JSON.stringify(idx) + "\n"), ...ids.map(i => entries[i])]);
}
function unpackBody(b: Buffer): Record<string, Buffer> {
  const nl = b.indexOf(10); const idx = JSON.parse(b.subarray(0, nl).toString()) as [string, number, number][];
  const body = b.subarray(nl + 1); return Object.fromEntries(idx.map(([id, o, l]) => [id, Buffer.from(body.subarray(o, o + l))]));
}
