// Brain-inspired memory engine.
//  • memories are files; recall is spreading activation over a weighted association graph
//  • decay lowers retrieval strength and moves raw content to colder *lossless* storage tiers:
//      L0 hot (plain) → L1 warm (brotli/zstd) → L2 cool (best of brotli | delta vs similar memory | dedup chunks) → L3 cold (packed archive)
//  • summaries/keywords are added as index layers; raw bytes are ALWAYS recoverable exactly (sha256-verified)
//  • nothing is deleted: when over budget and no lossless saving is left, an alert asks the user to decide
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { cosine, topTerms } from "./text.js";
import { Embedder, Summarizer, localEmbedder, extractiveSummarizer } from "./providers.js";
import { RawStore, Enc, sha } from "./rawstore.js";

export type Tier = 0 | 1 | 2 | 3;
export const TIER_NAMES = ["hot", "warm", "cool", "cold"] as const;
export interface MemoryNode {
  id: string;
  kind: "episodic" | "semantic";
  tier: Tier;
  enc: Enc;               // how raw bytes are stored (lossless)
  sha256: string;         // of raw bytes, verified on every read
  rawBytes: number;
  summary?: string;       // index layer (added from L1)
  keywords: string[];     // index layer
  vector: Record<string, number>;
  salience: number;
  stability: number;      // S (days)
  createdAt: number; lastAccess: number; accessCount: number;
  tags: string[];
  sources?: string[];
  consolidated?: boolean;
}
export interface RecallHit { id: string; activation: number; tier: Tier; storage: string; retention: number; text: string; summary?: string; via: "cue" | "spread"; }
export interface BudgetAlert { level: "over_budget"; message: string; totalBytes: number; budgetBytes: number; at: number; }

export const DAY = 86_400_000;
export const P = {
  baseStability: 1,
  tierRetention: [0.6, 0.35, 0.15] as const,
  hopDecay: 0.7, hops: 2, threshold: 0.1, minCueSim: 0.05,
  hebbRate: 0.2, linkSim: 0.15, temporalLink: 0.25, mergeSim: 0.55, spacingGain: 1.5,
};

export function retention(n: Pick<MemoryNode, "stability" | "lastAccess">, now: number): number {
  return 1 / (1 + Math.max(0, now - n.lastAccess) / DAY / (9 * n.stability));
}
export function tierFor(r: number): Tier {
  const [a, b, c] = P.tierRetention;
  return r >= a ? 0 : r >= b ? 1 : r >= c ? 2 : 3;
}

export interface EngineOpts { dir: string; now?: () => number; embedder?: Embedder; summarizer?: Summarizer; budgetBytes?: number; log?: (m: string) => void; }
type Listener = (ev: { type: string; [k: string]: unknown }) => void;

export class MemoryEngine {
  readonly dir: string; now: () => number;
  embedder: Embedder; summarizer: Summarizer; budgetBytes: number;
  store: RawStore;
  nodes = new Map<string, MemoryNode>();
  edges = new Map<string, number>();
  meta: { lastSleep: number; lastId: string; alert: BudgetAlert | null } = { lastSleep: 0, lastId: "", alert: null };
  private listeners: Listener[] = [];
  private log: (m: string) => void;

  constructor(o: EngineOpts) {
    this.dir = o.dir; this.now = o.now ?? Date.now;
    this.embedder = o.embedder ?? localEmbedder; this.summarizer = o.summarizer ?? extractiveSummarizer;
    this.budgetBytes = o.budgetBytes ?? Number(process.env.MEMORY_BUDGET_BYTES ?? Infinity);
    this.log = o.log ?? (m => console.warn(m));
    mkdirSync(join(this.dir, "nodes"), { recursive: true });
    this.store = new RawStore(this.dir);
    for (const f of readdirSync(join(this.dir, "nodes"))) if (f.endsWith(".json")) {
      const n = JSON.parse(readFileSync(join(this.dir, "nodes", f), "utf8")) as MemoryNode; this.nodes.set(n.id, n);
    }
    const ef = join(this.dir, "edges.json"); if (existsSync(ef)) this.edges = new Map(Object.entries(JSON.parse(readFileSync(ef, "utf8"))));
    const mf = join(this.dir, "meta.json"); if (existsSync(mf)) this.meta = { ...this.meta, ...JSON.parse(readFileSync(mf, "utf8")) };
  }
  on(l: Listener) { this.listeners.push(l); return () => { this.listeners = this.listeners.filter(x => x !== l); }; }
  private emit(ev: { type: string; [k: string]: unknown }) { for (const l of this.listeners) l(ev); }

  private saveNode(n: MemoryNode) { writeFileSync(join(this.dir, "nodes", `${n.id}.json`), JSON.stringify(n)); }
  private saveGraph() {
    writeFileSync(join(this.dir, "edges.json"), JSON.stringify(Object.fromEntries(this.edges)));
    writeFileSync(join(this.dir, "meta.json"), JSON.stringify(this.meta));
  }
  private key(a: string, b: string) { return a < b ? `${a}|${b}` : `${b}|${a}`; }
  weight(a: string, b: string) { return this.edges.get(this.key(a, b)) ?? 0; }
  setWeight(a: string, b: string, w: number) { if (a !== b) this.edges.set(this.key(a, b), Math.min(1, Math.max(0, w))); }
  neighbors(id: string): [string, number][] {
    const out: [string, number][] = [];
    for (const [k, w] of this.edges) { const [a, b] = k.split("|"); if (a === id) out.push([b, w]); else if (b === id) out.push([a, w]); }
    return out;
  }

  // ---------- raw content (lossless) ----------
  readRaw(n: MemoryNode): Buffer {
    const b = this.store.read(n.id, n.enc, id => this.readRaw(this.nodes.get(id)!));
    if (sha(b) !== n.sha256) throw new Error(`integrity check failed for ${n.id}`);
    return b;
  }
  text(id: string): string { return this.readRaw(this.nodes.get(id)!).toString("utf8"); }
  private dependents(id: string) { return [...this.nodes.values()].filter(m => m.enc.enc === "delta" && m.enc.base === id); }

  /** Re-encode a node's raw bytes for a tier. Writes new encoding, verifies, then removes the old file. */
  async setTier(n: MemoryNode, target: Tier, opts: { repack?: boolean } = {}): Promise<boolean> {
    if (target === n.tier) return false;
    const raw = this.readRaw(n); const old = n.enc; const from = n.tier;
    if (target >= 1 && !n.summary) n.summary = await this.summarizer.summarize(raw.toString("utf8")); // index layer
    n.tier = target;
    if (target === 3) { if (opts.repack !== false) this.repack(); }
    else {
      // hot: none (fastest). warm: fast codecs + chunk dedup + delta. cool: max codecs + dedup + delta. Smallest wins.
      const best = target === 0 ? { enc: { enc: "plain" } as Enc, cost: raw.length, data: raw }
        : this.store.candidates(raw, target === 1 ? "warm" : "cool", this.deltaBase(n))[0];
      this.store.write(n.id, best);
      n.enc = best.enc;
      if (sha(this.readRaw(n)) !== n.sha256) throw new Error("verify failed");
      if (old.enc !== best.enc.enc) this.store.dropFile(n.id, old);
      if (old.enc === "pack" && opts.repack !== false) this.repack();
      if (old.enc === "chunks" || best.enc.enc === "chunks") this.gcChunks();
    }
    this.saveNode(n);
    this.emit({ type: "tier", id: n.id, from, to: target, enc: n.enc.enc });
    return true;
  }
  /** Most similar memory usable as delta dictionary: not itself a delta, and n must have no dependents (keeps chains depth 1, no cycles). */
  private deltaBase(n: MemoryNode): { id: string; raw: Buffer } | undefined {
    if (this.dependents(n.id).length) return undefined;
    let best: MemoryNode | undefined, bs = 0.2;
    for (const m of this.nodes.values()) {
      if (m === n || m.enc.enc === "delta") continue;
      const s = cosine(n.vector, m.vector); if (s > bs) { bs = s; best = m; }
    }
    return best && { id: best.id, raw: this.readRaw(best) };
  }
  /** Rewrite the cold archive to contain exactly the L3 memories. */
  repack() {
    const cold = [...this.nodes.values()].filter(n => n.tier === 3);
    const entries: Record<string, Buffer> = {};
    for (const n of cold) entries[n.id] = this.readRaw(n);
    const codec = this.store.writePack(entries);
    for (const n of cold) {
      if (n.enc.enc !== "pack" || n.enc.codec !== codec) { const old = n.enc; n.enc = { enc: "pack", codec }; this.store.dropFile(n.id, old); this.saveNode(n); }
      if (sha(this.readRaw(n)) !== n.sha256) throw new Error("pack verify failed");
    }
    this.gcChunks();
  }
  private gcChunks() {
    const live = new Set<string>();
    for (const n of this.nodes.values()) if (n.enc.enc === "chunks") n.enc.chunks.forEach(h => live.add(h));
    this.store.gcChunks(live);
  }

  // ---------- encode ----------
  async remember(text: string, salience = 0.3, tags: string[] = [], kind: "episodic" | "semantic" = "episodic", extra: Partial<MemoryNode> = {}): Promise<MemoryNode> {
    const now = this.now(); const raw = Buffer.from(text, "utf8");
    const vector = await this.embedder.embed(text + " " + tags.join(" "));
    const s = Math.min(1, Math.max(0, salience));
    const n: MemoryNode = {
      id: randomUUID().slice(0, 8), kind, tier: 0, enc: { enc: "plain" }, sha256: sha(raw), rawBytes: raw.length,
      keywords: Object.keys(topTerms(vector, 6)), vector, salience: s, stability: P.baseStability * (1 + 3 * s),
      createdAt: now, lastAccess: now, accessCount: 0, tags, ...extra,
    };
    this.store.write(n.id, { enc: { enc: "plain" }, cost: raw.length, data: raw });
    if (kind === "episodic") {
      for (const m of this.nodes.values()) { const c = cosine(vector, m.vector); if (c >= P.linkSim) this.setWeight(n.id, m.id, c); }
      if (this.meta.lastId && this.nodes.has(this.meta.lastId)) this.setWeight(n.id, this.meta.lastId, Math.max(this.weight(n.id, this.meta.lastId), P.temporalLink));
      this.meta.lastId = n.id;
    }
    this.nodes.set(n.id, n); this.saveNode(n); this.saveGraph();
    this.emit({ type: "remember", id: n.id });
    await this.enforceBudget();
    return n;
  }

  // ---------- recall ----------
  async recall(cue: string, k = 5): Promise<RecallHit[]> {
    const now = this.now(); const cv = await this.embedder.embed(cue);
    const act = new Map<string, number>(); const via = new Map<string, "cue" | "spread">();
    for (const n of this.nodes.values()) {
      const s = cosine(cv, n.vector);
      if (s >= P.minCueSim) { act.set(n.id, s * (0.5 + 0.5 * retention(n, now))); via.set(n.id, "cue"); }
    }
    const amax = Math.max(0.5, ...act.values());
    for (const [i, a] of act) act.set(i, a / amax);
    let frontier = new Map(act);
    for (let h = 0; h < P.hops; h++) {
      const next = new Map<string, number>();
      for (const [i, a] of frontier) for (const [j, w] of this.neighbors(i)) {
        const add = a * w * P.hopDecay; if (add >= 0.01) next.set(j, (next.get(j) ?? 0) + add);
      }
      for (const [j, add] of next) { act.set(j, Math.min(1, (act.get(j) ?? 0) + add)); if (!via.has(j)) via.set(j, "spread"); }
      frontier = next;
    }
    const winners = [...act].filter(([, a]) => a >= P.threshold).sort((a, b) => b[1] - a[1]).slice(0, k);
    this.emit({ type: "recall", cue, activation: Object.fromEntries(act), winners: winners.map(w => w[0]) });
    const hits: RecallHit[] = [];
    for (const [id, a] of winners) {
      const n = this.nodes.get(id)!; const r = retention(n, now);
      n.stability += n.stability * P.spacingGain * (1 - r) * (1 + n.salience) * a + 0.1;
      n.lastAccess = now; n.accessCount++;
      const text = this.readRaw(n).toString("utf8"); // always exact original
      hits.push({ id, activation: round(a), tier: n.tier, storage: `${TIER_NAMES[n.tier]}/${n.enc.enc}`, retention: round(r), text, summary: n.summary, via: via.get(id)! });
      if (n.tier > 1) await this.setTier(n, 1); // reconsolidation: recalled memories warm up
      else this.saveNode(n);
    }
    for (let x = 0; x < winners.length; x++) for (let y = x + 1; y < winners.length; y++) {
      const [i, ai] = winners[x], [j, aj] = winners[y];
      const w = this.weight(i, j); this.setWeight(i, j, w + P.hebbRate * ai * aj * (1 - w));
    }
    this.saveGraph();
    await this.enforceBudget();
    return hits;
  }

  // ---------- decay: only colder, never lossy ----------
  async decayAll(): Promise<{ id: string; from: Tier; to: Tier }[]> {
    const now = this.now(); const changes: { id: string; from: Tier; to: Tier }[] = []; let cold = false;
    for (const n of this.nodes.values()) {
      const to = tierFor(retention(n, now));
      if (to > n.tier) { const from = n.tier; await this.setTier(n, to, { repack: false }); changes.push({ id: n.id, from, to }); if (to === 3) cold = true; }
    }
    if (cold) this.repack();
    await this.enforceBudget();
    return changes;
  }

  /** Over budget → push weakest memories to colder lossless tiers; if still over, raise an alert. Never deletes. */
  async enforceBudget(): Promise<BudgetAlert | null> {
    if (!Number.isFinite(this.budgetBytes)) return null;
    if (this.totalBytes() > this.budgetBytes) {
      const now = this.now();
      const order = [...this.nodes.values()].filter(n => n.tier < 3).sort((a, b) => retention(a, now) - retention(b, now));
      for (const target of [2, 3] as const) for (const n of order) {
        if (this.totalBytes() <= this.budgetBytes) break;
        if (n.tier < target) await this.setTier(n, target);
      }
    }
    const total = this.totalBytes();
    if (total > this.budgetBytes) {
      const alert: BudgetAlert = { level: "over_budget", totalBytes: total, budgetBytes: this.budgetBytes, at: this.now(),
        message: `Memory store is ${total} B, over the ${this.budgetBytes} B budget, and no further lossless compression is possible. Nothing was deleted. Please decide: raise MEMORY_BUDGET_BYTES, export/archive memories elsewhere, or explicitly approve deleting specific memories.` };
      if (!this.meta.alert) this.log(`[memory] ALERT ${alert.message}`);
      this.meta.alert = alert; this.emit({ type: "alert", alert });
    } else this.meta.alert = null;
    this.saveGraph();
    return this.meta.alert;
  }

  // ---------- sleep ----------
  async sleep() {
    const recent = [...this.nodes.values()].filter(n => n.kind === "episodic" && !n.consolidated);
    const used = new Set<string>(); const created: string[] = [];
    for (const a of recent) {
      if (used.has(a.id)) continue;
      const cluster = [a, ...recent.filter(b => b !== a && !used.has(b.id) && cosine(a.vector, b.vector) >= P.mergeSim)];
      for (const x of cluster) for (const y of cluster) if (x.id < y.id) this.setWeight(x.id, y.id, this.weight(x.id, y.id) + 0.1);
      if (cluster.length < 2) continue;
      cluster.forEach(c => used.add(c.id));
      const joined = cluster.map(c => this.text(c.id)).join(" ");
      const sem = await this.remember(await this.summarizer.summarize(joined), Math.max(...cluster.map(c => c.salience)), ["semantic"], "semantic",
        { sources: cluster.map(c => c.id), stability: P.baseStability * 4 * cluster.length });
      created.push(sem.id);
      for (const c of cluster) this.setWeight(sem.id, c.id, 0.8);
    }
    for (const n of recent) { n.consolidated = true; this.saveNode(n); } // episodes are kept, never replaced
    for (const [k, w] of this.edges) this.edges.set(k, Math.max(0.05, w * 0.95)); // homeostasis: weaken, never prune
    const compressed = await this.decayAll();
    this.meta.lastSleep = this.now(); this.saveGraph(); this.emit({ type: "sleep" });
    return { replayed: recent.length, semanticCreated: created, compressed, alert: this.meta.alert };
  }

  // ---------- introspection ----------
  async inspect(id: string) {
    const n = this.nodes.get(id); if (!n) return null;
    const now = this.now();
    const preview = P.tierRetention.map((x, i) => ({ tier: `${i + 1} (${TIER_NAMES[i + 1]})`, inDays: round(Math.max(0, 9 * n.stability * (1 / x - 1) - (now - n.lastAccess) / DAY)) }));
    return { node: { ...n, vector: undefined }, retention: round(retention(n, now)), storage: `${TIER_NAMES[n.tier]}/${n.enc.enc}`, text: this.text(id), neighbors: this.neighbors(id), coldTierPreview: preview, note: "Decay never deletes; it only moves raw bytes to colder lossless storage." };
  }
  private dirBytes(d: string) { const p = join(this.dir, d); return existsSync(p) ? readdirSync(p).reduce((a, f) => a + statSync(join(p, f)).size, 0) : 0; }
  totalBytes() {
    const s = this.store.bytesOnDisk(); const f = (x: string) => existsSync(join(this.dir, x)) ? statSync(join(this.dir, x)).size : 0;
    return s.raw + s.chunks + s.pack + this.dirBytes("nodes") + f("edges.json") + f("meta.json");
  }
  stats() {
    const now = this.now(); const tiers = [0, 0, 0, 0]; const encs: Record<string, number> = {}; let raw = 0, rs = 0;
    for (const n of this.nodes.values()) { tiers[n.tier]++; encs[n.enc.enc] = (encs[n.enc.enc] ?? 0) + 1; raw += n.rawBytes; rs += retention(n, now); }
    const s = this.store.bytesOnDisk(); const stored = s.raw + s.chunks + s.pack; const total = this.totalBytes();
    return {
      nodes: this.nodes.size, edges: this.edges.size,
      tiers: { hot: tiers[0], warm: tiers[1], cool: tiers[2], cold: tiers[3] }, encodings: encs,
      rawBytes: raw, rawStorageBytes: stored, compressionRatio: stored ? round(raw / stored) : 1, bytesSaved: raw - stored,
      indexBytes: total - stored, totalBytes: total, budgetBytes: Number.isFinite(this.budgetBytes) ? this.budgetBytes : null,
      perTier: this.perTier(),
      overBudget: !!this.meta.alert, alert: this.meta.alert, lossless: true,
      meanRetention: this.nodes.size ? round(rs / this.nodes.size) : 0, embedder: this.embedder.name, summarizer: this.summarizer.name,
    };
  }
  /** Raw vs attributed stored bytes per tier (shared chunks split by refcount, pack split by raw share). */
  perTier() {
    const refs = new Map<string, number>();
    for (const n of this.nodes.values()) if (n.enc.enc === "chunks") for (const h of n.enc.chunks) refs.set(h, (refs.get(h) ?? 0) + 1);
    const packRaw = [...this.nodes.values()].filter(n => n.enc.enc === "pack").reduce((a, n) => a + n.rawBytes, 0);
    const packBytes = this.store.bytesOnDisk().pack;
    const f = (x: string) => existsSync(join(this.dir, "raw", x)) ? statSync(join(this.dir, "raw", x)).size : 0;
    const out: Record<string, { nodes: number; rawBytes: number; storedBytes: number; ratio: number; algorithms: Record<string, number> }> = {};
    for (const t of TIER_NAMES) out[t] = { nodes: 0, rawBytes: 0, storedBytes: 0, ratio: 0, algorithms: {} };
    for (const n of this.nodes.values()) {
      const e = n.enc; const o = out[TIER_NAMES[n.tier]];
      const stored = e.enc === "plain" ? f(`${n.id}.txt`) : e.enc === "z" ? f(`${n.id}.z`) : e.enc === "delta" ? f(`${n.id}.dz`)
        : e.enc === "chunks" ? e.chunks.reduce((a, h) => a + this.store.chunkSize(h) / (refs.get(h) ?? 1), 0) : packBytes * n.rawBytes / (packRaw || 1);
      const alg = e.enc === "z" ? e.codec : e.enc === "pack" ? `pack:${e.codec}` : e.enc;
      o.nodes++; o.rawBytes += n.rawBytes; o.storedBytes += stored; o.algorithms[alg] = (o.algorithms[alg] ?? 0) + 1;
    }
    for (const o of Object.values(out)) { o.storedBytes = Math.round(o.storedBytes); o.ratio = o.storedBytes ? round(o.rawBytes / o.storedBytes) : 0; }
    return out;
  }
  graph() {
    const now = this.now();
    return {
      nodes: [...this.nodes.values()].map(n => ({ id: n.id, tier: n.tier, enc: n.enc.enc, kind: n.kind, label: n.keywords.slice(0, 3).join(" "), retention: round(retention(n, now)), salience: n.salience })),
      edges: [...this.edges].map(([k, w]) => { const [from, to] = k.split("|"); return { from, to, w: round(w) }; }),
    };
  }
}
const round = (x: number) => Math.round(x * 1000) / 1000;
