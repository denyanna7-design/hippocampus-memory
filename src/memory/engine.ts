// Brain-inspired memory engine.
//  Recall: spreading activation over a weighted association graph (Hebbian learning, spacing effect, salience).
//  Spread continues while frontier additions stay above epsilon, with a max-hop ceiling (not a fixed 2-hop walk).
//  Sleep decays edge weights toward a soft floor by elapsed retention-ticks: explicit cap, slow falloff.
//  Storage: graded tiers chosen by retention R. hot/warm are lossless; cool/cold store a memory as
//  schema (prototype) + importance-ordered residual diffs and may drop low-importance residual details,
//  but only when ROUGE-L, char similarity, and (cool/cold) local-embedding cosine all clear their floors.
//  Schema membership is permanent only after a near dual-check; near-misses stay provisional.
//  Nothing is ever deleted.
import { mkdirSync, readdirSync, readFileSync, existsSync, statSync, appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { cosine, topTerms, termFreq } from "./text.js";
const localTf = (t: string) => { const tf = termFreq(t); for (const k in tf) tf[k] = 1 + Math.log(tf[k]); return tf; };
import { Embedder, Summarizer, localEmbedder, extractiveSummarizer } from "./providers.js";
import { RawStore, Enc, sha, chunk, fileOf } from "./rawstore.js";
import { codec, codecsFor, trainDictionary, dictId, Codec } from "./codecs.js";
import { readIndex, writeIndex, HASH_HEX, sparsify } from "./index-file.js";
import { plan as residPlan, apply, Hunk, rougeL, charSim, packHunks, unpackHunks, schemaSecondScore, type Fid } from "./residual.js";

export type Tier = 0 | 1 | 2 | 3;
export const TIER_NAMES = ["hot", "warm", "cool", "cold"] as const;
/** Graded tier targets. Ratio = raw bytes / stored bytes (schema storage amortised over its members). */
export const TIERS = [
  { name: "hot",  lossless: true,  floor: 1.0,  charFloor: 1,    semanticFloor: 1,   target: [1, 2],   why: "fast access: stored as-is or LZ4" },
  { name: "warm", lossless: true,  floor: 1.0,  charFloor: 1,    semanticFloor: 1,   target: [2.5, 4], why: "zstd/brotli + trained dictionary, delta vs similar memory, chunk dedup" },
  { name: "cool", lossless: false, floor: 0.9,  charFloor: 0.85, semanticFloor: 0.8, target: [5, 8],   why: "schema + residual; keep a lossy encode only when ROUGE-L ≥ 0.90, char similarity ≥ 0.85, and local-embedding cosine ≥ 0.80" },
  { name: "cold", lossless: false, floor: 0.65, charFloor: 0.65, semanticFloor: 0.5, target: [8, 15],  why: "schema + key residuals; ROUGE-L ≥ 0.65, char similarity ≥ 0.65, and local-embedding cosine ≥ 0.50" },
] as const;
export const SALIENT = 0.7; // salience ≥ this ⇒ always lossless

export interface MemoryNode {
  id: string; kind: "episodic" | "schema";
  tier: Tier; enc: Enc;
  sha256: string; rawBytes: number;   // of the ORIGINAL bytes
  lossy?: boolean; reconSha?: string; // when lossy: hash of the reconstruction (integrity)
  fid: Fid; // fidelity of what is stored vs the original (1 = exact). semantic is local-embedding cosine when lossy.
  keeps?: { cool: number; cold: number; total: number; fidCool: Fid; fidCold: Fid };
  schema?: string; // set only after the near dual-check passes
  schemaHold?: string; // provisional schema id; re-checked on later sleep, never lossy
  pinned?: boolean; members?: string[];
  summary?: string; keywords: string[]; vector: Record<string, number>;
  salience: number; stability: number; createdAt: number; lastAccess: number; accessCount: number; tags: string[];
}
export interface RecallHit { id: string; activation: number; tier: Tier; storage: string; exact: boolean; fidelity: number; retention: number; text: string; summary?: string; via: "cue" | "spread"; }
export interface BudgetAlert { level: "over_budget"; message: string; totalBytes: number; budgetBytes: number; at: number; }

export const DAY = 86_400_000;
export const P = { baseStability: 1, tierRetention: [0.6, 0.35, 0.15] as const, hopDecay: 0.7, maxHops: 8, spreadEpsilon: 0.01, threshold: 0.1, minCueSim: 0.05,
  hebbRate: 0.2, linkSim: 0.15, temporalLink: 0.25, schemaSim: 0.35, schemaNear: 0.25, schemaLex: 0.2, schemaLexNear: 0.12, schemaMin: 3, spacingGain: 1.5, coldKeyResiduals: 1,
  edgeCap: 1, edgeFloor: 0.05, edgeHalfLifeDays: 60 };
export type SchemaLink = "permanent" | "provisional" | "reject";
/** Permanent only when vector similarity and the lexical/residual signal both clear. A one-sided or near miss stays provisional. */
export function schemaVerdict(similarity: number, second: number): SchemaLink {
  const simOk = similarity >= P.schemaSim, secOk = second >= P.schemaLex;
  if (simOk && secOk) return "permanent";
  if (simOk || secOk || (similarity >= P.schemaNear && second >= P.schemaLexNear)) return "provisional";
  return "reject";
}
/** Time-aware edge decay. `elapsedMs` is measured in retention ticks (days). Weight approaches `edgeFloor` asymptotically (no hard snap) and never exceeds `edgeCap`. */
export function decayEdgeWeight(w: number, elapsedMs: number): number {
  const cap = P.edgeCap, floor = P.edgeFloor;
  const clamped = Math.min(cap, Math.max(0, w));
  if (!(elapsedMs > 0) || clamped <= floor) return clamped;
  const ticks = elapsedMs / DAY;
  const keep = Math.exp(-Math.LN2 * ticks / P.edgeHalfLifeDays);
  return floor + (clamped - floor) * keep;
}
/** Spread until a hop adds nothing ≥ epsilon, or `maxHops` is hit. Mutates `act`. Returns hops actually taken. */
export function spreadActivation(act: Map<string, number>, neighbors: (id: string) => Iterable<[string, number]>, allow: (id: string) => boolean, opts?: { hopDecay?: number; epsilon?: number; maxHops?: number }): number {
  const hopDecay = opts?.hopDecay ?? P.hopDecay, epsilon = opts?.epsilon ?? P.spreadEpsilon, maxHops = opts?.maxHops ?? P.maxHops;
  let frontier = new Map(act); const fired = new Set<string>(); let hops = 0;
  while (hops < maxHops && frontier.size) {
    for (const id of frontier.keys()) fired.add(id); // each node spreads once; cycles cannot run out the ceiling
    const next = new Map<string, number>();
    for (const [i, a] of frontier) for (const [j, w] of neighbors(i)) {
      if (!allow(j) || fired.has(j)) continue;
      const add = a * w * hopDecay;
      if (!(add > 0) || add < epsilon) continue;
      next.set(j, (next.get(j) ?? 0) + add);
    }
    let mass = 0; for (const v of next.values()) mass += v;
    if (!(mass > 0) || mass < epsilon) break;
    for (const [j, add] of next) act.set(j, (act.get(j) ?? 0) + add);
    frontier = next; hops++;
  }
  return hops;
}

export function retention(n: Pick<MemoryNode, "stability" | "lastAccess">, now: number) { return 1 / (1 + Math.max(0, now - n.lastAccess) / DAY / (9 * n.stability)); }
export function tierFor(r: number): Tier { const [a, b, c] = P.tierRetention; return r >= a ? 0 : r >= b ? 1 : r >= c ? 2 : 3; }

interface Plan { id: string; tier: Tier; enc: Enc; blob?: Buffer; payload?: Buffer; newChunks?: [string, Buffer][]; cost: number; lossy: boolean; fid: Fid; recon?: Buffer; keeps?: MemoryNode["keeps"]; alg: string; }
interface PackOut { pack: "cool" | "cold"; tier: 2 | 3; codec: string; dict: string | null; data: Buffer | null; entries: Record<string, Buffer> }
interface Row { id: string; tier: Tier; rawBytes: number; cost: number; fid: number; cfid?: number; sfid?: number; alg: string; schema?: string; kind: string; }
export interface TierReport { tier: string; target: string; floor: number; charFloor: number; semanticFloor: number; lossless: boolean; before: Agg; expected: Agg; after: Agg; movedIn: number; }
interface Agg { nodes: number; rawBytes: number; storedBytes: number; ratio: number; fidelity: number; minFidelity: number; charFidelity: number; semanticFidelity: number; algorithms: Record<string, number>; }
export interface PassReport { at: string; dryRun: boolean; moves: Record<string, number>; tiers: TierReport[]; schemas: { count: number; created: number; storedBytes: number }; dictionary: string | null;
  totals: { rawBytes: number; storedBefore: number; storedExpected: number; storedAfter: number; ratioBefore: number; ratioExpected: number; ratioAfter: number }; alert: BudgetAlert | null; text: string; }

type Listener = (ev: { type: string; [k: string]: unknown }) => void;
export interface EngineOpts { dir: string; newId?: () => string; now?: () => number; embedder?: Embedder; summarizer?: Summarizer; budgetBytes?: number; log?: (m: string) => void; }

export class MemoryEngine {
  readonly dir: string; now: () => number; newId: () => string; embedder: Embedder; summarizer: Summarizer; budgetBytes: number; store: RawStore;
  nodes = new Map<string, MemoryNode>(); edges = new Map<string, number>();
  /** When an edge was last set. Missing ⇒ decay from lastSleep, capped by the newer endpoint's createdAt. Not part of the MCP API. */
  private edgeAt = new Map<string, number>();
  meta: { lastSleep: number; lastId: string; alert: BudgetAlert | null; dict: string | null; lastReport: PassReport | null } = { lastSleep: 0, lastId: "", alert: null, dict: null, lastReport: null };
  private listeners: Listener[] = []; private log: (m: string) => void;

  constructor(o: EngineOpts) {
    this.dir = o.dir; this.now = o.now ?? Date.now; this.newId = o.newId ?? (() => randomUUID().slice(0, 8)); this.embedder = o.embedder ?? localEmbedder; this.summarizer = o.summarizer ?? extractiveSummarizer;
    this.budgetBytes = o.budgetBytes ?? Number(process.env.MEMORY_BUDGET_BYTES ?? Infinity); this.log = o.log ?? (m => console.warn(m));
    mkdirSync(this.dir, { recursive: true }); this.store = new RawStore(this.dir);
    const idx = readIndex(join(this.dir, "index.bin"));
    if (idx) {
      for (const n of idx.nodes) this.nodes.set(n.id, n); this.edges = idx.edges; this.meta = { ...this.meta, ...idx.meta };
      for (const n of this.nodes.values()) {
        if (n.kind === "schema") n.members = [...this.nodes.values()].filter(m => m.schema === n.id).map(m => m.id);
        if (!n.vector) {
          // a damaged blob must not take the whole store down: keep loading, report it as unrecoverable
          let t = ""; try { t = this.text(n.id); } catch (err) { this.log(`[memory] cannot read ${n.id}: ${(err as Error).message}`); }
          n.vector = localTf(t + " " + (n.kind === "schema" ? "" : n.tags.join(" "))); n.keywords = Object.keys(topTerms(n.vector, 6)); this.vecSrc.set(n.id, true);
        }
      }
    }
    else if (existsSync(join(this.dir, "nodes"))) { // migrate legacy per-node JSON index
      for (const f of readdirSync(join(this.dir, "nodes"))) if (f.endsWith(".json")) { const n = JSON.parse(readFileSync(join(this.dir, "nodes", f), "utf8")) as MemoryNode; this.nodes.set(n.id, n); }
      const ef = join(this.dir, "edges.json"); if (existsSync(ef)) this.edges = new Map(Object.entries(JSON.parse(readFileSync(ef, "utf8"))));
      const mf = join(this.dir, "meta.json"); if (existsSync(mf)) this.meta = { ...this.meta, ...JSON.parse(readFileSync(mf, "utf8")) };
      this.flush(); for (const x of ["nodes", "edges.json", "meta.json"]) rmSync(join(this.dir, x), { recursive: true, force: true });
    }
    this.checkBudgetSync();
  }
  /** Budget state is derived from what is on disk, so it is (re)computed at load instead of being trusted from the index. */
  private checkBudgetSync() {
    if (!Number.isFinite(this.budgetBytes)) { this.meta.alert = null; return; }
    const f = this.footprint();
    this.meta.alert = f.totalBytes > this.budgetBytes ? { level: "over_budget", totalBytes: f.totalBytes, budgetBytes: this.budgetBytes, at: this.now(), message: this.alertMessage(f) } : null;
  }
  private alertMessage(f: ReturnType<MemoryEngine["footprint"]>) {
    return `Memory store is ${f.totalBytes} B (content ${f.contentBytes} B + dictionaries ${f.dictionaryBytes} B + index ${f.indexBytes} B), over the ${this.budgetBytes} B budget, and every memory is already in its deepest allowed tier (fidelity floors and high-salience memories are protected). Nothing was deleted. Please decide: raise MEMORY_BUDGET_BYTES, export/archive memories elsewhere, or explicitly approve deleting specific memories.`;
  }
  on(l: Listener) { this.listeners.push(l); return () => { this.listeners = this.listeners.filter(x => x !== l); }; }
  private emit(ev: { type: string; [k: string]: unknown }) { for (const l of this.listeners) l(ev); }
  private dirty = false; private vecSrc = new Map<string, boolean>(); // id → vector derivable from stored text
  /** Index writes are coalesced: everything changed in one tick is written once, compressed, atomically. */
  private saveNode(_n?: MemoryNode) { if (!this.dirty) { this.dirty = true; queueMicrotask(() => this.flush()); } }
  private saveMeta() { this.saveNode(); }
  flush() {
    this.dirty = false; const lr = this.meta.lastReport;
    // lossless memories with the default local embedder: the vector is a pure function of the text, so it is not stored
    const derivable = (n: MemoryNode) => this.embedder.name === "local-tf" && this.vecSrc.get(n.id) === true;
    writeIndex(join(this.dir, "index.bin"), this.nodes, this.edges, { ...this.meta, alert: null, lastReport: lr ? { at: lr.at, totals: lr.totals, moves: lr.moves } : null } /* alert is derived state: persisting it would make the index size depend on the alert text */, derivable);
  }
  private key(a: string, b: string) { return a < b ? `${a}|${b}` : `${b}|${a}`; }
  weight(a: string, b: string) { return this.edges.get(this.key(a, b)) ?? 0; }
  setWeight(a: string, b: string, w: number) {
    if (a === b) return;
    const k = this.key(a, b);
    this.edgeAt.set(k, this.now()); // strengthening resets the decay clock
    this.edges.set(k, Math.min(P.edgeCap, Math.max(0, w))); // explicit cap after strengthening
  }
  private edgeElapsed(key: string, now: number): number {
    const [a, b] = key.split("|");
    const born = Math.max(this.nodes.get(a)?.createdAt ?? 0, this.nodes.get(b)?.createdAt ?? 0, this.edgeAt.get(key) ?? 0);
    const anchor = Math.max(this.meta.lastSleep, born);
    return anchor ? Math.max(0, now - anchor) : 0;
  }
  neighbors(id: string): [string, number][] { const out: [string, number][] = []; for (const [k, w] of this.edges) { const [a, b] = k.split("|"); if (a === id) out.push([b, w]); else if (b === id) out.push([a, w]); } return out; }
  episodes() { return [...this.nodes.values()].filter(n => n.kind === "episodic"); }

  // ================= reading (always possible) =================
  private dict(id?: string) { return id ? this.store.readDict(id) : undefined; }
  /** Dictionary for residuals: trained corpus dictionary + the schema text itself (most recent = most useful). */
  private residDict(schema: string, dict?: string) { return Buffer.concat([dict ? this.store.readDict(dict) : Buffer.alloc(0), this.readRaw(this.nodes.get(schema)!)]); }
  /** Reconstructed bytes: exact for lossless tiers; for lossy, schema + kept residuals (fidelity ≥ tier floor). */
  readRaw(n: MemoryNode): Buffer {
    const e = n.enc; let b: Buffer;
    switch (e.enc) {
      case "plain": b = this.store.readFile(`${n.id}.txt`); break;
      case "z": b = codec(e.codec).decompress(this.store.readFile(`${n.id}.z`), this.dict(e.dict)); break;
      case "delta": b = codec(e.codec).decompress(this.store.readFile(`${n.id}.dz`), this.readRaw(this.nodes.get(e.base)!)); break;
      case "chunks": b = Buffer.concat(e.chunks.map(h => this.store.readChunk(h))); break;
      case "resid": b = Buffer.from(apply(this.text(e.schema), unpackHunks(codec(e.codec).decompress(this.store.readFile(`${n.id}.r`), e.dict !== undefined ? this.residDict(e.schema, e.dict || undefined) : undefined)).slice(0, e.keep))); break;
      case "pack": {
        const v = this.store.pack(e.pack ?? "cold").entries[n.id]; if (!v) throw new Error(`pack missing ${n.id}`);
        b = e.inner === "raw" ? v : Buffer.from(apply(this.text(e.schema!), unpackHunks(v).slice(0, e.keep)));
      }
    }
    if (!sha(b).startsWith((n.lossy ? n.reconSha : n.sha256)!.slice(0, HASH_HEX))) throw new Error(`integrity check failed for ${n.id}`);
    return b;
  }
  text(id: string) { return this.readRaw(this.nodes.get(id)!).toString("utf8"); }
  private dependents(id: string) { return [...this.nodes.values()].filter(m => (m.enc.enc === "delta" && m.enc.base === id) || m.schema === id); }
  canBeLossy(n: MemoryNode) { return !this.plannedBase.has(n.id) && n.kind === "episodic" && !n.pinned && n.salience < SALIENT && !!n.schema && !this.dependents(n.id).some(m => m.enc.enc === "delta"); }

  // ================= encode =================
  async remember(text: string, salience = 0.3, tags: string[] = []): Promise<MemoryNode> {
    const n = await this.create(text, "episodic", salience, tags);
    for (const m of this.nodes.values()) if (m !== n && m.kind === "episodic") { const c = cosine(n.vector, m.vector); if (c >= P.linkSim) this.setWeight(n.id, m.id, c); }
    if (this.meta.lastId && this.nodes.has(this.meta.lastId)) this.setWeight(n.id, this.meta.lastId, Math.max(this.weight(n.id, this.meta.lastId), P.temporalLink));
    this.meta.lastId = n.id; this.saveMeta(); this.emit({ type: "remember", id: n.id });
    await this.enforceBudget(); return n;
  }
  private async create(text: string, kind: MemoryNode["kind"], salience: number, tags: string[]) {
    const raw = Buffer.from(text, "utf8"); const now = this.now(); const s = Math.min(1, Math.max(0, salience));
    const vector = await this.embedder.embed(text + " " + tags.join(" "));
    const n: MemoryNode = { id: this.newId(), kind, tier: 0, enc: { enc: "plain" }, sha256: sha(raw), rawBytes: raw.length, fid: { rouge: 1, char: 1 },
      keywords: Object.keys(topTerms(vector, 6)), vector, salience: s, stability: P.baseStability * (1 + 3 * s), createdAt: now, lastAccess: now, accessCount: 0, tags };
    this.vecSrc.set(n.id, JSON.stringify(localTf(text + " " + tags.join(" "))) === JSON.stringify(vector));
    this.store.writeFile(`${n.id}.txt`, raw); this.nodes.set(n.id, n); this.saveNode(n); return n;
  }

  // ================= recall =================
  async recall(cue: string, k = 5): Promise<RecallHit[]> {
    const now = this.now(); const cv = await this.embedder.embed(cue);
    const act = new Map<string, number>(); const via = new Map<string, "cue" | "spread">();
    for (const n of this.episodes()) { const s = cosine(cv, n.vector); if (s >= P.minCueSim) { act.set(n.id, s * (0.5 + 0.5 * retention(n, now))); via.set(n.id, "cue"); } }
    const amax = Math.max(0.5, ...act.values()); for (const [i, a] of act) act.set(i, a / amax);
    const seeded = new Set(act.keys());
    spreadActivation(act, id => this.neighbors(id), id => this.nodes.get(id)?.kind === "episodic");
    for (const id of act.keys()) if (!seeded.has(id)) via.set(id, "spread");
    const top = Math.max(1, ...act.values()); for (const [i, a] of act) act.set(i, a / top); // keep ranking, scale to ≤1
    const winners = [...act].filter(([, a]) => a >= P.threshold).sort((a, b) => b[1] - a[1]).slice(0, k);
    this.emit({ type: "recall", cue, activation: Object.fromEntries(act), winners: winners.map(w => w[0]) });
    const hits: RecallHit[] = []; const warm: Record<string, Tier> = {};
    for (const [id, a] of winners) {
      const n = this.nodes.get(id)!; const r = retention(n, now);
      n.stability += n.stability * P.spacingGain * (1 - r) * (1 + n.salience) * a + 0.1; n.lastAccess = now; n.accessCount++;
      hits.push({ id, activation: round(a), tier: n.tier, storage: `${TIER_NAMES[n.tier]}/${algOf(n.enc)}`, exact: !n.lossy, fidelity: round(n.fid.rouge), retention: round(r), text: this.text(id), summary: n.summary ?? (n.rawBytes > 160 ? this.summarySync(n) : undefined), via: via.get(id)! });
      if (!n.lossy && n.tier > 1) warm[id] = 1; // reconsolidation: lossless memories warm up
      this.saveNode(n);
    }
    for (let x = 0; x < winners.length; x++) for (let y = x + 1; y < winners.length; y++) { const [i, ai] = winners[x], [j, aj] = winners[y]; const w = this.weight(i, j); this.setWeight(i, j, w + P.hebbRate * ai * aj * (1 - w)); }
    this.saveMeta();
    if (Object.keys(warm).length) await this.pass({ force: warm, quiet: true });
    return hits;
  }

  // ================= planning (pure: nothing written) =================
  private plannedDelta = new Set<string>(); private plannedBase = new Set<string>(); // within one pass: no cycles
  private deltaBase(n: MemoryNode): MemoryNode | undefined {
    if (this.dependents(n.id).length || this.plannedBase.has(n.id)) return undefined;
    let best: MemoryNode | undefined, bs = 0.3;
    for (const m of this.nodes.values()) { if (m === n || m.lossy || m.enc.enc === "delta" || this.plannedDelta.has(m.id) || this.canBeLossy(m)) continue; const s = cosine(n.vector, m.vector); if (s > bs) { bs = s; best = m; } }
    return best;
  }
  private codecCands(raw: Buffer, cs: Codec[], dict?: string): { enc: Enc; blob: Buffer }[] {
    const out: { enc: Enc; blob: Buffer }[] = [];
    for (const c of cs) {
      out.push({ enc: { enc: "z", codec: c.name }, blob: c.compress(raw) });
      if (dict && c.family === "zstd") out.push({ enc: { enc: "z", codec: c.name, dict }, blob: c.compress(raw, this.store.readDict(dict)) });
    }
    return out;
  }
  private localSim(raw: string, hyp: string) { return cosine(localTf(raw), localTf(hyp)); }
  private meetsLossy(fid: Fid, tier: 2 | 3) {
    const t = TIERS[tier];
    return fid.rouge >= t.floor && fid.char >= t.charFloor && (fid.semantic ?? 0) >= t.semanticFloor;
  }
  private residKeeps(n: MemoryNode, raw: string) {
    const schema = this.text(n.schema!);
    const sim = (hyp: string) => this.localSim(raw, hyp);
    const p = residPlan(schema, raw, [
      { rouge: TIERS[2].floor, char: TIERS[2].charFloor, semantic: TIERS[2].semanticFloor },
      { rouge: TIERS[3].floor, char: TIERS[3].charFloor, semantic: TIERS[3].semanticFloor },
    ], sim);
    const fidAt = (k: number): Fid => {
      const r = apply(schema, p.hunks.slice(0, k));
      return { rouge: round(rougeL(raw, r)), char: round(charSim(raw, r)), semantic: round(sim(r)) };
    };
    // Both gates already chose these keeps. Bump if a later adjustment (key residual) or a non-monotonic
    // prefix would otherwise commit a lossy encode under a floor. All hunks reconstruct exactly.
    let cool = p.keeps[0];
    while (cool < p.hunks.length && !this.meetsLossy(fidAt(cool), 2)) cool++;
    let cold = Math.min(p.hunks.length, Math.max(p.keeps[1], Math.min(P.coldKeyResiduals, p.keeps[0])));
    while (cold < p.hunks.length && !this.meetsLossy(fidAt(cold), 3)) cold++;
    return { hunks: p.hunks, keeps: { cool, cold, total: p.hunks.length, fidCool: fidAt(cool), fidCold: fidAt(cold) }, schema };
  }
  private planNode(n: MemoryNode, tier: Tier): Plan {
    const lossless = !n.lossy; const raw = lossless ? this.readRaw(n) : undefined;
    const exact = { rouge: 1, char: 1 };
    const mk = (enc: Enc, blob: Buffer, extra: Partial<Plan> = {}): Plan => ({ id: n.id, tier, enc, blob, cost: blob.length, lossy: false, fid: exact, alg: algOf(enc), ...extra });
    if (tier >= 2) {
      const pk = tier === 2 ? "cool" as const : "cold" as const;
      if (n.lossy || this.canBeLossy(n)) {
        const k = n.lossy ? n.keeps! : undefined;
        const hunks = n.lossy ? this.allHunks(n).slice(0, Math.min(k![pk], this.currentKeep(n))) : undefined;
        const r = n.lossy ? { hunks: hunks!, keeps: k!, schema: this.text(n.schema!) } : this.residKeeps(n, raw!.toString());
        const kept = n.lossy ? hunks! : r.hunks.slice(0, r.keeps[pk]);
        const payload = packHunks(kept); const recon = Buffer.from(apply(r.schema, kept));
        const isLossy = !!n.lossy || recon.toString() !== raw!.toString();
        const fk = pk === "cool" ? "fidCool" as const : "fidCold" as const;
        const fid = n.lossy ? (r.keeps[pk] >= this.currentKeep(n) ? n.fid : r.keeps[fk]) : r.keeps[fk];
        return { id: n.id, tier, enc: { enc: "pack", pack: pk, codec: "?", inner: "resid", schema: n.schema, keep: kept.length }, payload, cost: payload.length, lossy: isLossy, fid: isLossy ? fid : exact, recon, keeps: r.keeps, alg: "pack:resid" };
      }
      return { id: n.id, tier, enc: { enc: "pack", pack: pk, codec: "?", inner: "raw" }, payload: raw!, cost: raw!.length, lossy: false, fid: exact, alg: "pack:raw" };
    }
    if (!lossless) throw new Error("lossy memories cannot move to a lossless tier");
    const r = raw!; const cands: Plan[] = [mk({ enc: "plain" }, r)];
    if (tier === 0) { for (const c of codecsFor("hot")) cands.push(mk({ enc: "z", codec: c.name }, c.compress(r))); return best(cands); }
    const cs = codecsFor(tier === 1 ? "warm" : "cool");
    for (const c of this.codecCands(r, cs, this.meta.dict ?? undefined)) cands.push(mk(c.enc, c.blob));
    const base = this.deltaBase(n);
    if (base) { const br = this.readRaw(base); for (const c of cs.filter(c => c.dict)) cands.push(mk({ enc: "delta", base: base.id, codec: c.name }, c.compress(r, br), { cost: c.compress(r, br).length + 12 })); }
    const parts = chunk(r); const hashes: string[] = []; const fresh: [string, Buffer][] = []; let cost = hashes.length;
    for (const part of parts) { const h = sha(part).slice(0, 24); hashes.push(h); if (!this.store.hasChunk(h) && !fresh.some(f => f[0] === h)) { const d = codec("brotli-11").compress(part); fresh.push([h, d]); cost += d.length; } }
    cands.push({ id: n.id, tier, enc: { enc: "chunks", chunks: hashes }, newChunks: fresh, cost: cost + hashes.length * 27, lossy: false, fid: exact, alg: "chunks" });
    return best(cands);
  }
  private allHunks(n: MemoryNode): Hunk[] {
    if (n.enc.enc === "resid") { const e = n.enc; return unpackHunks(codec(e.codec).decompress(this.store.readFile(`${n.id}.r`), e.dict !== undefined ? this.residDict(e.schema, e.dict || undefined) : undefined)); }
    if (n.enc.enc === "pack" && n.enc.inner === "resid") return unpackHunks(this.store.pack(n.enc.pack ?? "cold").entries[n.id]);
    return [];
  }
  private currentKeep(n: MemoryNode) { return n.enc.enc === "resid" || n.enc.enc === "pack" ? (n.enc.keep ?? 0) : 0; }

  // ================= accounting =================
  private diskCost(n: MemoryNode, refs: Map<string, number>, pks: Record<string, { size: number; total: number; entries: Record<string, Buffer> }>) {
    const e = n.enc;
    if (e.enc === "chunks") return e.chunks.reduce((a, h) => a + this.store.chunkSize(h) / (refs.get(h) ?? 1), 0);
    if (e.enc === "pack") { const pk = pks[e.pack ?? "cold"]; return pk.size * (pk.entries[n.id]?.length ?? 0) / (pk.total || 1); }
    return this.store.fileSize(n.id, e);
  }
  private rowsFromDisk(): Row[] {
    const refs = new Map<string, number>(); for (const n of this.nodes.values()) if (n.enc.enc === "chunks") for (const h of n.enc.chunks) refs.set(h, (refs.get(h) ?? 0) + 1);
    const pks = Object.fromEntries((["cool", "cold"] as const).map(k => { let pack: { entries: Record<string, Buffer> }; try { pack = this.store.pack(k); } catch { pack = { entries: {} }; } return [k, { size: this.store.packSize(k), total: Object.values(pack.entries).reduce((a, b) => a + b.length, 0), entries: pack.entries }]; }));
    return [...this.nodes.values()].map(n => ({ id: n.id, tier: n.tier, rawBytes: n.rawBytes, cost: this.diskCost(n, refs, pks), fid: n.fid.rouge, cfid: n.fid.char, sfid: n.fid.semantic ?? (n.lossy ? undefined : 1), alg: algOf(n.enc), schema: n.lossy || n.enc.enc === "resid" || (n.enc.enc === "pack" && n.enc.inner === "resid") ? n.schema : undefined, kind: n.kind }));
  }
  private aggregate(rows: Row[]) {
    const schemaCost = new Map(rows.filter(r => r.kind === "schema").map(r => [r.id, r.cost]));
    const users = new Map<string, number>(); for (const r of rows) if (r.schema) users.set(r.schema, (users.get(r.schema) ?? 0) + 1);
    const tiers: Agg[] = TIER_NAMES.map(() => ({ nodes: 0, rawBytes: 0, storedBytes: 0, ratio: 0, fidelity: 0, minFidelity: 1, charFidelity: 0, semanticFidelity: 0, algorithms: {} }));
    const semSum = [0, 0, 0, 0], semN = [0, 0, 0, 0];
    let schemaStored = 0;
    for (const r of rows) {
      if (r.kind === "schema") { schemaStored += r.cost; continue; }
      const a = tiers[r.tier]; const share = r.schema ? (schemaCost.get(r.schema) ?? 0) / (users.get(r.schema) ?? 1) : 0;
      a.nodes++; a.rawBytes += r.rawBytes; a.storedBytes += r.cost + share; a.fidelity += r.fid; a.charFidelity += r.cfid ?? 1; a.minFidelity = Math.min(a.minFidelity, r.fid); a.algorithms[r.alg] = (a.algorithms[r.alg] ?? 0) + 1;
      if (r.sfid !== undefined) { semSum[r.tier] += r.sfid; semN[r.tier]++; }
    }
    for (let i = 0; i < tiers.length; i++) { const a = tiers[i]; a.storedBytes = Math.round(a.storedBytes); a.ratio = a.storedBytes ? round(a.rawBytes / a.storedBytes) : 0; a.fidelity = a.nodes ? round(a.fidelity / a.nodes) : 0; a.charFidelity = a.nodes ? round(a.charFidelity / a.nodes) : 0; a.minFidelity = a.nodes ? round(a.minFidelity) : 0; a.semanticFidelity = semN[i] ? round(semSum[i] / semN[i]) : 0; }
    const raw = rows.filter(r => r.kind !== "schema").reduce((s, r) => s + r.rawBytes, 0); const stored = Math.round(rows.reduce((s, r) => s + r.cost, 0));
    return { tiers, raw, stored, schemaStored: Math.round(schemaStored) };
  }

  // ================= sleep / compression pass =================
  /** Schema formation. Permanent membership needs vector similarity and a second lexical/residual signal. Near-misses stay provisional (`schemaHold`) and are re-checked on the next sleep — a miss never accumulates into permanence. */
  private formSchemas(): number {
    const schemas = [...this.nodes.values()].filter(n => n.kind === "schema"); let created = 0;
    const free = this.episodes().filter(n => !n.schema && !n.lossy);
    const textOf = new Map<string, string>();
    const txt = (n: MemoryNode) => { let t = textOf.get(n.id); if (t === undefined) { t = this.text(n.id); textOf.set(n.id, t); } return t; };
    const judge = (n: MemoryNode, s: MemoryNode) => {
      if (n.id === s.id) return { v: "permanent" as SchemaLink, sim: 1 };
      const sim = cosine(n.vector, s.vector);
      return { v: schemaVerdict(sim, schemaSecondScore(txt(s), txt(n))), sim };
    };
    for (const n of free) {
      let best: { s: MemoryNode; v: SchemaLink; sim: number } | undefined;
      for (const s of schemas) {
        const j = judge(n, s);
        if (j.v === "reject") continue;
        if (!best || (j.v === "permanent" && best.v !== "permanent") || (j.v === best.v && j.sim > best.sim)) best = { s, v: j.v, sim: j.sim };
      }
      if (best?.v === "permanent") { delete n.schemaHold; n.schema = best.s.id; best.s.members!.push(n.id); this.saveNode(n); this.saveNode(best.s); }
      else if (best) { n.schemaHold = best.s.id; this.saveNode(n); }
      else if (n.schemaHold) { delete n.schemaHold; this.saveNode(n); }
    }
    const left = free.filter(n => !n.schema); const used = new Set<string>();
    for (const a of left) {
      if (used.has(a.id)) continue;
      const cl = [a, ...left.filter(b => b !== a && !used.has(b.id) && cosine(a.vector, b.vector) >= P.schemaSim)];
      if (cl.length < P.schemaMin) continue;
      const medoid = cl.map(c => ({ c, s: cl.reduce((acc, d) => acc + cosine(c.vector, d.vector), 0) })).sort((x, y) => y.s - x.s)[0].c;
      const judged = cl.map(node => ({ node, ...judge(node, medoid) }));
      const permanent = judged.filter(j => j.v === "permanent").map(j => j.node);
      const provisional = judged.filter(j => j.v === "provisional").map(j => j.node);
      if (permanent.length < P.schemaMin) continue; // do not stick a cosine-only cluster
      permanent.forEach(c => used.add(c.id));
      const sraw = this.readRaw(medoid);
      const s: MemoryNode = { ...structuredClone(medoid), id: this.newId(), kind: "schema", pinned: true, members: permanent.map(c => c.id), tier: 0, enc: { enc: "plain" }, schema: undefined, schemaHold: undefined, tags: ["schema"], salience: 1 };
      this.vecSrc.set(s.id, JSON.stringify(localTf(sraw.toString("utf8") + " ")) === JSON.stringify(s.vector));
      this.store.writeFile(`${s.id}.txt`, sraw); this.nodes.set(s.id, s); this.saveNode(s); created++;
      for (const c of permanent) { delete c.schemaHold; c.schema = s.id; this.saveNode(c); this.setWeight(s.id, c.id, 0.8); }
      for (const c of provisional) if (!c.schema) { c.schemaHold = s.id; this.saveNode(c); }
      schemas.push(s);
    }
    return created;
  }
  private trainDict() {
    const samples = this.episodes().filter(n => !n.lossy).map(n => this.text(n.id));
    const rawTotal = samples.reduce((a, t) => a + Buffer.byteLength(t), 0);
    const d = trainDictionary(samples, Math.min(16384, Math.max(1024, Math.round(rawTotal / 6)))); if (!d) return;
    const id = dictId(d); this.store.writeDict(id, d); this.meta.dict = id;
  }
  private desiredTier(n: MemoryNode, now: number): Tier { return n.kind === "schema" ? 1 : tierFor(retention(n, now)); }

  /** One compression pass. `dryRun` returns the expected report without writing anything. */
  async pass(opts: { dryRun?: boolean; force?: Record<string, Tier>; quiet?: boolean; schemasCreated?: number; recode?: boolean } = {}): Promise<PassReport> {
    const now = this.now();
    const staleDict = (n: MemoryNode) => !n.lossy && (n.enc.enc === "z" || n.enc.enc === "resid") && !!n.enc.dict && n.enc.dict !== this.meta.dict; // re-encode so old dictionaries can be retired
    const before = this.aggregate(this.rowsFromDisk());
    const moving: [MemoryNode, Tier][] = [];
    for (const n of this.nodes.values()) {
      const want = opts.force?.[n.id] ?? this.desiredTier(n, now);
      if (want === n.tier && !(opts.recode && staleDict(n))) continue;
      if (want < n.tier && (n.lossy || opts.force?.[n.id] === undefined)) continue; // decay only goes colder; lossy never warms
      moving.push([n, want]);
    }
    const moves: Record<string, number> = {}; for (const [n, t] of moving) { const k = n.tier === t ? `recode(${TIER_NAMES[t]})` : `${TIER_NAMES[n.tier]}→${TIER_NAMES[t]}`; moves[k] = (moves[k] ?? 0) + 1; }
    this.plannedDelta.clear(); this.plannedBase.clear();
    const plans = moving.map(([n, t]) => { const p = this.planNode(n, t); if (p.enc.enc === "delta") { this.plannedDelta.add(n.id); this.plannedBase.add(p.enc.base); } return p; });
    // shared tier archives (cool, cold): rebuilt whenever a memory enters or leaves them
    const finalTier = (n: MemoryNode) => plans.find(p => p.id === n.id)?.tier ?? n.tier;
    const packOuts: PackOut[] = [];
    for (const [pk, t] of [["cool", 2], ["cold", 3]] as const) {
      const stalePack = opts.recode && !!this.store.pack(pk).dict && this.store.pack(pk).dict !== this.meta.dict;
      if (!(plans.some(p => p.tier === t) || moving.some(([n]) => n.tier === t) || stalePack)) continue;
      const old = this.store.pack(pk).entries; const entries: Record<string, Buffer> = {};
      for (const n of this.nodes.values()) if (finalTier(n) === t) entries[n.id] = plans.find(p => p.id === n.id)?.payload ?? old[n.id];
      const body = this.store.packBody(entries); const dict = this.meta.dict; const cands: { c: string; dict: string | null; d: Buffer }[] = [];
      if (Object.keys(entries).length) for (const c of codecsFor(pk)) { cands.push({ c: c.name, dict: null, d: c.compress(body) }); if (dict && c.family === "zstd") cands.push({ c: c.name, dict, d: c.compress(body, this.store.readDict(dict)) }); }
      const b = cands.sort((x, y) => x.d.length - y.d.length)[0];
      packOuts.push({ pack: pk, tier: t, codec: b?.c ?? "none", dict: b?.dict ?? null, data: b?.d ?? null, entries });
    }
    // expected accounting
    const rowsExp = this.rowsFromDisk().map(r => {
      const p = plans.find(q => q.id === r.id); const n = this.nodes.get(r.id)!;
      const tier = p?.tier ?? r.tier; let cost = p ? p.cost : r.cost;
      const po = packOuts.find(o => o.tier === tier);
      if (po) { const tot = Object.values(po.entries).reduce((a, b) => a + b.length, 0); cost = ((po.data?.length ?? 0) + po.codec.length + 15) * (po.entries[r.id]?.length ?? 0) / (tot || 1); }
      const lossyResid = p ? (p.enc.enc === "resid" || (p.enc.enc === "pack" && p.enc.inner === "resid")) : !!r.schema;
      const alg = po ? `pack(${po.pack}):${po.codec}${po.dict ? "+dict" : ""}:${p ? (p.enc.enc === "pack" ? p.enc.inner : "") : r.alg.split(":").pop()}` : p ? p.alg : r.alg;
      return { ...r, tier, cost, fid: p ? p.fid.rouge : r.fid, cfid: p ? p.fid.char : r.cfid, sfid: p ? (p.fid.semantic ?? (p.lossy ? undefined : 1)) : r.sfid, alg, schema: lossyResid ? n.schema : undefined };
    });
    const expected = this.aggregate(rowsExp);
    if (!opts.dryRun) this.commit(plans, packOuts);
    const after = opts.dryRun ? expected : this.aggregate(this.rowsFromDisk());
    if (!opts.dryRun) await this.enforceBudget(true);
    const report: PassReport = {
      at: new Date(now).toISOString(), dryRun: !!opts.dryRun, moves, dictionary: this.meta.dict,
      schemas: { count: [...this.nodes.values()].filter(n => n.kind === "schema").length, created: opts.schemasCreated ?? 0, storedBytes: after.schemaStored },
      tiers: TIERS.map((t, i) => ({ tier: t.name, target: `${t.target[0]}–${t.target[1]}x`, floor: t.floor, charFloor: t.charFloor, semanticFloor: t.semanticFloor, lossless: t.lossless, before: before.tiers[i], expected: expected.tiers[i], after: after.tiers[i], movedIn: plans.filter(p => p.tier === i).length })),
      totals: { rawBytes: after.raw, storedBefore: before.stored, storedExpected: expected.stored, storedAfter: after.stored, ratioBefore: ratio(before.raw, before.stored), ratioExpected: ratio(expected.raw, expected.stored), ratioAfter: ratio(after.raw, after.stored) },
      alert: this.meta.alert, text: "",
    };
    report.text = renderReport(report);
    if (!opts.quiet) {
      if (!opts.dryRun) { this.meta.lastReport = report; appendFileSync(join(this.dir, "compaction.log"), report.text + "\n" + JSON.stringify({ ...report, text: undefined }) + "\n\n"); }
      this.saveMeta(); this.emit({ type: "pass", dryRun: !!opts.dryRun });
    }
    return report;
  }
  private commit(plans: Plan[], packOuts: PackOut[]) {
    const old = new Map(plans.map(p => [p.id, { ...this.nodes.get(p.id)!.enc }]));
    for (const p of plans.filter(p => p.tier !== 3)) {           // 1) write new per-node encodings
      const n = this.nodes.get(p.id)!;
      if (p.newChunks) for (const [h, d] of p.newChunks) this.store.writeChunk(h, d);
      if (p.blob) this.store.writeFile(fileOf(n.id, p.enc)!, p.blob);
    }
    for (const o of packOuts) this.store.writePack(o.pack, o.codec, o.dict, o.data, o.entries); // 2) write archives
    for (const p of plans) {                                     // 3) switch all encodings first (blobs may share filenames)
      const n = this.nodes.get(p.id)!;
      n.enc = p.enc.enc === "pack" ? { ...p.enc, codec: packOuts.find(o => o.tier === p.tier)!.codec } : p.enc;
      n.tier = p.tier; n.lossy = p.lossy; n.fid = p.fid; if (p.keeps) n.keeps = p.keeps; n.reconSha = p.lossy ? sha(p.recon!) : undefined;
      // a faded memory is cued by what is left of it: re-derive its vector from the reconstruction (not stored in the index)
      if (p.lossy && this.embedder.name === "local-tf") { n.vector = localTf(p.recon!.toString("utf8") + " " + n.tags.join(" ")); n.keywords = Object.keys(topTerms(n.vector, 6)); this.vecSrc.set(n.id, true); }
    }
    for (const n of this.nodes.values()) { const e = n.enc; if (e.enc !== "pack") continue; const o = packOuts.find(x => x.pack === (e.pack ?? "cold")); if (o) n.enc = { ...e, codec: o.codec }; }
    for (const p of plans) {                                     // 4) verify every moved memory, then drop superseded blobs
      const n = this.nodes.get(p.id)!; const prev = old.get(p.id)!;
      this.readRaw(n); // throws if anything is off
      if (!n.summary && p.tier >= 1 && n.rawBytes > 160) n.summary = this.summarySync(n);
      if (fileOf(n.id, prev) !== fileOf(n.id, n.enc)) this.store.drop(n.id, prev);
      this.saveNode(n); this.emit({ type: "tier", id: n.id, to: p.tier, enc: n.enc.enc });
    }
    for (const n of this.nodes.values()) if (n.enc.enc === "pack") this.saveNode(n);
    const live = new Set<string>(); const dicts = new Set<string>(this.meta.dict ? [this.meta.dict] : []);
    for (const n of this.nodes.values()) { if (n.enc.enc === "chunks") n.enc.chunks.forEach(h => live.add(h)); if ((n.enc.enc === "z" || n.enc.enc === "resid") && n.enc.dict) dicts.add(n.enc.dict); }
    for (const k of ["cool", "cold"] as const) { const d = this.store.pack(k).dict; if (d) dicts.add(d); }
    this.store.gcChunks(live); this.store.gcDicts(dicts);
  }
  private summarySync(n: MemoryNode) { const t = this.text(n.id); return t.length > 160 ? t.slice(0, 157) + "…" : t; }

  async sleep(opts: { dryRun?: boolean } = {}) {
    if (opts.dryRun) return this.pass({ dryRun: true });
    const now = this.now();
    for (const [k, w] of this.edges) this.edges.set(k, decayEdgeWeight(w, this.edgeElapsed(k, now)));
    this.edgeAt.clear(); // decay has been applied through `now`; new edges below stamp themselves
    const created = this.formSchemas(); this.trainDict();
    this.meta.lastSleep = now;
    // synaptic pruning: weak associations beyond each node's strongest few are forgotten (memories themselves never are)
    const keep = new Set(sparsify(this.edges).map(e => e[0])); for (const k of [...this.edges.keys()]) if (!keep.has(k)) this.edges.delete(k);
    return this.pass({ schemasCreated: created, recode: true });
  }

  // ================= budget =================
  /** On-disk footprint split into memory content, shared zstd dictionaries, and the (compressed) index. */
  footprint() {
    if (this.dirty) this.flush();
    const content = this.store.dirBytes("raw") + this.store.dirBytes("chunks") + this.store.dirBytes("packs");
    const dictionaries = this.store.dirBytes("dicts"); const f = join(this.dir, "index.bin"); const index = existsSync(f) ? statSync(f).size : 0;
    return { contentBytes: content, dictionaryBytes: dictionaries, indexBytes: index, totalBytes: content + dictionaries + index };
  }
  totalBytes() { return this.footprint().totalBytes; }
  async enforceBudget(inPass = false): Promise<BudgetAlert | null> {
    if (!Number.isFinite(this.budgetBytes)) return null;
    if (!inPass && this.totalBytes() > this.budgetBytes) {
      const now = this.now();
      const order = [...this.nodes.values()].filter(n => n.kind === "episodic").sort((a, b) => retention(a, now) - retention(b, now));
      for (const t of [2, 3] as Tier[]) {
        if (this.totalBytes() <= this.budgetBytes) break;
        const force: Record<string, Tier> = {}; for (const n of order) if (n.tier < t) force[n.id] = t;
        if (Object.keys(force).length) await this.pass({ force, quiet: true });
      }
    }
    const f = this.footprint(); const total = f.totalBytes;
    if (total > this.budgetBytes) {
      const alert: BudgetAlert = { level: "over_budget", totalBytes: total, budgetBytes: this.budgetBytes, at: this.now(), message: this.alertMessage(f) };
      if (!this.meta.alert) this.log(`[memory] ALERT ${alert.message}`);
      this.meta.alert = alert; this.emit({ type: "alert", alert });
    } else this.meta.alert = null;
    this.saveMeta(); return this.meta.alert;
  }

  // ================= introspection =================
  async inspect(id: string) {
    const n = this.nodes.get(id); if (!n) return null; const now = this.now();
    const preview = P.tierRetention.map((x, i) => ({ tier: TIER_NAMES[i + 1], inDays: round(Math.max(0, 9 * n.stability * (1 / x - 1) - (now - n.lastAccess) / DAY)) }));
    return { node: { ...n, vector: undefined }, retention: round(retention(n, now)), storage: `${TIER_NAMES[n.tier]}/${algOf(n.enc)}`, exact: !n.lossy, fidelity: n.fid, text: this.text(id), neighbors: this.neighbors(id), colderTierPreview: preview,
      protected: n.salience >= SALIENT ? "high salience: always lossless" : n.schema ? "may be stored as schema+residual in cool/cold" : n.schemaHold ? "provisional schema candidate: still lossless until the near dual-check passes" : "no schema yet: lossless" };
  }
  stats() {
    const now = this.now(); const a = this.aggregate(this.rowsFromDisk()); const eps = this.episodes();
    return {
      memories: eps.length, schemas: this.nodes.size - eps.length, edges: this.edges.size,
      tiers: TIERS.map((t, i) => ({ tier: t.name, target: `${t.target[0]}–${t.target[1]}x`, floor: t.floor, charFloor: t.charFloor, semanticFloor: t.semanticFloor, ...a.tiers[i] })),
      rawBytes: a.raw, storedBytes: a.stored, compressionRatio: ratio(a.raw, a.stored), schemaBytes: a.schemaStored,
      lossyMemories: eps.filter(n => n.lossy).length, minFidelity: round(Math.min(1, ...eps.map(n => n.fid.rouge))), unrecoverable: this.verify().length,
      ...this.footprint(), budgetBytes: Number.isFinite(this.budgetBytes) ? this.budgetBytes : null, overBudget: !!this.meta.alert, alert: this.meta.alert,
      dictionary: this.meta.dict, lastReport: this.meta.lastReport ? { at: this.meta.lastReport.at, totals: this.meta.lastReport.totals, moves: this.meta.lastReport.moves } : null,
      meanRetention: eps.length ? round(eps.reduce((s, n) => s + retention(n, now), 0) / eps.length) : 0, embedder: this.embedder.name, summarizer: this.summarizer.name,
    };
  }
  /** Ids of memories that fail to decode or fail their integrity check (measured, not assumed). */
  verify(): string[] { const bad: string[] = []; for (const n of this.nodes.values()) { try { this.readRaw(n); } catch { bad.push(n.id); } } return bad; }
  graph() {
    const now = this.now();
    return { nodes: [...this.nodes.values()].map(n => ({ id: n.id, tier: n.tier, enc: algOf(n.enc), kind: n.kind === "schema" ? "semantic" : "episodic", lossy: !!n.lossy, schema: n.schema ?? null, rawBytes: n.rawBytes, createdAt: n.createdAt, label: n.keywords.slice(0, 3).join(" "), retention: round(retention(n, now)), salience: n.salience })),
      edges: [...this.edges].map(([k, w]) => { const [from, to] = k.split("|"); return { from, to, w: round(w) }; }) };
  }
}

export function algOf(e: Enc) { return e.enc === "z" ? e.codec + (e.dict ? "+dict" : "") : e.enc === "delta" ? `delta+${e.codec}` : e.enc === "resid" ? `resid+${e.codec}` : e.enc === "pack" ? `pack(${e.pack ?? "cold"}):${e.codec}:${e.inner}` : e.enc; }
const round = (x: number) => Math.round(x * 1000) / 1000;
const ratio = (a: number, b: number) => b ? round(a / b) : 0;
function best(c: Plan[]) { return c.sort((a, b) => a.cost - b.cost)[0]; }
export function renderReport(r: PassReport): string {
  const f = (a: Agg) => `${a.nodes}n ${a.rawBytes}→${a.storedBytes}B ${a.ratio}x ROUGE-L ${a.fidelity} (min ${a.minFidelity}) char ${a.charFidelity} sem ${a.semanticFidelity}`;
  const floor = (t: TierReport) => t.lossless ? "lossless" : `ROUGE-L≥${t.floor} char≥${t.charFloor} sem≥${t.semanticFloor}`;
  const lines = [`=== compression pass ${r.at}${r.dryRun ? " (DRY RUN — nothing written)" : ""} ===`,
    `moves: ${Object.entries(r.moves).map(([k, v]) => `${k} ${v}`).join(", ") || "none"} · schemas ${r.schemas.count} (+${r.schemas.created}, ${r.schemas.storedBytes}B) · dict ${r.dictionary ?? "-"}`,
    `tier | target (floor) | before | expected | after | algorithms`];
  for (const t of r.tiers) lines.push(`${t.tier.padEnd(4)} | ${t.target} (${floor(t)}) | ${f(t.before)} | ${f(t.expected)} | ${f(t.after)} | ${Object.entries(t.after.algorithms).map(([k, v]) => `${k}×${v}`).join(" ")}`);
  lines.push(`total stored ${r.totals.storedBefore}B → expected ${r.totals.storedExpected}B → actual ${r.totals.storedAfter}B (raw ${r.totals.rawBytes}B; ratio ${r.totals.ratioBefore}x → ${r.totals.ratioAfter}x)`);
  if (r.alert) lines.push(`⚠️ ${r.alert.message}`);
  return lines.join("\n");
}
