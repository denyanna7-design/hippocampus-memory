import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryEngine, retention, tierFor, DAY, Tier } from "../src/memory/engine.js";
import { extractiveSummary } from "../src/memory/text.js";
import { CODECS } from "../src/memory/rawstore.js";

function mk(o: { budgetBytes?: number; log?: (m: string) => void } = {}) {
  let t = Date.UTC(2026, 9, 14);
  const e = new MemoryEngine({ dir: mkdtempSync(join(tmpdir(), "mem-")), now: () => t, ...o });
  return { e, skip: (d: number) => { t += d * DAY; } };
}
const TRICKY = [
  "Plain ASCII memory.",
  "我家在南京，上学在新加坡国立大学。今天去了紫金山。",
  "Emoji 🧠✨ and combining marks: é (e\u0301), ZWJ 👩‍💻.",
  "Windows line endings\r\nand trailing spaces   \r\n\tand tabs\n\n",
  "",
  "Lorem ipsum dolor sit amet. ".repeat(200),
];
const LOG = (d: number) => `Daily standup ${d}. Yesterday I worked on the Alexa+ memory server: spreading activation, Hebbian edges and lossless storage tiers. Today I will write tests and record the demo video. Blockers: none. Mood: focused. Weather in Nanjing: cloudy, 18C. Note ${d * 7919 % 1000}.`;

test("power-law retention and tier thresholds", () => {
  const n = { stability: 1, lastAccess: 0 };
  assert.ok(Math.abs(retention(n, 9 * DAY) - 0.5) < 1e-9);
  assert.ok(retention({ stability: 4, lastAccess: 0 }, 9 * DAY) > retention(n, 9 * DAY));
  assert.deepEqual([0.9, 0.5, 0.2, 0.05].map(tierFor), [0, 1, 2, 3]);
});

test("spreading activation reaches associated memories not matching the cue", async () => {
  const { e } = mk();
  const a = await e.remember("My daughter Mia loves strawberries.");
  const b = await e.remember("Strawberries are on sale at the farmers market on Saturday.");
  await e.remember("The farmers market opens at 8am near the river park.");
  await e.remember("Quarterly tax filing is due in April.");
  const hits = await e.recall("What does Mia like?", 5);
  assert.equal(hits[0].id, a.id);
  assert.equal(hits.find(h => h.id === b.id)?.via, "spread");
  assert.ok(!hits.some(h => /tax/.test(h.text)));
});

test("Hebbian learning strengthens co-recalled edges", async () => {
  const { e } = mk();
  const a = await e.remember("Coffee with Alex at the blue cafe.");
  const b = await e.remember("Alex recommended the book Dune.");
  const w0 = e.weight(a.id, b.id);
  await e.recall("Alex"); await e.recall("Alex");
  assert.ok(e.weight(a.id, b.id) > w0);
});

test("salience slows decay; retrieval increases stability (spacing)", async () => {
  const { e, skip } = mk();
  const calm = await e.remember("Bought printer paper.", 0);
  const big = await e.remember("Got accepted to the National University of Singapore exchange!", 1);
  assert.ok(big.stability > calm.stability);
  skip(5); const s0 = big.stability; await e.recall("Singapore exchange");
  assert.ok(e.nodes.get(big.id)!.stability > s0);
});

test("every codec round-trips byte-exactly", () => {
  for (const c of CODECS.values()) for (const t of TRICKY) {
    const b = Buffer.from(t); assert.ok(c.decompress(c.compress(b)).equals(b), c.name);
  }
});

test("byte-exact round trip through every tier and back (hot→warm→cool→cold→warm→hot)", async () => {
  const { e } = mk();
  for (let d = 0; d < 4; d++) await e.remember(LOG(d)); // similar neighbours for delta/dedup
  const ids = [];
  for (const t of TRICKY) ids.push((await e.remember(t)).id);
  for (const tier of [1, 2, 3, 1, 0, 3, 2] as Tier[]) {
    for (const id of ids) await e.setTier(e.nodes.get(id)!, tier);
    ids.forEach((id, i) => assert.equal(e.text(id), TRICKY[i], `tier ${tier} ${id}`));
    ids.forEach(id => assert.equal(e.nodes.get(id)!.tier, tier));
  }
  // survives a restart
  const r = new MemoryEngine({ dir: e.dir, now: e.now });
  ids.forEach((id, i) => assert.ok(r.readRaw(r.nodes.get(id)!).equals(Buffer.from(TRICKY[i]))));
});

test("delta encoding / dedup beat standalone compression for near-duplicate memories", async () => {
  const { e } = mk();
  const base = await e.remember(LOG(1));
  const twin = await e.remember(LOG(1).replace("cloudy, 18C", "sunny, 21C"));
  await e.setTier(twin, 2);
  assert.ok(["delta", "chunks"].includes(twin.enc.enc), twin.enc.enc);
  const standalone = CODECS.get("brotli-11")!.compress(Buffer.from(e.text(twin.id))).length;
  assert.ok(e.perTier().cool.storedBytes < standalone, `${e.perTier().cool.storedBytes} < ${standalone}`);
  assert.equal(e.text(twin.id), LOG(1).replace("cloudy, 18C", "sunny, 21C"));
  // base can go cold without breaking its delta dependent
  await e.setTier(base, 3); assert.equal(e.text(twin.id), LOG(1).replace("cloudy, 18C", "sunny, 21C"));
});

test("chunk dedup stores a shared passage once", async () => {
  const { e } = mk();
  const shared = "This exact boilerplate paragraph about the hackathon rules appears in many of my notes. ";
  const a = await e.remember(shared + "First note: buy milk and eggs today.");
  const b = await e.remember(shared + "Second note: call grandma on Sunday evening.");
  const store = e.store as unknown as { candidates: (r: Buffer, t: "warm" | "cool") => { enc: { enc: string }; data?: Buffer; cost: number; newChunks?: [string, Buffer][] }[]; write: (id: string, c: unknown) => void };
  for (const n of [a, b]) {
    const c = store.candidates(e.readRaw(n), "cool").find(x => x.enc.enc === "chunks")!;
    if (n === b) assert.ok(c.newChunks!.length < (c.enc as unknown as { chunks: string[] }).chunks.length, "shared chunk reused");
    store.write(n.id, c); e.store.dropFile(n.id, n.enc); n.enc = c.enc as never;
  }
  assert.ok(e.text(a.id).startsWith(shared) && e.text(b.id).endsWith("Sunday evening."));
});

test("sleep runs multi-level compression over simulated months; nothing deleted, all byte-exact", async () => {
  const { e, skip } = mk();
  const texts = new Map<string, string>();
  const add = async (t: string, s = 0.3) => texts.set((await e.remember(t, s)).id, t);
  for (let d = 0; d < 20; d++) { await add(LOG(d), d === 5 ? 1 : 0.2); skip(1); }
  await add("Dr. Chen from NUS invited me to collaborate on neuromorphic chips research next spring.", 1);
  for (const t of TRICKY) await add(t, 0);
  const report: string[] = [];
  for (const days of [1, 7, 30, 90, 365]) {
    skip(days); await e.sleep();
    const st = e.stats();
    report.push(`+${days}d tiers=${JSON.stringify(st.tiers)} ratio=${st.compressionRatio} ` +
      Object.entries(st.perTier).map(([k, v]) => `${k}:${v.nodes}n ${v.ratio}x ${JSON.stringify(v.algorithms)}`).join(" | "));
  }
  console.log(report.join("\n"));
  for (const [id, t] of texts) assert.equal(e.text(id), t);
  assert.ok(e.nodes.size >= texts.size, "no memory deleted");
  const st = e.stats();
  assert.ok(st.tiers.cold > 0 && st.compressionRatio > 2, JSON.stringify(st));
  assert.equal(st.lossless, true);
});

test("over budget: pushes to colder tiers, then alerts (stats + log) instead of deleting", async () => {
  const logs: string[] = [];
  const { e } = mk({ budgetBytes: 1500, log: m => logs.push(m) });
  const texts: string[] = [];
  for (let d = 0; d < 6; d++) { texts.push(LOG(d)); await e.remember(LOG(d)); }
  const st = e.stats();
  assert.equal(st.overBudget, true);
  assert.ok(st.alert && /Nothing was deleted/.test(st.alert.message));
  assert.ok(logs.some(l => l.includes("ALERT")));
  assert.equal(logs.filter(l => l.includes("ALERT")).length, 1, "logged once, not spammed");
  assert.equal(e.nodes.size, 6);
  assert.ok([...e.nodes.values()].every(n => n.tier >= 2), "everything pushed to colder lossless tiers first");
  assert.deepEqual([...e.nodes.values()].sort((a, b) => a.createdAt - b.createdAt).map(n => e.text(n.id)).sort(), [...texts].sort());
  e.budgetBytes = 1e9; await e.enforceBudget();
  assert.equal(e.stats().overBudget, false, "alert clears once the user raises the budget");
});

test("under budget: no alert; tampering is detected", async () => {
  const { e } = mk({ budgetBytes: 1e6 });
  const n = await e.remember("Integrity matters.");
  assert.equal(e.stats().overBudget, false);
  writeFileSync(join(e.dir, "raw", readdirSync(join(e.dir, "raw"))[0]), "tampered");
  assert.throws(() => e.text(n.id), /integrity/);
});

test("extractive summary index layer is deterministic", () => {
  const t = "Rust is fast. Rust has a borrow checker that makes Rust memory safe. I ate lunch.";
  assert.equal(extractiveSummary(t), extractiveSummary(t));
});

test("sleep merges similar episodes into a semantic memory but keeps the episodes", async () => {
  const { e } = mk();
  const a = await e.remember("Mia had swimming practice at the pool on Monday.");
  await e.remember("Mia had swimming practice at the pool on Wednesday.");
  await e.remember("Paid the electricity bill.");
  const r = await e.sleep();
  assert.equal(r.semanticCreated.length, 1);
  assert.equal(e.nodes.get(r.semanticCreated[0])!.sources!.length, 2);
  assert.equal(e.text(a.id), "Mia had swimming practice at the pool on Monday.");
  assert.equal(new MemoryEngine({ dir: e.dir, now: e.now }).nodes.size, 4);
});
