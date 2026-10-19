# Hippocampus: long-term memory for Alexa+ that sleeps, forgets gracefully, and never loses you

**Track:** Alexa+ (self-hosted MCP server, spec 2025-11-25, Streamable HTTP) · **Mini challenges:** none at submit time (Bedrock / open-source extras are optional and not claimed) · **License:** MIT

> Paste guide: use the sections below as Devpost story fields (Inspiration → What's next). Keep **Built with** as tags. Do not claim AWS Builder or Open Source mini challenges unless those integrations ship before submit.

## Inspiration
Voice assistants either forget you as soon as a conversation ends, or "remember" by pasting old transcripts back into the context window. That gets expensive, slow, and noisy, and it grows forever. Human memory works differently:
- We store experiences outside of "working memory".
- Recall happens by association: one cue lights up another.
- Sleep consolidates many similar days into a general schema.
- Old details fade while important moments stay vivid.
- Even faded memories can be reconstructed from the gist.

I wanted Alexa+ to have that kind of memory: one that keeps state across sessions, stays small, is honest about what it no longer remembers exactly, and never silently throws anything away.

## What it does
Hippocampus is a **self-hosted MCP server** any Alexa+ agent (or MCP client) can call. It implements MCP **spec 2025-11-25** over **Streamable HTTP** at `POST /mcp`, and exposes six tools:

| Tool | What it does |
|---|---|
| `remember(text, salience?, tags?)` | Stores an episode as a file-backed node and links it to related memories |
| `recall(cue, k?)` | Spreading-activation recall. Returns the text plus how it is stored and whether it is exact or reconstructed (with its fidelity) |
| `sleep()` | Consolidation: forms **schemas** from similar episodes, retrains a compression dictionary on your own memories, and moves faded memories to colder tiers. Returns a **per-tier compression report** |
| `compress_preview()` | Dry run of the next pass: expected ratios and fidelity, nothing written |
| `memory_stats()` | Tiers, ratios, fidelity, content / dictionary / index / total bytes, budget and alert state, last report |
| `inspect(id)` | One memory: retention, tier, neighbours, when it will move colder, and whether it is protected |

Brain-inspired dynamics:
- **Forgetting curve:** power law, `R = (1 + t/9S)⁻¹`.
- **Salience:** important memories start stronger, and memories with salience ≥ 0.7 are always stored byte-exact.
- **Spacing effect:** each recall strengthens a memory, most of all when it was nearly forgotten.
- **Hebbian learning:** memories recalled together get stronger links.
- **Spreading activation:** matches flow along association edges and keep spreading while each hop still adds activation (up to 8 hops) instead of a fixed hop count; only memories above a threshold come back.
- **Slow synaptic decay:** association weights decay slowly over time toward a soft floor, so unused links fade gradually instead of dropping off a cliff.

Graded storage tiers, re-planned on every sleep (targets match what short agent memories actually reach; see Challenges):

| Tier | Fidelity | Target | Measured on a 290-memory, 60-day corpus | How |
|---|---|---|---|---|
| hot | lossless | 1–2x | 1.0x | plain / LZ4 |
| warm | lossless | 2.5–4x | 2.6–2.9x | zstd + trained dictionary, delta vs. a similar memory, chunk dedup |
| cool | ROUGE-L ≥ 0.90 and char ≥ 0.85, local semantic ≥ 0.80 | 5–8x | 4.9–5.2x (mean ROUGE-L 0.93) | schema + residual diff in a shared archive |
| cold | ROUGE-L and char ≥ 0.65, local semantic ≥ 0.50 | 8–15x | 7.4–8.7x (mean ROUGE-L 0.76) | schema + key residuals, archive packed with brotli/LZMA/zstd |

Over a simulated year, memory **content** shrinks about **8.3×** (47.9 KB → 5.7 KB, 290 memories). Counting the compressed index (~11.5 KB) and the trained dictionary (~1.0 KB), the whole store is about **18.3 KB**, roughly **2.6×** smaller than the raw text. With memories this short, the index is now the largest part. Measured with the test corpus: 60 days lived, then sleeps at +7, +30, +90, +180 and +365 days.

Demo stores (same engine; numbers vary slightly between non-deterministic runs):

| Store | Memories | Raw | Total on disk (approx.) |
|---|---|---|---|
| `alexa:demo:video` (14 days, curated) | 52 | 5.1 KB | ~6.3 KB |
| `alexa:demo:full` (30 days) | 151 | 23.7 KB | ~17.9 KB |
| test corpus (60 days + simulated year) | 290 | 46.8 KB | ~17.8 KB |

Guarantees:
- nothing is deleted;
- schemas are pinned lossless, so every memory can always be reconstructed;
- every read is checked against a sha256;
- measured fidelity is never below the tier floor;
- when the storage budget is exceeded and nothing more can be compressed within the floors, the server raises an **alert** in every tool response and asks the user to decide.

A **simulated Alexa+ client** (allowed by the track rules; Alexa+ partner tooling is select-partners-only) drives the server over MCP across sessions. Each turn is a fresh MCP session, so the only continuity is the memory server. A live **brain view** web page (custom canvas renderer, no CDN) shows the graph lighting up during recall and the tiers changing colour as memories fade.

## How we built it
- **TypeScript on Node 22** (≥ 22.15 for built-in zstd), with `@modelcontextprotocol/sdk` 1.32: `McpServer` plus a stateless `StreamableHTTPServerTransport` on Express 5, protocol **2025-11-25**.
- **Storage:**
  - compact metadata in one `data/memory/index.bin` (zstd-19: JSON header + binary edge table); older `nodes/*.json` stores migrate automatically;
  - original text per node or in shared tier archives;
  - content-addressed chunks and dictionaries;
  - sha256 integrity checks on every read.
- **Codecs:** Node's built-in zstd (with raw-content dictionaries), brotli and deflate; `lz4-napi` for LZ4; the pure-JS `lzma` package for LZMA. Each tier tries every candidate and keeps the smallest output; the algorithm is recorded per memory.
- **Dictionary training:** a heuristic trainer (Node exposes no ZDICT). It ranks phrases that recur across memories by (frequency − 1) × length and puts the most valuable bytes last.
- **Schema + residual:**
  - exact token-level LCS diff against the cluster's medoid;
  - hunks ranked by importance (numbers > names > CJK > other words);
  - greedy selection of the fewest hunks that keep both ROUGE-L and character similarity above the tier floors;
  - dropped details fall back to the schema's wording;
  - schema membership needs embedding cosine plus a second signal (token, character or residual overlap); near-misses stay lossless on hold and are re-checked on the next sleep.
- **Tests:** 27 `node:test` tests, covering byte-exact codec round trips, fidelity floors on a realistic corpus, never-unrecoverable, report format, dry-run writes nothing, budget alerts, fuzzed round trips, corruption detection, parallel writes, deterministic `DEMO_EPOCH` runs, compact-index size/reload checks, and the engine's edge decay, dynamic spreading, dual-check schemas and dual-check fidelity floors.
- **Viz:** self-contained custom 60 fps canvas + force layout in `public/index.html` (no external libraries / CDN), driven by SSE `/api/events`.

## Challenges we ran into
- **Short memories barely compress.** Typical agent memories are 50–600 B, so per-object codec overhead dominates. The fix: a trained dictionary, delta encoding, and shared tier archives instead of one compressed file per memory. Early targets (8–15× cool, 20–50× cold) only make sense for multi-KB documents, so targets were re-set from measured data.
- **Lossless vs. useful forgetting.** The design changed twice. First "forgetting = summarising" (lossy). Then "never lose a byte". Finally, graded tiers with measured fidelity floors and protected high-salience memories.
- **Batch planning bugs.** Two memories in the same pass picked each other as delta bases (infinite recursion). Separately, rewriting a blob under the same filename before switching its metadata made a dictionary mismatch decode silently to garbage. The sha256 checks caught it.
- **Tooling:** no zstd in Node 20; `lzma-native`'s synchronous mode produced no output; Node has no ZDICT training; Alexa+ partner MCP sandbox is not available to hackathon entrants. Details are in the friction log.

## Accomplishments that we're proud of
- A memory that is both **brain-like and accountable**: every pass prints target vs. expected vs. actual ratio and measured fidelity.
- **Never unrecoverable**, enforced by tests and checked against a sha256 on every read.
- About **8.3×** smaller memory content on a realistic corpus (**~2.6×** including the index), while important memories stay exact.
- A reconstruction that behaves like human recall: confident on the gist, honest about faded details, and occasionally blending schema details, which the simulated Alexa flags.
- Runtime MCP hook is real: `src/server.ts` and `src/alexa-sim.ts` import and call `@modelcontextprotocol/sdk` (not README-only).

## What we learned
- For tiny texts the dictionary matters more than the codec. Archive layout beats per-object compression.
- ROUGE-L floors give "how much may we forget?" a concrete, testable answer.
- Stateless MCP over Streamable HTTP plus file-backed state is a clean way to make an Alexa+ add-on stateful across sessions.
- Metadata can dominate cost when memories are ~100 B; budget the index from day one.

## What's next
- Optional public HTTPS deploy (plan in `submission/aws-deployment-plan.md`) so judges can hit a live `/mcp` URL; not required by the rules.
- Optional Amazon Bedrock summaries / reconstruction / embeddings (provider hook exists). **Not claimed** for AWS Builder until it ships and is documented in Product Feedback.
- Real zstd dictionary training through a native binding, and segmented archives for large stores.
- Publish the graded-compression engine as a standalone open-source library (**Open Source** mini challenge — not claimed yet).
- An MCP App card that shows "what I remember about you" and lets the user approve exports or deletions when the budget alert fires.

## Built with
typescript · node.js 22 · model-context-protocol (@modelcontextprotocol/sdk) · express · zod · zstd (node:zlib) · brotli · lz4 (lz4-napi) · lzma · custom-canvas-brain-view · tsx · node:test
