// Pluggable lossless codecs + zstd dictionary training. All codecs are synchronous and byte-exact.
import * as zlib from "node:zlib";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
const require = createRequire(import.meta.url);

export interface Codec { name: string; family: string; compress(b: Buffer, dict?: Buffer): Buffer; decompress(b: Buffer, dict?: Buffer): Buffer; dict?: boolean; }
const Z = zlib as unknown as { zstdCompressSync?: (b: Buffer, o?: object) => Buffer; zstdDecompressSync?: (b: Buffer, o?: object) => Buffer; constants: Record<string, number> };
export const hasZstd = typeof Z.zstdCompressSync === "function";

export const CODECS = new Map<string, Codec>();
export function registerCodec(c: Codec) { CODECS.set(c.name, c); }
export function codec(name: string): Codec { const c = CODECS.get(name); if (!c) throw new Error(`codec ${name} unavailable`); return c; }

const brotli = (q: number): Codec => ({ name: `brotli-${q}`, family: "brotli",
  compress: b => zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: q, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: b.length } }),
  decompress: b => zlib.brotliDecompressSync(b) });
const deflate = (l: number): Codec => ({ name: `deflate-${l}`, family: "deflate", dict: true,
  compress: (b, d) => zlib.deflateRawSync(b, { level: l, ...(d ? { dictionary: tail(d) } : {}) }),
  decompress: (b, d) => zlib.inflateRawSync(b, d ? { dictionary: tail(d) } : {}) });
[brotli(5), brotli(11), deflate(9)].forEach(registerCodec);
if (hasZstd) for (const l of [3, 19]) registerCodec({ name: `zstd-${l}`, family: "zstd", dict: true,
  compress: (b, d) => Z.zstdCompressSync!(b, { params: { [Z.constants.ZSTD_c_compressionLevel]: l }, ...(d ? { dictionary: d } : {}) }),
  decompress: (b, d) => Z.zstdDecompressSync!(b, d ? { dictionary: d } : {}) });
try {
  const lz4 = require("lz4-napi") as { compressSync(b: Buffer): Buffer; uncompressSync(b: Buffer): Buffer };
  registerCodec({ name: "lz4", family: "lz4", compress: b => Buffer.from(lz4.compressSync(b)), decompress: b => Buffer.from(lz4.uncompressSync(b)) });
} catch { /* optional */ }
try {
  // LZMA (xz family), pure JS. decompress() yields a string for valid UTF-8, bytes otherwise; sha256 checks guard exactness.
  const L = require("lzma") as { compress(b: Buffer | number[], mode: number): number[]; decompress(b: Buffer | number[]): string | number[] };
  for (const m of [6, 9]) registerCodec({ name: `lzma-${m}`, family: "xz/lzma",
    compress: b => Buffer.from(Int8Array.from(L.compress(b, m)).buffer),
    decompress: b => { const r = L.decompress(b); return typeof r === "string" ? Buffer.from(r, "utf8") : Buffer.from(Int8Array.from(r).buffer); } });
} catch { /* optional */ }

/** Candidate codecs per tier (missing codecs are skipped). */
export const TIER_CODECS = {
  hot: ["lz4"],
  warm: ["zstd-3", "brotli-5", "lz4"],
  cool: ["zstd-19", "brotli-11", "lzma-9", "deflate-9"],
  cold: ["lzma-9", "zstd-19", "brotli-11"],
} as const;
export const codecsFor = (t: keyof typeof TIER_CODECS) => TIER_CODECS[t].map(n => CODECS.get(n)).filter((c): c is Codec => !!c);

/** Train a raw-content zstd dictionary: substrings (sentence chunks + word 4-grams) that recur across memories,
 *  scored by frequency × length, most valuable placed last (zstd favours recent dictionary bytes). */
export function trainDictionary(samples: string[], maxBytes = 16384): Buffer | null {
  if (samples.length < 6) return null;
  const df = new Map<string, number>();
  for (const s of samples) {
    const seen = new Set<string>();
    for (const sent of s.split(/(?<=[.!?。！？\n])\s*/)) if (sent.length >= 12) seen.add(sent);
    const w = s.split(/\s+/);
    for (let i = 0; i + 4 <= w.length; i++) seen.add(w.slice(i, i + 4).join(" ") + " ");
    for (const g of seen) df.set(g, (df.get(g) ?? 0) + 1);
  }
  const scored = [...df].filter(([, f]) => f >= 2).map(([g, f]) => ({ g, v: (f - 1) * g.length })).sort((a, b) => b.v - a.v);
  const picked: string[] = []; let size = 0;
  for (const { g } of scored) {
    if (picked.some(p => p.includes(g))) continue;
    if (size + g.length > maxBytes) break;
    picked.push(g); size += Buffer.byteLength(g);
  }
  return picked.length ? Buffer.from(picked.reverse().join("")) : null;
}
export const dictId = (d: Buffer) => createHash("sha256").update(d).digest("hex").slice(0, 12);
const tail = (b: Buffer) => b.length > 32768 ? b.subarray(b.length - 32768) : b;
export function versions() {
  const pkg = (n: string) => { try { return JSON.parse(readFileSync(join(dirname(require.resolve(n)), "package.json"), "utf8")).version as string; } catch { try { return require(`${n}/package.json`).version as string; } catch { return "n/a"; } } };
  return { node: process.version, zstd: hasZstd ? (process.versions as Record<string, string>).zstd ?? "bundled" : "n/a",
    brotli: (process.versions as Record<string, string>).brotli, zlib: process.versions.zlib, "lz4-napi": pkg("lz4-napi"), lzma: pkg("lzma"), codecs: [...CODECS.keys()] };
}
