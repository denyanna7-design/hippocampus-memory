// Brain-inspired memory engine: file-backed nodes, spreading activation, Hebbian learning,
// power-law forgetting and forgetting-as-compression (L0 raw → L1 summary → L2 gist → L3 trace).
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { cosine, topTerms } from "./text.js";
import { Embedder, Summarizer, localEmbedder, extractiveSummarizer } from "./providers.js";

export type Tier = 0 | 1 | 2 | 3;
export interface MemoryNode {
  id: string;
  kind: "episodic" | "semantic";
  tier: Tier;
  text?: string;          // L0 only
  summary?: string;       // L0..L1
  keywords: string[];     // all tiers (L3: 3 words)
  vector: Record<string, number>; // pruned per tier
  salience: number;       // 0..1 emotional/importance weight
  stability: number;      // S (days): larger = slower forgetting
  createdAt: number;
  lastAccess: number;
  accessCount: number;
  originalBytes: number;
  tags: string[];
  sources?: string[];     // semantic memories: merged episode ids
  consolidated?: boolean;
}
export interface RecallHit { id: string; activation: number; tier: Tier; retention: number; text: string; reconstructed: boolean; via: "cue" | "spread"; }

export const DAY = 86_400_000;
export const P = {
  baseStability: 1,      // days
  tierRetention: [0.6, 0.35, 0.15] as const, // R below → compress to tier 1,2,3
  vectorKeep: [Infinity, 24, 8, 3],
  hopDecay: 0.7, hops: 2, threshold: 0.1, minCueSim: 0.05,
  hebbRate: 0.2, linkSim: 0.15, temporalLink: 0.25, mergeSim: 0.55,
  spacingGain: 1.5,
};

/** Power-law forgetting curve (FSRS-style): R(t) = (1 + t / (9·S))^-1 */
export function retention(n: Pick<MemoryNode, "stability" | "lastAccess">, now: number): number {
  const t = Math.max(0, now - n.lastAccess) / DAY;
  return 1 / (1 + t / (9 * n.stability));
}
export function tierFor(r: number): Tier {
  const [a, b, c] = P.tierRetention;
  return r >= a ? 0 : r >= b ? 1 : r >= c ? 2 : 3;
}

export interface EngineOpts { dir: string; now?: () => number; embedder?: Embedder; summarizer?: Summarizer; }
type Listener = (ev: { type: string; [k: string]: unknown }) => void;

export class MemoryEngine {
  readonly dir: string;
  now: () => number;
  embedder: Embedder; summarizer: Summarizer;
  nodes = new Map<string, MemoryNode>();
  edges = new Map<string, number>(); // "a|b" (a<b) → weight 0..1
  meta = { lastSleep: 0, lastId: "" };
  private listeners: Listener[] = [];

  constructor(o: EngineOpts) {
    this.dir = o.dir; this.now = o.now ?? Date.now;
    this.embedder = o.embedder ?? localEmbedder; this.summarizer = o.summarizer ?? extractiveSummarizer;
    mkdirSync(join(this.dir, "nodes"), { recursive: true });
    for (const f of readdirSync(join(this.dir, "nodes"))) if (f.endsWith(".json")) {
      const n = JSON.parse(readFileSync(join(this.dir, "nodes", f), "utf8")) as MemoryNode; this.nodes.set(n.id, n);
    }
    const ef = join(this.dir, "edges.json");
    if (existsSync(ef)) this.edges = new Map(Object.entries(JSON.parse(readFileSync(ef, "utf8"))));
    const mf = join(this.dir, "meta.json");
    if (existsSync(mf)) this.meta = JSON.parse(readFileSync(mf, "utf8"));
  }
  on(l: Listener) { this.listeners.push(l); return () => { this.listeners = this.listeners.filter(x => x !== l); }; }
  private emit(ev: { type: string; [k: string]: unknown }) { for (const l of this.listeners) l(ev); }

  // ---------- persistence ----------
  private saveNode(n: MemoryNode) {
    if (n.tier === 0) { n.originalBytes = 0; n.originalBytes = Buffer.byteLength(JSON.stringify(n)) + 6; } // uncompressed baseline
    writeFileSync(join(this.dir, "nodes", `${n.id}.json`), JSON.stringify(n)); }
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

  // ---------- encode ----------
  async remember(text: string, salience = 0.3, tags: string[] = []): Promise<MemoryNode> {
    const now = this.now();
    const vector = await this.embedder.embed(text + " " + tags.join(" "));
    const n: MemoryNode = {
      id: randomUUID().slice(0, 8), kind: "episodic", tier: 0, text, summary: undefined,
      keywords: Object.keys(topTerms(vector, 6)), vector, salience: clamp01(salience),
      stability: P.baseStability * (1 + 3 * clamp01(salience)), // emotional memories start stronger
      createdAt: now, lastAccess: now, accessCount: 0, originalBytes: 0, tags,
    };
    n.originalBytes = Buffer.byteLength(JSON.stringify(n));
    // associative links to similar memories + temporal link to the previous episode
    for (const m of this.nodes.values()) {
      const s = cosine(vector, m.vector);
      if (s >= P.linkSim) this.setWeight(n.id, m.id, s);
    }
    if (this.meta.lastId && this.nodes.has(this.meta.lastId)) this.setWeight(n.id, this.meta.lastId, Math.max(this.weight(n.id, this.meta.lastId), P.temporalLink));
    this.nodes.set(n.id, n); this.meta.lastId = n.id;
    this.saveNode(n); this.saveGraph();
    this.emit({ type: "remember", id: n.id });
    return n;
  }

  // ---------- recall: spreading activation ----------
  async recall(cue: string, k = 5): Promise<RecallHit[]> {
    const now = this.now();
    const cv = await this.embedder.embed(cue);
    const act = new Map<string, number>(); const via = new Map<string, "cue" | "spread">();
    // 1) seed: a_i = sim(cue,i) · (0.5 + 0.5·R_i)  — faded memories are harder to cue
    for (const n of this.nodes.values()) {
      const s = cosine(cv, n.vector);
      if (s >= P.minCueSim) { act.set(n.id, s * (0.5 + 0.5 * retention(n, now))); via.set(n.id, "cue"); }
    }
    // normalise seeds: a_i /= max(max_j a_j, 0.5) so a short cue can still ignite the network
    const amax = Math.max(0.5, ...act.values());
    for (const [i, a] of act) act.set(i, a / amax);
    // 2) spread: a_j += Σ a_i · w_ij · δ  per hop (capped at 1)
    let frontier = new Map(act);
    for (let h = 0; h < P.hops; h++) {
      const next = new Map<string, number>();
      for (const [i, a] of frontier) for (const [j, w] of this.neighbors(i)) {
        const add = a * w * P.hopDecay; if (add < 0.01) continue;
        next.set(j, (next.get(j) ?? 0) + add);
      }
      for (const [j, add] of next) { act.set(j, Math.min(1, (act.get(j) ?? 0) + add)); if (!via.has(j)) via.set(j, "spread"); }
      frontier = next;
    }
    // 3) threshold + top-k
    const winners = [...act].filter(([, a]) => a >= P.threshold).sort((a, b) => b[1] - a[1]).slice(0, k);
    this.emit({ type: "recall", cue, activation: Object.fromEntries(act), winners: winners.map(w => w[0]) });
    const hits: RecallHit[] = [];
    for (const [id, a] of winners) {
      const n = this.nodes.get(id)!;
      const r = retention(n, now);
      // retrieval practice / spacing effect: ΔS = S · g · (1-R) · (1+salience)
      n.stability += n.stability * P.spacingGain * (1 - r) * (1 + n.salience) * a + 0.1;
      n.lastAccess = now; n.accessCount++;
      const { text, reconstructed } = await this.render(n);
      hits.push({ id, activation: round(a), tier: n.tier, retention: round(r), text, reconstructed, via: via.get(id)! });
      this.saveNode(n);
    }
    // 4) Hebbian: co-activated winners wire together: w += η·a_i·a_j·(1-w)
    for (let x = 0; x < winners.length; x++) for (let y = x + 1; y < winners.length; y++) {
      const [i, ai] = winners[x], [j, aj] = winners[y];
      const w = this.weight(i, j); this.setWeight(i, j, w + P.hebbRate * ai * aj * (1 - w));
    }
    this.saveGraph();
    return hits;
  }

  /** Text for a memory at its current tier; L2/L3 are reconstructed from gist + linked neighbours. */
  async render(n: MemoryNode): Promise<{ text: string; reconstructed: boolean }> {
    if (n.tier === 0) return { text: n.text!, reconstructed: false };
    if (n.tier === 1) return { text: n.summary!, reconstructed: false };
    const ctx = this.neighbors(n.id).sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([id]) => this.nodes.get(id)).filter((m): m is MemoryNode => !!m && m.tier <= 1)
      .map(m => m.summary ?? m.text ?? "");
    return { text: await this.summarizer.reconstruct(n.keywords, ctx), reconstructed: true };
  }

  // ---------- forgetting = compression ----------
  async compress(n: MemoryNode, target: Tier): Promise<boolean> {
    if (target <= n.tier) return false;
    if (n.tier < 1 && target >= 1) n.summary = n.summary ?? await this.summarizer.summarize(n.text!);
    if (target >= 1) delete n.text;
    if (target >= 2) { delete n.summary; n.keywords = n.keywords.slice(0, 5); }
    if (target >= 3) n.keywords = n.keywords.slice(0, 3);
    n.vector = topTerms(n.vector, P.vectorKeep[target]);
    const from = n.tier; n.tier = target; this.saveNode(n);
    this.emit({ type: "compress", id: n.id, from, to: target });
    return true;
  }
  async decayAll(): Promise<{ id: string; from: Tier; to: Tier }[]> {
    const now = this.now(); const changes: { id: string; from: Tier; to: Tier }[] = [];
    for (const n of this.nodes.values()) {
      const from = n.tier, to = tierFor(retention(n, now));
      if (await this.compress(n, to)) changes.push({ id: n.id, from, to });
    }
    return changes;
  }

  // ---------- sleep consolidation ----------
  async sleep() {
    const now = this.now();
    const recent = [...this.nodes.values()].filter(n => n.kind === "episodic" && !n.consolidated && n.tier <= 1);
    // replay: co-replayed similar episodes get Hebbian strengthening; clusters → semantic memory
    const used = new Set<string>(); const created: string[] = [];
    for (const a of recent) {
      if (used.has(a.id)) continue;
      const cluster = [a, ...recent.filter(b => b !== a && !used.has(b.id) && cosine(a.vector, b.vector) >= P.mergeSim)];
      for (const x of cluster) for (const y of cluster) if (x.id < y.id) this.setWeight(x.id, y.id, this.weight(x.id, y.id) + 0.1);
      if (cluster.length < 2) continue;
      cluster.forEach(c => used.add(c.id));
      const joined = cluster.map(c => c.text ?? c.summary ?? "").join(" ");
      const vector: Record<string, number> = {};
      for (const c of cluster) for (const [t, v] of Object.entries(c.vector)) vector[t] = (vector[t] ?? 0) + v;
      const sem: MemoryNode = {
        id: randomUUID().slice(0, 8), kind: "semantic", tier: 0, text: await this.summarizer.summarize(joined),
        keywords: Object.keys(topTerms(vector, 6)), vector: topTerms(vector, 24),
        salience: Math.max(...cluster.map(c => c.salience)),
        stability: P.baseStability * 4 * cluster.length, // semantic knowledge is durable
        createdAt: now, lastAccess: now, accessCount: 0, originalBytes: 0, tags: ["semantic"], sources: cluster.map(c => c.id),
      };
      sem.originalBytes = Buffer.byteLength(JSON.stringify(sem));
      this.nodes.set(sem.id, sem); this.saveNode(sem); created.push(sem.id);
      for (const c of cluster) this.setWeight(sem.id, c.id, 0.8);
    }
    for (const n of recent) { n.consolidated = true; this.saveNode(n); }
    // synaptic homeostasis: weak edges shrink, near-zero edges pruned
    for (const [k, w] of this.edges) { const nw = w * 0.95; if (nw < 0.05) this.edges.delete(k); else this.edges.set(k, nw); }
    const compressed = await this.decayAll();
    this.meta.lastSleep = now; this.saveGraph();
    this.emit({ type: "sleep" });
    return { replayed: recent.length, semanticCreated: created, compressed };
  }

  // ---------- introspection ----------
  async inspect(id: string) {
    const n = this.nodes.get(id); if (!n) return null;
    const now = this.now(); const r = retention(n, now);
    // forget preview: days until each next tier at current stability. R=x ⇒ t = 9S(1/x - 1)
    const preview = P.tierRetention.map((x, i) => ({ tier: i + 1, inDays: round(Math.max(0, 9 * n.stability * (1 / x - 1) - (now - n.lastAccess) / DAY)) }));
    return { node: n, retention: round(r), bytes: this.bytes(n), rendered: await this.render(n), neighbors: this.neighbors(id), forgetPreview: preview };
  }
  bytes(n: MemoryNode) {
    const f = join(this.dir, "nodes", `${n.id}.json`);
    return existsSync(f) ? statSync(f).size : Buffer.byteLength(JSON.stringify(n));
  }
  stats() {
    const now = this.now(); const tiers = [0, 0, 0, 0]; let orig = 0, cur = 0, rs = 0;
    for (const n of this.nodes.values()) { tiers[n.tier]++; orig += n.originalBytes; cur += this.bytes(n); rs += retention(n, now); }
    return {
      nodes: this.nodes.size, edges: this.edges.size, tiers: { L0: tiers[0], L1: tiers[1], L2: tiers[2], L3: tiers[3] },
      originalBytes: orig, currentBytes: cur, bytesSaved: orig - cur, savedPct: orig ? round(100 * (orig - cur) / orig) : 0,
      meanRetention: this.nodes.size ? round(rs / this.nodes.size) : 0, embedder: this.embedder.name, summarizer: this.summarizer.name,
    };
  }
  graph() {
    const now = this.now();
    return {
      nodes: [...this.nodes.values()].map(n => ({ id: n.id, tier: n.tier, kind: n.kind, label: n.keywords.slice(0, 3).join(" "), retention: round(retention(n, now)), salience: n.salience })),
      edges: [...this.edges].map(([k, w]) => { const [from, to] = k.split("|"); return { from, to, w: round(w) }; }),
    };
  }
}
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const round = (x: number) => Math.round(x * 1000) / 1000;
