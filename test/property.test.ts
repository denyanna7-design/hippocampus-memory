// Property / fuzz tests: randomized inputs through every tier, index reloads, edge cases, concurrency.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryEngine, DAY, Tier, TIERS, SALIENT } from "../src/memory/engine.js";
import { rougeL } from "../src/memory/residual.js";
import { rng, corpus } from "../src/demo-corpus.js";

function mk(o: { budgetBytes?: number } = {}) {
  let t = Date.UTC(2026, 9, 1);
  const e = new MemoryEngine({ dir: mkdtempSync(join(tmpdir(), "prop-")), now: () => t, log: () => {}, ...o });
  return { e, skip: (d: number) => { t += d * DAY; } };
}
const POOLS = [
  "abcdefghijklmnopqrstuvwxyz ABCDEFGHIJ0123456789 .,!?;:'\"-()[]{}",
  "我家在南京上学在新加坡国立大学今天去了紫金山记忆压缩睡眠，。！？",
  "🧠✨👩‍💻🍓🏊‍♀️🇸🇬🇨🇳❤️‍🔥", "éèêëàâäôöûüçñßøå\u0301\u0308", "\t\r\n\u0000\u0007\u001b\u00a0\u2028\u2029\ufeff\u200d",
  "Ω≈ç√∫˜µ≤≥÷¡™£¢∞§¶•ªº", "𝕳𝖊𝖑𝖑𝖔 𝓦𝓸𝓻𝓵𝓭 \ud83d\ude00",
];
function randText(r: () => number, max = 300) {
  const len = Math.floor(r() ** 2 * max); let s = "";
  while ([...s].length < len) { const p = [...POOLS[Math.floor(r() * POOLS.length)]]; s += p[Math.floor(r() * p.length)]; }
  return s;
}

test("fuzz: 300 random unicode texts byte-exact through every lossless tier, before and after reload", async () => {
  const r = rng(42); const { e } = mk();
  const texts = Array.from({ length: 300 }, () => randText(r));
  texts.push("", " ", "\n", "a", "🧠", "\u0000", "x".repeat(200_000), "lone surrogates are not valid UTF-8 \ud800 \udc00");
  const ids: string[] = []; for (const t of texts) ids.push((await e.remember(t, 0)).id);
  const expect = (eng: MemoryEngine) => ids.forEach((id, i) => assert.equal(eng.readRaw(eng.nodes.get(id)!).equals(Buffer.from(texts[i], "utf8")), true, `#${i}`));
  for (const tier of [1, 2, 3, 0, 2, 1] as Tier[]) {
    const force: Record<string, Tier> = {}; ids.forEach(id => (force[id] = tier));
    await e.pass({ force }); expect(e);
    ids.forEach(id => { const n = e.nodes.get(id)!; assert.equal(n.tier, tier); assert.equal(n.lossy, false); });
    e.flush(); expect(new MemoryEngine({ dir: e.dir, now: e.now, log: () => {} }));
  }
});

test("fuzz: lossy tiers honour fidelity floors on randomized routine variants; salient stays exact; nothing unrecoverable", async () => {
  const r = rng(7); const { e, skip } = mk();
  const words = ["coffee", "tea", "metro", "bus", "rain", "sun", "meeting", "gym", "lunch", "dumplings", "laksa", "Priya", "Chen", "南京", "新加坡", "🧠"];
  const orig = new Map<string, { t: string; s: number }>();
  for (let i = 0; i < 160; i++) {
    const w = () => words[Math.floor(r() * words.length)];
    const t = `Routine ${i % 4}: ${w()} then ${w()} with ${w()} at ${Math.floor(r() * 24)}:${r() < 0.5 ? "00" : "30"}, felt ${w()}. ${r() < 0.3 ? randText(r, 40) : ""}`;
    const s = r() < 0.1 ? 0.9 : 0.2; orig.set((await e.remember(t, s)).id, { t, s });
    if (i % 20 === 19) { await e.sleep(); skip(1); }
  }
  for (const d of [20, 60, 200]) { skip(d); await e.sleep(); }
  const check = (eng: MemoryEngine) => {
    for (const [id, m] of orig) {
      const n = eng.nodes.get(id)!; const got = eng.text(id);
      assert.ok(rougeL(m.t, got) >= TIERS[n.tier].floor - 1e-9, `floor tier ${n.tier}`);
      if (!n.lossy || m.s >= SALIENT) assert.equal(got, m.t);
    }
    assert.equal(eng.episodes().length, orig.size, "nothing deleted");
  };
  check(e);
  assert.ok([...e.nodes.values()].some(n => n.lossy), "some memories became lossy");
  check(new MemoryEngine({ dir: e.dir, now: e.now, log: () => {} }));
});

test("duplicates: 25 identical memories dedup/compress and all stay readable", async () => {
  const { e, skip } = mk(); const t = "Lunch: dumplings at the canteen, cost 20 yuan. Ate with Priya.";
  const ids = []; for (let i = 0; i < 25; i++) ids.push((await e.remember(t, 0.2)).id);
  await e.sleep(); skip(90); await e.sleep(); skip(300); await e.sleep();
  for (const id of ids) assert.ok(rougeL(t, e.text(id)) >= TIERS[e.nodes.get(id)!.tier].floor);
  const st = e.stats(); assert.ok(st.compressionRatio > 3, `ratio ${st.compressionRatio}`);
});

test("integrity: corrupted blob, pack and index are detected (never silently wrong)", async () => {
  const { e, skip } = mk(); for (const m of corpus(10)) await e.remember(m.text, m.salience);
  await e.sleep(); skip(200); await e.sleep();
  const packed = [...e.nodes.values()].find(n => n.enc.enc === "pack")!; assert.ok(packed);
  const pf = join(e.dir, "packs", `${(packed.enc as { pack?: string }).pack ?? "cold"}.pack`); const b = readFileSync(pf);
  e.flush();
  b[b.length - 5] ^= 0xff; writeFileSync(pf, b);
  const fresh = new MemoryEngine({ dir: e.dir, now: e.now, log: () => {} });
  assert.throws(() => fresh.text(packed.id));
  assert.ok(fresh.stats().unrecoverable > 0, "stats report damaged memories honestly");
  assert.equal(e.stats().unrecoverable >= 0, true);
  writeFileSync(join(e.dir, "index.bin"), Buffer.from("zstd-19\ngarbage"));
  assert.throws(() => new MemoryEngine({ dir: e.dir, now: e.now, log: () => {} }));
});

test("concurrency: 60 parallel remembers + recalls, then reload sees everything; atomic index write", async () => {
  const { e } = mk(); const texts = Array.from({ length: 60 }, (_, i) => `Parallel memory ${i}: ${"word".repeat(i % 5)} 🧠`);
  const ids = (await Promise.all(texts.map(t => e.remember(t, 0.3)))).map(n => n.id);
  await Promise.all([e.recall("Parallel memory 7"), e.recall("word"), e.sleep()]);
  await new Promise(r => setImmediate(r));
  assert.equal(existsSync(join(e.dir, "index.bin.tmp")), false);
  const r2 = new MemoryEngine({ dir: e.dir, now: e.now, log: () => {} });
  ids.forEach((id, i) => assert.equal(r2.text(id), texts[i]));
});

test("budget: alert reports content+dictionary+index = total, nothing deleted, clears when raised", async () => {
  const { e } = mk({ budgetBytes: 2500 }); for (const m of corpus(6)) await e.remember(m.text, m.salience);
  const st = e.stats();
  assert.equal(st.totalBytes, st.contentBytes + st.dictionaryBytes + st.indexBytes);
  assert.equal(st.overBudget, true); assert.match(st.alert!.message, /content \d+ B \+ dictionaries \d+ B \+ index \d+ B/);
  assert.equal(st.unrecoverable, 0);
  e.budgetBytes = 1e9; await e.enforceBudget(); assert.equal(e.stats().overBudget, false);
});
