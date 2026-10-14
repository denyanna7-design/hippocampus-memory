// File layer: per-node blobs, shared chunks, zstd dictionaries, cold archive. Pure storage, no policy.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { codec } from "./codecs.js";

export type Enc =
  | { enc: "plain" }
  | { enc: "z"; codec: string; dict?: string }                 // single-node codec (optionally trained dictionary)
  | { enc: "delta"; base: string; codec: string }              // codec with the base memory's raw bytes as dictionary
  | { enc: "chunks"; chunks: string[] }                        // content-addressed dedup chunks
  | { enc: "resid"; schema: string; keep: number; codec: string; dict?: string } // schema + importance-ordered residual hunks (first `keep` used)
  | { enc: "pack"; pack?: "cool" | "cold"; codec: string; inner: "raw" | "resid"; schema?: string; keep?: number }; // inside a shared tier archive

export const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
export const fileOf = (id: string, e: Enc) => e.enc === "plain" ? `${id}.txt` : e.enc === "z" ? `${id}.z` : e.enc === "delta" ? `${id}.dz` : e.enc === "resid" ? `${id}.r` : null;

export function chunk(raw: Buffer): Buffer[] {
  const s = raw.toString("latin1"); const out: Buffer[] = []; let start = 0;
  for (const m of s.matchAll(/[.!?\n](?=\s)|\n|\u00e3\u0080\u0082/g)) {
    const end = m.index! + m[0].length;
    if (end - start >= 24) { out.push(Buffer.from(s.slice(start, end), "latin1")); start = end; }
  }
  if (start < s.length) out.push(Buffer.from(s.slice(start), "latin1"));
  return out;
}

export class RawStore {
  constructor(readonly dir: string) { for (const d of ["raw", "chunks", "packs", "dicts"]) mkdirSync(join(dir, d), { recursive: true }); }
  p(...x: string[]) { return join(this.dir, ...x); }
  readFile(name: string) { return readFileSync(this.p("raw", name)); }
  writeFile(name: string, b: Buffer) { writeFileSync(this.p("raw", name), b); }
  drop(id: string, e: Enc) { const f = fileOf(id, e); if (f) rmSync(this.p("raw", f), { force: true }); }
  fileSize(id: string, e: Enc) { const f = fileOf(id, e); return f && existsSync(this.p("raw", f)) ? statSync(this.p("raw", f)).size : 0; }

  // chunks
  hasChunk(h: string) { return existsSync(this.p("chunks", `${h}.br`)); }
  writeChunk(h: string, d: Buffer) { writeFileSync(this.p("chunks", `${h}.br`), d); }
  readChunk(h: string) { return codec("brotli-11").decompress(readFileSync(this.p("chunks", `${h}.br`))); }
  chunkSize(h: string) { return this.hasChunk(h) ? statSync(this.p("chunks", `${h}.br`)).size : 0; }
  gcChunks(live: Set<string>) { for (const f of readdirSync(this.p("chunks"))) if (!live.has(f.replace(/\.br$/, ""))) rmSync(this.p("chunks", f)); }

  // dictionaries (immutable, content-addressed)
  writeDict(id: string, d: Buffer) { if (!existsSync(this.p("dicts", `${id}.dict`))) writeFileSync(this.p("dicts", `${id}.dict`), d); }
  readDict(id: string) { return readFileSync(this.p("dicts", `${id}.dict`)); }
  gcDicts(live: Set<string>) { for (const f of readdirSync(this.p("dicts"))) if (!live.has(f.replace(/\.dict$/, ""))) rmSync(this.p("dicts", f)); }

  // shared tier archives (cool, cold): "<codec> <dictId|->\n" + compress("<json index>\n" + payloads)
  private packCache = new Map<string, { codec: string; dict: string | null; entries: Record<string, Buffer> }>();
  packBody(entries: Record<string, Buffer>) {
    const ids = Object.keys(entries).sort(); let off = 0; const idx: [string, number, number][] = [];
    for (const id of ids) { idx.push([id, off, entries[id].length]); off += entries[id].length; }
    return Buffer.concat([Buffer.from(JSON.stringify(idx) + "\n"), ...ids.map(i => entries[i])]);
  }
  pack(name: "cool" | "cold" = "cold"): { codec: string; dict: string | null; entries: Record<string, Buffer> } {
    const hit = this.packCache.get(name); if (hit) return hit;
    const f = this.p("packs", `${name}.pack`);
    if (!existsSync(f)) { const v: { codec: string; dict: string | null; entries: Record<string, Buffer> } = { codec: "none", dict: null, entries: {} }; this.packCache.set(name, v); return v; }
    const b = readFileSync(f); const nl = b.indexOf(10); const [c, d] = b.subarray(0, nl).toString().split(" ");
    const dict = d && d !== "-" ? d : null;
    const body = codec(c).decompress(b.subarray(nl + 1), dict ? this.readDict(dict) : undefined); const n2 = body.indexOf(10);
    const idx = JSON.parse(body.subarray(0, n2).toString()) as [string, number, number][]; const rest = body.subarray(n2 + 1);
    const v = { codec: c, dict, entries: Object.fromEntries(idx.map(([id, o, l]) => [id, Buffer.from(rest.subarray(o, o + l))])) };
    this.packCache.set(name, v); return v;
  }
  writePack(name: "cool" | "cold", codecName: string, dict: string | null, compressed: Buffer | null, entries: Record<string, Buffer>) {
    const f = this.p("packs", `${name}.pack`);
    if (!compressed) rmSync(f, { force: true }); else writeFileSync(f, Buffer.concat([Buffer.from(`${codecName} ${dict ?? "-"}\n`), compressed]));
    this.packCache.set(name, { codec: codecName, dict, entries: { ...entries } });
  }
  packSize(name: "cool" | "cold" = "cold") { const f = this.p("packs", `${name}.pack`); return existsSync(f) ? statSync(f).size : 0; }
  dirBytes(d: string) { const p = this.p(d); return existsSync(p) ? readdirSync(p).reduce((a, f) => a + statSync(join(p, f)).size, 0) : 0; }
}
