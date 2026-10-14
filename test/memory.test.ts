import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryEngine, retention, tierFor, DAY } from "../src/memory/engine.js";
import { extractiveSummary } from "../src/memory/text.js";

function mk() { let t = Date.UTC(2026, 9, 14); const e = new MemoryEngine({ dir: mkdtempSync(join(tmpdir(), "mem-")), now: () => t }); return { e, skip: (d: number) => { t += d * DAY; } }; }

test("power-law retention and tier thresholds", () => {
  const n = { stability: 1, lastAccess: 0 };
  assert.equal(retention(n, 0), 1);
  assert.ok(Math.abs(retention(n, 9 * DAY) - 0.5) < 1e-9);
  assert.ok(retention({ stability: 4, lastAccess: 0 }, 9 * DAY) > retention(n, 9 * DAY), "higher stability decays slower");
  assert.deepEqual([0.9, 0.5, 0.2, 0.05].map(tierFor), [0, 1, 2, 3]);
});

test("spreading activation reaches associated memories not matching the cue", async () => {
  const { e } = mk();
  const a = await e.remember("My daughter Mia loves strawberries.");
  const b = await e.remember("Strawberries are on sale at the farmers market on Saturday.");
  const c = await e.remember("The farmers market opens at 8am near the river park.");
  await e.remember("Quarterly tax filing is due in April.");
  const hits = await e.recall("What does Mia like?", 5);
  const ids = hits.map(h => h.id);
  assert.equal(ids[0], a.id);
  assert.ok(ids.includes(b.id), "1 hop via 'strawberries'");
  assert.equal(hits.find(h => h.id === b.id)!.via, "spread");
  assert.ok(!hits.some(h => /tax/.test(h.text)), "unrelated memory stays below threshold");
  void c;
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
  skip(5);
  const s0 = big.stability; await e.recall("Singapore exchange"); assert.ok(e.nodes.get(big.id)!.stability > s0);
});

test("compression tiers drop data progressively and save bytes", async () => {
  const { e } = mk();
  const n = await e.remember("We hiked the Purple Mountain in Nanjing. The trail was steep and muddy after rain. At the top we ate osmanthus cakes and watched the sunset over the city. Luke forgot his water bottle.");
  const b0 = e.bytes(n);
  await e.compress(n, 1); assert.equal(n.text, undefined); assert.ok(n.summary && n.summary.length < 200); const b1 = e.bytes(n);
  await e.compress(n, 2); assert.equal(n.summary, undefined); assert.ok(n.keywords.length <= 5); const b2 = e.bytes(n);
  await e.compress(n, 3); assert.ok(n.keywords.length <= 3); const b3 = e.bytes(n);
  assert.ok(b0 > b1 && b1 > b2 && b2 >= b3, `${b0} ${b1} ${b2} ${b3}`);
  assert.ok(e.stats().bytesSaved > 0);
});

test("extractive summarizer is deterministic and shorter", () => {
  const t = "Rust is fast. Rust has a borrow checker that makes Rust memory safe. I ate lunch.";
  assert.equal(extractiveSummary(t), extractiveSummary(t));
  assert.ok(extractiveSummary(t).length < t.length);
});

test("time-skip scenario: gradual compression, rehearsal protects, reconstruction from neighbours", async () => {
  const { e, skip } = mk();
  const trip = await e.remember("Flew to Shanghai for the AI conference. Gave a talk on agent memory. Met Dr. Chen from NUS who works on neuromorphic chips.", 0.3);
  const chen = await e.remember("Dr. Chen from NUS invited me to collaborate on neuromorphic chips research next spring.", 0.9);
  const lunch = await e.remember("Lunch was a forgettable sandwich at the conference hall.", 0);
  const log: string[] = [];
  for (const day of [1, 3, 7, 14, 30, 60, 120, 365]) {
    skip(day - (log.length ? [1, 3, 7, 14, 30, 60, 120, 365][log.length - 1] : 0));
    if (day === 14) await e.recall("neuromorphic chips collaboration"); // rehearsal
    await e.decayAll();
    if (day === 120) {
      assert.equal(e.nodes.get(lunch.id)!.tier, 3, "trivial memory fades to a trace");
      assert.ok(e.nodes.get(chen.id)!.tier < e.nodes.get(trip.id)!.tier, "salient + rehearsed memory stays more detailed");
      const r = await e.inspect(trip.id); assert.equal(r!.rendered.reconstructed, true);
      assert.match(r!.rendered.text, /reconstructed.*related:/, "reconstructed from linked neighbour summary");
      console.log("d120 reconstruction:", r!.rendered.text);
    }
    log.push(`d${day}: trip L${e.nodes.get(trip.id)!.tier} chen L${e.nodes.get(chen.id)!.tier} lunch L${e.nodes.get(lunch.id)!.tier}`);
  }
  console.log(log.join("\n"));
  console.log("d365 stats:", JSON.stringify(e.stats()));
  assert.ok(e.stats().savedPct > 25, "forgetting-as-compression saves storage");
  assert.ok(e.nodes.has(lunch.id), "nothing is deleted");
});

test("sleep merges similar episodes into a semantic memory and persists to disk", async () => {
  const { e } = mk();
  await e.remember("Mia had swimming practice at the pool on Monday.");
  await e.remember("Mia had swimming practice at the pool on Wednesday.");
  await e.remember("Paid the electricity bill.");
  const r = await e.sleep();
  assert.equal(r.semanticCreated.length, 1);
  const sem = e.nodes.get(r.semanticCreated[0])!;
  assert.equal(sem.kind, "semantic"); assert.equal(sem.sources!.length, 2);
  const reloaded = new MemoryEngine({ dir: e.dir, now: e.now });
  assert.equal(reloaded.nodes.size, 4); assert.equal(reloaded.edges.size, e.edges.size);
});
