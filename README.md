# Hippocampus — brain-inspired memory MCP server for Alexa+

> Node ≥ 22.15 required (zstd). On the box: `export PATH=$HOME/.local/node22/bin:$PATH`.

Agents usually "remember" by stuffing logs into the context window. **Hippocampus** is a self-hosted **MCP server (spec 2025-11-25, Streamable HTTP)** that gives Alexa+ a brain-like long-term memory:

- memories are **files**, not context;
- recall is **spreading activation** over an association graph, shaped by Hebbian learning, the spacing effect and salience;
- **sleep** consolidates similar episodes into **schemas** and compresses faded memories through **graded tiers**: lossless hot/warm, then schema + residual in cool/cold with measured fidelity floors;
- every pass produces a **compression report**;
- nothing is ever deleted, and no memory ever becomes unrecoverable;
- when the storage budget runs out, the server **asks the user** instead of deleting.

Built for the Amazon Developer Hackathon, Alexa+ track. MIT licensed.

## Quick start
```bash
# Node >= 22.15 is required for zstd (see .nvmrc). On the dev box: export PATH=$HOME/.local/node22/bin:$PATH
npm install
npm start                    # MCP: http://localhost:3000/mcp · brain view: http://localhost:3000/
npm run alexa:demo:full      # in a 2nd terminal: simulated Alexa+ conversations across sessions (MCP client)
npm run alexa:demo -- --chat # interactive simulated Alexa+ (/sleep, /skip 30, /stats, /quit; piped stdin works)
npm run alexa:demo:video     # smaller curated 2-week history used for the demo video
npm test && npm run typecheck
```
Docker: `docker build -t hippocampus . && docker run -p 3000:3000 -v $PWD/data:/data hippocampus`

**Runtime use of MCP.** `src/server.ts` imports `@modelcontextprotocol/sdk` (`McpServer`, `StreamableHTTPServerTransport`) and serves 6 tools at `POST /mcp`. `src/alexa-sim.ts` imports the SDK `Client` and `StreamableHTTPClientTransport` and calls those tools. Each simulated Alexa+ turn opens a fresh MCP session, so continuity can only come from the memory server.

## Architecture
```
Alexa+ / any MCP client ──POST /mcp──► server.ts (stateless, one McpServer per request)
                                          │
                                   MemoryEngine (src/memory/engine.ts)
                    ┌──────────────┬──────┴───────┬────────────────┐
              Embedder (pluggable)  Summarizer (pluggable)   data/memory/
              local TF vector       extractive | OpenAI-compat   index.bin (zstd-19 compact index)
                                                                 raw/<id>.txt|.z|.dz  chunks/<sha>.br
                                                                 packs/{cool,cold}.pack  dicts/<id>.dict
Browser ──GET /──► public/index.html (vis-network) ◄──SSE /api/events (recall lights up nodes)
```

## Algorithms
### Recall: brain-like dynamics
| Mechanism | Formula / rule |
|---|---|
| Forgetting curve (power law) | `R(t) = (1 + t/(9·S))⁻¹`, where t is days since last access and S is stability |
| Salience | `S₀ = 1 + 3·salience`. Salience ≥ 0.7 ⇒ the memory is **always lossless** |
| Spreading activation | seed `aᵢ = cos(cue,i)·(0.5+0.5Rᵢ)` (normalised), then spread `aⱼ += aᵢ·wᵢⱼ·0.7` while a hop still adds ≥ 0.01, stopping at 8 hops; return the top-k with `a ≥ 0.1` |
| Spacing effect | `S += S·1.5·(1−R)·(1+salience)·a + 0.1` |
| Hebbian | `wᵢⱼ += 0.2·aᵢ·aⱼ·(1−wᵢⱼ)`, then capped at 1 |
| Edge decay (on sleep) | elapsed retention-ticks (days since the edge was last set, or since the previous sleep): `w → 0.05 + (w−0.05)·exp(−ln2·ticks/60)`. Slow falloff toward a soft floor; a rare edge is not snapped to the floor in one step |

### Storage: graded tiers, picked by retention R and re-planned on every `sleep()`
| Tier | R | Fidelity | Target ratio | How (each tier tries every candidate; smallest output wins; algorithm recorded per node) |
|---|---|---|---|---|
| hot | ≥ 0.6 | lossless | 1–2x | stored as-is or LZ4 (fast access) |
| warm | ≥ 0.35 | lossless | 2.5–4x | zstd-3 / brotli-5 / LZ4, zstd with a **trained dictionary**, **delta** (zstd/deflate with a similar memory as dictionary), **chunk dedup** |
| cool | ≥ 0.15 | ROUGE-L ≥ 0.90, char similarity ≥ 0.85, and local-embedding cosine ≥ 0.80 | 5–8x | **schema + residual** in a shared archive. A keep count is accepted only when all three clear. Char sits slightly under the ROUGE-L floor so short memories still reach the ratio target. Archive codec: zstd-19(+dict) / brotli-11 / LZMA-9 / deflate-9 |
| cold | < 0.15 | ROUGE-L ≥ 0.65, char similarity ≥ 0.65, and local-embedding cosine ≥ 0.50 | 8–15x | schema + **key residuals** (gist) in a shared archive, same three gates, LZMA-9 / zstd-19(+dict) / brotli-11 |

**Why these targets.** Agent memories are short: about 50–600 B, about 165 B on average in our corpus. On text that short, per-object codec overhead dominates. That is why warm relies on a trained dictionary and delta, and why cool/cold share an archive. The 8–15x / 20–50x targets suggested at the start only make sense for multi-KB documents. The targets above match what the realistic corpus actually reaches (see the tests).

**Measured per tier (current engine).** Test corpus: 290 memories (47.9 KB raw, about 165 B each), 60 days lived, then sleeps at +7, +30, +90, +180 and +365 days; ranges cover 5 runs (2026-10-19).

| Tier | How stored | Ratio | Fidelity / QA retention |
|---|---|---|---|
| hot | as-is or LZ4 | 1.0x | lossless |
| warm | zstd / brotli / LZ4 with a trained dictionary, delta, chunk dedup | 2.6–2.9x | lossless |
| cool | schema + residual diff in a shared archive | 4.9–5.2x | every memory clears ROUGE-L ≥ 0.90, char ≥ 0.85, local semantic ≥ 0.80 (mean ROUGE-L 0.93); QA retention 87–89% |
| cold | schema + key residuals in a shared archive | 7.4–8.7x | ROUGE-L mean 0.76, minimum 0.65; QA retention 64% at +30 days, 61% after a year |

Tier ratios are content-only; whole-store total including index and links: 2.6x on the synthetic corpus, 1.5x on real notes (real notes' cold tier is ~2.1x because they rarely share templates). QA retention comes from a local rule-based probe (no LLM): cloze questions on numbers, dates, names and relations, answered by an extractive reader; it is accuracy on the reconstruction divided by accuracy on the original. Treat it as a rough reference, not an LLM-judged score.

**Schema consolidation (mammal-like).** During `sleep()`, lossless episodes with cosine similarity ≥ 0.35 are candidates (minimum 3). Membership becomes **permanent** only after a near dual-check: vector similarity and a second signal (surface-token overlap, character-trigram overlap, or residual fidelity of the prototype) both clear their floors. A near-miss stays **provisional** (`schemaHold`) and is re-checked on the next sleep; missing the check does not accumulate into a permanent link. Only permanent members are copied onto the pinned, always-lossless **schema** (the medoid) and may later be stored lossily. Each of those members is a token-level diff against the schema (hunks `[pos, del, insert]`). Hunks are ordered by importance: digits ×3, capitalised words ×2, CJK ×1.5, other text ×1, divided by size. Greedy selection keeps the fewest hunks that clear the tier's ROUGE-L floor **and** its char-similarity floor **and** (cool/cold) the local-embedding cosine floor. The semantic check uses the offline local term-frequency embedder, not a network provider. Cold keeps at least one key residual. Dropped details revert to the schema's wording, which is the same "filling in" human recall does. Provisional candidates stay lossless.

**Guarantees.**
1. Nothing is ever deleted.
2. Every memory can always be reconstructed: schemas are pinned lossless, and every read is integrity-checked with a 64-bit sha256 tag (of the original for lossless memories, of the reconstruction for lossy ones). `memory_stats.unrecoverable` is measured, not assumed: every memory is decoded and hash-checked. A damaged blob is reported there and does not stop the rest of the store from loading.
3. A memory's measured fidelity is never below its tier floor. Cool/cold lossy encodes record ROUGE-L, char similarity, and local-embedding cosine, and each one has to clear that tier's floor. Fidelity is computed against the original at compression time and stored per node.
4. High-salience memories, delta bases and memories without a schema stay byte-exact.
5. A lossy memory never "warms" back up. A recalled lossless memory returns to the warm tier.

**Budget.** `MEMORY_BUDGET_BYTES`. When exceeded, the weakest memories are forced down to cool, then cold (fidelity floors still apply). If the store is still over budget, the server raises an **alert** instead of deleting: `memory_stats.overBudget`/`alert` are set, a ⚠️ line is appended to every MCP tool result, and the alert is logged once.

**Compact index.** All metadata lives in one file, `data/memory/index.bin`: a JSON header plus a binary edge table (two uint16 node indices and a uint8 weight per edge), compressed with zstd-19 and written atomically, once per tick. Redundant fields are not stored. Keywords, schema members and summaries are re-derived. Vectors from the default local embedder are recomputed from the stored text; for a faded memory they come from its reconstruction, so it is cued by what is left of it. Hashes are 64-bit tags. During sleep, edge weights fall with elapsed time toward a soft floor of 0.05 (half-life 60 days) and never exceed the cap of 1; weak associations beyond each memory's six strongest links are then pruned ("synaptic pruning"). Memories themselves are never pruned. The trained zstd dictionary is capped at 1/6 of the raw corpus, and memories that still use an old dictionary are re-encoded during sleep so it can be retired. `memory_stats` and the budget report `contentBytes`, `dictionaryBytes`, `indexBytes` and `totalBytes` separately, and the budget applies to the total. An older store using `nodes/*.json` is migrated automatically.

| Store | Raw | Content | Dictionary | Index | Total on disk |
|---|---|---|---|---|---|
| `alexa:demo:full` (151 memories, 30 days) | 23.7 KB | 5.3 KB | 2.6–3.5 KB | 8.7 KB | 16.6–17.3 KB |
| test corpus (290 memories, 60 days + 1 simulated year) | 46.8 KB | 5.5 KB | 1.0 KB | 14.6 KB | 21.1 KB |
| `alexa:demo:video` (52 memories, 14 days) | 5.1 KB | 1.8 KB | 1.0 KB | 3.3 KB | 6.1 KB |
| before the compact index (`alexa:demo:full`) | 23.7 KB | 5.0 KB | 60.3 KB | ~250 KB | ~308 KB |

The size table was measured before lossy nodes also stored a semantic-fidelity number, so a store built now can be slightly larger. Demo runs vary slightly between runs, because the server clock is real time plus the simulated skips. The index costs about 50–65 B per memory (an 8-character id, a 64-bit hash, tier/encoding and fidelity numbers, timestamps, and on average four or five pruned edges). Content for these short memories compresses to about 35 B each, so the index is still larger than the content. It is about a third of the raw size, and is now proportional to the number of memories rather than the dominant cost.

**Compression report.** Every pass (`sleep`, time-skip, budget enforcement) produces a per-tier report with: target ratio and fidelity floors (ROUGE-L, char similarity, local-embedding cosine), before / expected (planned) / after for nodes, raw→stored bytes, ratio, ROUGE-L mean and minimum, char similarity, semantic similarity, algorithms used, and moves. It is returned by `sleep`, stored in `memory_stats.lastReport`, and appended to `data/memory/compaction.log` as text plus a JSON line. `compress_preview` (or `GET /api/preview`) is a dry run that writes nothing. It doesn't form new schemas; those are created at the start of a real `sleep`.

Codecs are registered in `src/memory/codecs.ts` (`registerCodec`, `TIER_CODECS`). Requires Node ≥ 22.15 for zstd (`.nvmrc` pins 22.23.3). LZ4 comes from `lz4-napi`; LZMA from the pure-JS `lzma` package. `lzma-native` was tried, but its synchronous mode did not flush output, so it was dropped.

## MCP tools
- `remember(text, salience?, tags?)`
- `recall(cue, k?)`
- `sleep()`: returns the compression report
- `compress_preview()`: dry-run report
- `memory_stats()`
- `inspect(id)`

## Run
```bash
npm install
npm start          # MCP at http://localhost:3000/mcp, brain view at http://localhost:3000/
npm test           # unit + time-skip scenario tests (node:test)
npm run typecheck
npm run smoke      # end-to-end MCP client against a running server
```
Environment variables:
- `MEMORY_DIR`: storage folder (default `data/memory`)
- `MEMORY_BUDGET_BYTES`: storage budget (default: unlimited)
- `PORT`
- `MEMORY_LLM=openai` with `OPENAI_API_KEY`: LLM summaries and reconstruction. Optional: `OPENAI_BASE_URL`, `OPENAI_MODEL`.
- Bedrock: hook point in `src/memory/providers.ts`

Demo REST helpers (not part of MCP):
- `POST /api/remember`, `/api/recall`, `/api/sleep`
- `POST /api/timeskip {days}`: shifts the server clock and runs decay
- `GET /api/graph`, `/api/stats`, `/api/events`

## Demo
The full shot list is in `submission/demo-video-script.md`. Short version: run `npm start`, open `http://localhost:3000/`, run `npm run alexa:demo:video` (or `alexa:demo:full`) in a second terminal and watch the graph light up, click 🔍 preview pass / 😴 sleep / ⏩ +7 days, then restart with `MEMORY_BUDGET_BYTES=5000` (after `alexa:demo:video`) to show the alert. The brain view is self-contained: a custom 60 fps canvas renderer and force layout, with no external libraries or CDN. It shows activation pulses with particle trails, a camera zoom to the recalled memory, and sleep as replay → fold into schemas → condense, with a byte counter and per-tier bars. Set `DEMO_EPOCH=<ms>` for a reproducible demo: the clock is frozen except for `/api/timeskip`, and ids are deterministic, so two runs produce byte-identical stores. The budget alert is derived state. It is recomputed at startup and not stored in the index, so the alert and `memory_stats` always report the same total.
