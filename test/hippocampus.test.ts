// Focused checks for the five memory-engine changes: time-aware edge decay, dynamic spread,
// schema near-dual-check staging, ROUGE-L+char keep gates, and cool/cold semantic floors.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryEngine, P, DAY, TIERS, decayEdgeWeight, spreadActivation, schemaVerdict } from "../src/memory/engine.js";
import { plan, apply, diff, rougeL, charSim, schemaSecondScore } from "../src/memory/residual.js";
import { cosine, termFreq } from "../src/memory/text.js";

const localTf = (t: string) => { const tf = termFreq(t); for (const k in tf) tf[k] = 1 + Math.log(tf[k]); return tf; };
function mk() {
  let t = Date.UTC(2026, 9, 1);
  const e = new MemoryEngine({ dir: mkdtempSync(join(tmpdir(), "hip-")), now: () => t, log: () => {} });
  return { e, skip: (d: number) => { t += d * DAY; } };
}

test("edge weights: cap, slow time falloff, soft floor (not a 5% cliff)", async () => {
  const w = 0.8;
  const d0 = decayEdgeWeight(w, 0);
  const d1 = decayEdgeWeight(w, DAY);
  const d30 = decayEdgeWeight(w, 30 * DAY);
  const d365 = decayEdgeWeight(w, 365 * DAY);
  assert.equal(d0, w);
  assert.equal(decayEdgeWeight(1.4, 0), P.edgeCap);
  assert.ok(d1 < w && d1 > w * 0.95, `one day ${d1} should fall slower than a flat 5% step`);
  assert.ok(d30 < d1 && d30 > P.edgeFloor);
  assert.ok(d365 < d30 && d365 > P.edgeFloor, "a year approaches the floor without landing on it");
  const rare = decayEdgeWeight(0.12, DAY);
  assert.ok(rare > 0.1 && rare < 0.12, `rare edge ${rare} must not vanish or snap to ${P.edgeFloor}`);
  const { e, skip } = mk();
  const a = await e.remember("My daughter Mia loves strawberries.");
  const b = await e.remember("Strawberries are on sale at the farmers market on Saturday.");
  const w0 = e.weight(a.id, b.id);
  e.setWeight(a.id, b.id, 5);
  assert.equal(e.weight(a.id, b.id), P.edgeCap);
  e.setWeight(a.id, b.id, w0);
  await e.sleep();
  assert.equal(e.weight(a.id, b.id), w0, "no elapsed time ⇒ no decay");
  skip(1); await e.sleep();
  const w1 = e.weight(a.id, b.id);
  assert.ok(w1 < w0 && w1 > w0 * 0.95 && w1 > P.edgeFloor, `after 1 day ${w1} from ${w0}`);
  skip(30); await e.sleep();
  const w30 = e.weight(a.id, b.id);
  assert.ok(w30 > 0 && w30 < w1 && w30 > P.edgeFloor);
  assert.equal(e.episodes().length, 2, "decay never deletes memories");
});

test("spreading activation continues past 2 hops while additions stay above epsilon, and stops at the ceiling", () => {
  const chain = (n: number, w: number) => (id: string): [string, number][] => {
    const i = id.charCodeAt(0) - 97;
    const out: [string, number][] = [];
    if (i > 0) out.push([String.fromCharCode(97 + i - 1), w]);
    if (i + 1 < n) out.push([String.fromCharCode(97 + i + 1), w]);
    return out;
  };
  const act = new Map<string, number>([["a", 1]]);
  const hops = spreadActivation(act, chain(6, 1), () => true, { hopDecay: 0.7, epsilon: 0.01, maxHops: 8 });
  assert.ok(hops > 2 && hops < 8, `took ${hops} hops`);
  assert.ok((act.get("e") ?? 0) > 0.1, "a node past hop 2 stays above epsilon");
  const weak = new Map<string, number>([["a", 1]]);
  const weakHops = spreadActivation(weak, chain(4, 0.02), () => true, { hopDecay: 0.7, epsilon: 0.01, maxHops: 8 });
  assert.equal(weakHops, 1, "the next hop's addition is under epsilon");
  assert.equal(weak.has("c"), false);
  const long = new Map<string, number>([["a", 1]]);
  const capped = spreadActivation(long, chain(20, 1), () => true, { hopDecay: 0.99, epsilon: 0.001, maxHops: 3 });
  assert.equal(capped, 3, "a live frontier still stops at the hop ceiling");
  assert.equal(long.has("d"), true);
  assert.equal(long.has("e"), false);
});

test("recall spreads along a chain farther than a fixed 2-hop walk", async () => {
  const { e } = mk();
  const texts = ["alpha unique cue token zzzzunique", "beta quarry stone", "gamma quarry stone", "delta quarry stone", "epsilon quarry stone"];
  const ids: string[] = [];
  for (const t of texts) ids.push((await e.remember(t, 0.2)).id);
  e.edges.clear();
  for (let i = 0; i < ids.length - 1; i++) e.setWeight(ids[i], ids[i + 1], 1);
  const hits = await e.recall("zzzzunique", 5);
  const far = hits.find(h => h.id === ids[4]);
  assert.ok(far, "the 4-hop memory is recalled");
  assert.equal(far!.via, "spread");
  assert.ok(hits.some(h => h.id === ids[0]));
});

test("schema link is permanent only after both checks; near-misses stay provisional across sleeps", () => {
  assert.equal(schemaVerdict(0.9, 0.9), "permanent");
  assert.equal(schemaVerdict(0.9, 0.15), "provisional");
  assert.equal(schemaVerdict(0.3, 0.15), "provisional");
  assert.equal(schemaVerdict(0.3, 0.05), "reject");
  assert.equal(schemaVerdict(0.1, 0.05), "reject");
});

test("schema staging: dual-check members stick, a near-miss is re-checked and not promoted after 3 sleeps", async () => {
  const { e } = mk();
  const noise = Array.from({ length: 80 }, (_, i) => String.fromCodePoint(0x1F300 + i)).join(" ");
  const texts = [
    "Weekly standup notes: billing service retry bug, review Priya pull request, blockers none, mood focused.",
    "Weekly standup notes: billing service retry bug, review Priya pull request, blockers none, mood calm.",
    "Weekly standup notes: billing service retry bug, review Priya pull request, blockers none, mood tired.",
  ];
  const near = "weeklies standups noted: billed services retries bugs, reviewed Priyas pulled requests, blocker nones, moods focusing. " + noise;
  const unrelated = "Quarterly tax filing is due in April and the passport office is closed.";
  const ids: string[] = [];
  for (const t of texts) ids.push((await e.remember(t, 0.2)).id);
  const nearId = (await e.remember(near, 0.2)).id;
  const otherId = (await e.remember(unrelated, 0.2)).id;
  const med = texts[0];
  assert.ok(schemaSecondScore(med, near) < P.schemaLex, "fixture is a real second-check miss");
  assert.ok(cosine(localTf(med), localTf(near)) >= P.schemaSim);
  await e.sleep();
  const schema = [...e.nodes.values()].find(n => n.kind === "schema");
  assert.ok(schema, "dual-check cluster formed a schema");
  for (const id of ids) {
    assert.equal(e.nodes.get(id)!.schema, schema!.id);
    assert.equal(e.nodes.get(id)!.schemaHold, undefined);
  }
  assert.equal(e.nodes.get(nearId)!.schema, undefined);
  assert.equal(e.nodes.get(nearId)!.schemaHold, schema!.id);
  assert.equal(schema!.members!.includes(nearId), false);
  assert.equal(e.nodes.get(otherId)!.schema, undefined);
  assert.equal(e.nodes.get(otherId)!.schemaHold, undefined);
  for (let i = 0; i < 3; i++) await e.sleep();
  assert.equal(e.nodes.get(nearId)!.schema, undefined, "three misses do not become permanent");
  assert.equal(e.nodes.get(nearId)!.schemaHold, schema!.id, "the near-miss stays re-evaluable");
  assert.equal(e.episodes().length, 5);
  assert.ok(!e.nodes.get(nearId)!.lossy);
});

test("keep counts need both ROUGE-L and char similarity, not ROUGE-L alone", () => {
  const schema = "a b c d e f g h i j k l m n o p";
  const text = schema.replace(/ /g, "   ");
  const all = diff(schema, text).sort((x, y) => y.s - x.s || x.p - y.p);
  let rougeOnly = all.length;
  for (let k = 0; k <= all.length; k++) if (rougeL(text, apply(schema, all.slice(0, k))) >= 0.9) { rougeOnly = k; break; }
  const early = apply(schema, all.slice(0, rougeOnly));
  assert.ok(charSim(text, early) < 0.9, "the rouge-only keep misses the char floor");
  const p = plan(schema, text, [0.9, 0.65]);
  assert.ok(p.keeps[0] > rougeOnly);
  assert.ok(p.fid[0].rouge >= 0.9 && p.fid[0].char >= 0.9);
  assert.ok(p.fid[1].rouge >= 0.65 && p.fid[1].char >= 0.65);
  assert.ok(p.keeps[1] <= p.keeps[0]);
});

test("cool/cold semantic floor uses the local embedder and can force a larger keep", () => {
  const schema = "alpha beta gamma delta";
  const text = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda";
  const sim = (hyp: string) => cosine(localTf(text), localTf(hyp));
  const loose = plan(schema, text, [{ rouge: 0.2, char: 0.2 }]);
  const tight = plan(schema, text, [{ rouge: 0.2, char: 0.2, semantic: 0.95 }], sim);
  assert.ok(loose.keeps[0] < tight.keeps[0], `semantic keep ${tight.keeps[0]} vs surface ${loose.keeps[0]}`);
  assert.ok((tight.fid[0].semantic ?? 0) >= 0.95);
  assert.ok(sim(schema) < 0.95, "the schema alone is under the semantic floor");
});

test("lossy cool/cold encodes clear char and local-embedding floors without calling a remote embedder", async () => {
  let embeds = 0;
  let t = Date.UTC(2026, 9, 1);
  const e = new MemoryEngine({
    dir: mkdtempSync(join(tmpdir(), "hip-sem-")), now: () => t, log: () => {},
    embedder: { name: "fixed", async embed() { embeds++; return { z: 1 }; } },
  });
  const orig = new Map<string, string>();
  for (let i = 0; i < 4; i++) {
    const text = `Lunch: dumplings at the canteen, cost ${20 + i} yuan. Ate with ${["Priya", "Chen", "Sofia", "Marcus"][i]}.`;
    orig.set((await e.remember(text, 0.2)).id, text);
  }
  const afterRemember = embeds;
  t += 400 * DAY;
  await e.sleep();
  assert.equal(embeds, afterRemember, "semantic gate stays on the local embedder");
  const lossy = [...orig.keys()].map(id => e.nodes.get(id)!).filter(n => n.lossy);
  assert.ok(lossy.length > 0, "similar lunches became lossy");
  for (const n of lossy) {
    const got = e.text(n.id);
    const tier = TIERS[n.tier];
    const sem = cosine(localTf(orig.get(n.id)!), localTf(got));
    assert.ok(n.tier >= 2);
    assert.ok(n.fid.rouge >= tier.floor - 1e-9);
    assert.ok(n.fid.char >= tier.charFloor - 1e-9, `char ${n.fid.char} < ${tier.charFloor}`);
    assert.ok((n.fid.semantic ?? 0) >= tier.semanticFloor - 1e-9, `semantic ${n.fid.semantic} < ${tier.semanticFloor}`);
    assert.ok(Math.abs((n.fid.semantic ?? 0) - sem) < 1e-3, "stored semantic fidelity matches the local embedder");
    assert.notEqual(n.fid.semantic, 1, "a constant remote vector would have scored 1");
  }
  assert.equal(e.episodes().length, orig.size);
});
