import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryEngine, retention, tierFor, DAY, Tier, TIERS, SALIENT } from "../src/memory/engine.js";
import { CODECS, hasZstd, trainDictionary, versions } from "../src/memory/codecs.js";
import { plan, apply, diff, rougeL, xtok } from "../src/memory/residual.js";
import { corpus } from "../src/demo-corpus.js";

function mk(o: { budgetBytes?: number; log?: (m: string) => void } = {}) {
  let t = Date.UTC(2026, 9, 1);
  const e = new MemoryEngine({ dir: mkdtempSync(join(tmpdir(), "mem-")), now: () => t, ...o });
  return { e, skip: (d: number) => { t += d * DAY; } };
}
const TRICKY = ["Plain ASCII memory.", "我家在南京，上学在新加坡国立大学。今天去了紫金山。", "Emoji 🧠✨ é (e\u0301) 👩‍💻.", "CRLF\r\nand trailing   \r\n\ttabs\n\n", ""];

test("environment: Node ≥ 22.15 with zstd, plus lz4 and lzma codecs", () => {
  console.log(JSON.stringify(versions()));
  assert.ok(hasZstd, "zstd available");
  for (const c of ["zstd-3", "zstd-19", "lz4", "lzma-9", "brotli-11"]) assert.ok(CODECS.has(c), c);
});

test("every codec (and zstd+trained dict) round-trips byte-exactly", () => {
  const dict = trainDictionary(corpus(20).map(m => m.text))!; assert.ok(dict && dict.length > 100);
  for (const c of CODECS.values()) for (const t of [...TRICKY, ...corpus(3).map(m => m.text)]) {
    const b = Buffer.from(t); assert.ok(c.decompress(c.compress(b)).equals(b), c.name);
    if (c.dict) assert.ok(c.decompress(c.compress(b, dict), dict).equals(b), c.name + "+dict");
  }
  const sample = Buffer.from(corpus(30)[25].text); const z = CODECS.get("zstd-19")!;
  assert.ok(z.compress(sample, dict).length < z.compress(sample).length, "trained dictionary helps short memories");
});

test("residual diff is exact when all hunks kept; fidelity floors honoured", () => {
  const c = corpus(10).map(m => m.text).filter(t => t.startsWith("Standup"));
  for (const t of [...c, ...TRICKY]) { assert.equal(xtok(t).join(""), t); assert.equal(apply(c[0], diff(c[0], t)), t); }
  const p = plan(c[0], c[3], [0.9, 0.65]);
  assert.ok(p.fid[0].rouge >= 0.9 && p.fid[1].rouge >= 0.65 && p.keeps[1] <= p.keeps[0]);
  assert.equal(rougeL("a b c", "a b c"), 1);
});

test("retention, spreading activation, Hebbian, spacing", async () => {
  assert.deepEqual([0.9, 0.5, 0.2, 0.05].map(tierFor), [0, 1, 2, 3]);
  assert.ok(Math.abs(retention({ stability: 1, lastAccess: 0 }, 9 * DAY) - 0.5) < 1e-9);
  const { e, skip } = mk();
  const a = await e.remember("My daughter Mia loves strawberries.");
  const b = await e.remember("Strawberries are on sale at the farmers market on Saturday.");
  await e.remember("Quarterly tax filing is due in April.");
  const w0 = e.weight(a.id, b.id); skip(3);
  const hits = await e.recall("What does Mia like?");
  assert.equal(hits[0].id, a.id); assert.equal(hits.find(h => h.id === b.id)?.via, "spread");
  assert.ok(!hits.some(h => /tax/.test(h.text))); assert.ok(e.weight(a.id, b.id) > w0);
  assert.ok(e.nodes.get(a.id)!.stability > 1.9);
});

test("lossless tiers: byte-exact through hot→warm→cool→cold→warm (no schema ⇒ never lossy)", async () => {
  const { e } = mk();
  const ids: string[] = []; for (const t of TRICKY) ids.push((await e.remember(t, 0)).id);
  for (const tier of [1, 2, 3, 1, 0, 3] as Tier[]) {
    const force: Record<string, Tier> = {}; ids.forEach(id => (force[id] = tier));
    await e.pass({ force });
    ids.forEach((id, i) => { assert.equal(e.text(id), TRICKY[i]); assert.equal(e.nodes.get(id)!.tier, tier); assert.equal(e.nodes.get(id)!.lossy, false); });
  }
  const r = new MemoryEngine({ dir: e.dir, now: e.now });
  ids.forEach((id, i) => assert.equal(r.text(id), TRICKY[i]));
});

// ---- realistic corpus: 60 days lived, then a year of sleeps ----
async function live() {
  const { e, skip } = mk(); const all = corpus(60); const orig = new Map<string, { text: string; salience: number }>();
  let day = 0;
  for (const m of all) { while (day < m.day) { await e.sleep(); skip(1); day++; } orig.set((await e.remember(m.text, m.salience)).id, m); }
  const reports = [];
  for (const d of [7, 30, 90, 180, 365]) { skip(d); reports.push(await e.sleep()); }
  return { e, orig, reports };
}
const lived = live();

test("graded tiers on realistic corpus: fidelity floors, salient lossless, never unrecoverable", async () => {
  const { e, orig } = await lived;
  for (const [id, m] of orig) {
    const n = e.nodes.get(id)!; const got = e.text(id); // never throws ⇒ always recoverable
    assert.ok(got.length > 0 || m.text === "");
    const f = rougeL(m.text, got);
    assert.ok(Math.abs(f - n.fid.rouge) < 1e-3, "recorded fidelity is the real fidelity");
    assert.ok(f >= TIERS[n.tier].floor - 1e-9, `tier ${n.tier} floor ${TIERS[n.tier].floor} got ${f}`);
    if (!n.lossy) assert.equal(got, m.text);
    if (m.salience >= SALIENT) assert.equal(got, m.text, "high-salience memories stay byte-exact");
  }
  assert.equal(e.stats().unrecoverable, 0);
  assert.ok(e.episodes().length === orig.size, "nothing deleted");
});

test("tier table: measured ratios on realistic corpus", async () => {
  const { e, reports } = await lived;
  const last = reports[reports.length - 1];
  console.log(reports.map(r => r.text).join("\n\n"));
  const st = e.stats(); console.log(JSON.stringify(st.tiers));
  const coldT = st.tiers[3]; assert.ok(coldT.nodes > 0 && coldT.ratio >= TIERS[3].target[0], `cold ratio ${coldT.ratio}`);
  // every tier that was populated during the run hit at least its lower target at some pass
  for (let i = 1; i < 4; i++) { const best = Math.max(...reports.map(r => r.tiers[i].after.nodes >= 5 ? r.tiers[i].after.ratio : 0)); assert.ok(best >= TIERS[i].target[0], `${TIERS[i].name} best ${best} < ${TIERS[i].target[0]}`); }
  assert.ok(st.compressionRatio > 5, `overall ${st.compressionRatio}`);
  assert.ok(last.totals.storedAfter <= last.totals.storedBefore);
});

test("sleep report format + log file + dry-run preview writes nothing", async () => {
  const { e, skip } = mk();
  for (const m of corpus(14)) await e.remember(m.text, m.salience);
  await e.sleep(); skip(40);
  const before = readdirSync(join(e.dir, "raw")).sort().join();
  const pv = await e.sleep({ dryRun: true });
  assert.equal(readdirSync(join(e.dir, "raw")).sort().join(), before, "dry run wrote nothing");
  assert.equal(pv.dryRun, true); assert.match(pv.text, /DRY RUN/);
  const r = await e.sleep();
  for (const t of r.tiers) for (const k of ["before", "expected", "after"] as const) for (const f of ["nodes", "rawBytes", "storedBytes", "ratio", "fidelity", "algorithms"]) assert.ok(f in t[k], `${t.tier}.${k}.${f}`);
  assert.ok(r.tiers.every(t => /x$/.test(t.target) && typeof t.floor === "number" && typeof t.movedIn === "number"));
  assert.ok(Object.keys(r.moves).length > 0);
  for (let i = 0; i < 4; i++) assert.ok(Math.abs(pv.tiers[i].expected.storedBytes - r.tiers[i].after.storedBytes) <= Math.max(64, r.tiers[i].after.storedBytes * 0.3), "preview ≈ actual");
  assert.match(readFileSync(join(e.dir, "compaction.log"), "utf8"), /compression pass[\s\S]*tier \| target/);
  assert.ok(e.stats().lastReport);
});

test("over budget: deepest allowed tiers, then alert (no deletion, logged once, clears)", async () => {
  const logs: string[] = []; const { e } = mk({ budgetBytes: 3000, log: m => logs.push(m) });
  const texts = corpus(10).map(m => m.text);
  for (const t of texts) await e.remember(t, 0.2);
  const st = e.stats();
  assert.equal(st.overBudget, true); assert.match(st.alert!.message, /Nothing was deleted/);
  assert.equal(logs.filter(l => l.includes("ALERT")).length, 1);
  assert.equal(e.episodes().length, texts.length);
  assert.ok(e.episodes().every(n => n.tier >= 2));
  e.episodes().forEach(n => assert.ok(e.text(n.id).length > 0));
  e.budgetBytes = 1e9; await e.enforceBudget(); assert.equal(e.stats().overBudget, false);
});

test("tampering detected; schema memories pinned lossless", async () => {
  const { e } = await lived;
  for (const s of [...e.nodes.values()].filter(n => n.kind === "schema")) assert.ok(!s.lossy && s.tier <= 1);
  const { e: e2 } = mk(); const n = await e2.remember("Integrity matters.");
  writeFileSync(join(e2.dir, "raw", readdirSync(join(e2.dir, "raw"))[0]), "x"); assert.throws(() => e2.text(n.id), /integrity/);
});

test("compact index: small vs content, reloads with identical recall and byte-exact text", async () => {
  const { e, skip } = mk();
  const dir = e.dir; const items = corpus(120);
  for (const m of items) { await e.remember(m.text, m.salience); skip(0.25); }
  await e.sleep(); skip(40); await e.sleep(); skip(40); await e.sleep();
  e.flush(); const f = e.footprint(); const st = e.stats();
  console.log(JSON.stringify(f));
  assert.equal(f.totalBytes, f.contentBytes + f.dictionaryBytes + f.indexBytes);
  assert.ok(f.indexBytes < st.rawBytes / 2, `index ${f.indexBytes} B vs raw ${st.rawBytes} B`);
  assert.ok(f.indexBytes / e.nodes.size < 80, `index ${Math.round(f.indexBytes / e.nodes.size)} B per memory`);
  assert.ok(f.dictionaryBytes <= Math.max(1024, st.rawBytes / 6) + 64, `dictionaries ${f.dictionaryBytes} B`);
  assert.deepEqual(readdirSync(dir).filter(x => /^(nodes|edges\.json|meta\.json)$/.test(x)), []);
  const e2 = new MemoryEngine({ dir, now: e.now });
  assert.equal(e2.nodes.size, e.nodes.size);
  for (const [id] of e.nodes) assert.equal(e2.text(id), e.text(id)); // integrity tags verified on every read
  const lossless = [...e.nodes.values()].filter(n => !n.lossy && n.kind === "episodic").slice(0, 10);
  for (const n of lossless) assert.equal(e2.text(n.id), items.find(m => m.text === e.text(n.id))?.text);
  const cue = "Grandpa hospital checkup";
  assert.deepEqual((await e2.recall(cue)).map(h => h.id).slice(0, 1), (await e.recall(cue)).map(h => h.id).slice(0, 1));
});
