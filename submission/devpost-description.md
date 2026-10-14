# Hippocampus: long-term memory for Alexa+ that sleeps, forgets gracefully, and never loses you

**Track:** Alexa+ (self-hosted MCP server, spec 2025-11-25, Streamable HTTP) · **Mini challenges:** none yet (see "What's next") · **License:** MIT

## Inspiration
Voice assistants either forget you as soon as a conversation ends, or "remember" by pasting old transcripts back into the context window. That gets expensive, slow, and noisy, and it grows forever. Human memory works differently:
- We store experiences outside of "working memory".
- Recall happens by association: one cue lights up another.
- Sleep consolidates many similar days into a general schema.
- Old details fade while important moments stay vivid.
- Even faded memories can be reconstructed from the gist.

I wanted Alexa+ to have that kind of memory: one that keeps state across sessions, stays small, is honest about what it no longer remembers exactly, and never silently throws anything away.

## What it does
Hippocampus is an MCP server any Alexa+ agent can call. It has six tools:

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
- **Spreading activation:** matches flow along association edges, and only memories above a threshold come back.

Graded storage tiers, re-planned on every sleep:

| Tier | Fidelity | Target | Measured on a 290-memory, 60-day corpus | How |
|---|---|---|---|---|
| hot | lossless | 1–2x | 1.0x | plain / LZ4 |
| warm | lossless | 2.5–4x | 2.6–2.9x | zstd + trained dictionary, delta vs. a similar memory, chunk dedup |
| cool | ROUGE-L ≥ 0.90 | 5–8x | 5.0–5.2x (mean fidelity 0.93) | schema + residual diff in a shared archive |
| cold | ROUGE-L ≥ 0.65 | 8–15x | 7.5–8.9x (mean fidelity 0.75) | schema + key residuals, archive packed with brotli/LZMA/zstd |

Over a simulated year, memory content shrinks about 8.6x (47.9 KB → 5.6 KB, 290 memories). Counting the compressed index (15.0 KB) and the trained dictionary (1.0 KB), the whole store is 21.6 KB, about 2.2x smaller than the raw text. With memories this short, the index is now the largest part. Measured with the test corpus: 60 days lived, then sleeps at +7, +30, +90, +180 and +365 days.

Guarantees:
- nothing is deleted;
- schemas are pinned lossless, so every memory can always be reconstructed;
- every read is checked against a sha256;
- measured fidelity is never below the tier floor;
- when the storage budget is exceeded and nothing more can be compressed within the floors, the server raises an **alert** in every tool response and asks the user to decide.

A **simulated Alexa+ client** (allowed by the track rules) drives the server over MCP across sessions. Each turn is a fresh MCP session, so the only continuity is the memory server. A live **brain view** web page shows the graph lighting up during recall and the tiers changing colour as memories fade.

## How we built it
- **TypeScript on Node 22**, with `@modelcontextprotocol/sdk` 1.32: `McpServer` plus a stateless `StreamableHTTPServerTransport` on Express 5, protocol 2025-11-25.
- **Storage:**
  - memory metadata is stored as JSON files;
  - original text is stored per node or in shared tier archives;
  - content-addressed chunks and dictionaries;
  - sha256 integrity checks on every read.
- **Codecs:** Node's built-in zstd (with raw-content dictionaries), brotli and deflate; `lz4-napi` for LZ4; the pure-JS `lzma` package for LZMA. Each tier tries every candidate and keeps the smallest output, and the algorithm is recorded per memory.
- **Dictionary training:** I wrote my own trainer, because Node exposes no ZDICT. It ranks phrases that recur across memories by (frequency − 1) × length and puts the most valuable bytes last.
- **Schema + residual:**
  - an exact token-level LCS diff against the cluster's medoid (the most typical memory);
  - hunks ranked by importance (numbers > names > CJK > other words);
  - greedy selection of the fewest hunks that keep ROUGE-L above the tier floor;
  - dropped details fall back to the schema's wording.
- **Tests:** `node:test`, 19 tests in two files. They cover byte-exact codec round trips, fidelity floors on a realistic corpus, never-unrecoverable, report format, a dry run that writes nothing, budget alerts, fuzzed round trips (300+ random Unicode texts, empty, 200 KB, lone surrogates) through every tier with reloads, randomized fidelity-floor checks, corruption detection, 60 parallel writes, exact budget-alert accounting, byte-identical deterministic runs, and the compact index (size bounds, plus a reload test with byte-exact text and identical recall).
- **Viz:** vis-network with server-sent events.

## Challenges we ran into
- **Short memories barely compress.** Typical agent memories are 50–600 B, so per-object codec overhead dominates. The fix: a trained dictionary, delta encoding, and shared tier archives instead of one compressed file per memory. My first targets (8–15x cool, 20–50x cold) only make sense for documents several KB long, so I re-set them from measured data.
- **Lossless vs. useful forgetting.** The design changed twice. First "forgetting = summarising" (lossy). Then "never lose a byte". Finally, graded tiers with measured fidelity floors and protected high-salience memories.
- **Batch planning bugs.** Two memories in the same pass picked each other as delta bases (infinite recursion). Separately, rewriting a blob under the same filename before switching its metadata made a dictionary mismatch decode silently to garbage. The sha256 checks caught it.
- **Tooling:** no zstd in Node 20; `lzma-native`'s synchronous mode produced no output; Node has no ZDICT training. Details are in the friction log.

## Accomplishments that we're proud of
- A memory that is both **brain-like and accountable**: every pass prints target vs. expected vs. actual ratio and measured fidelity.
- **Never unrecoverable**, enforced by tests and checked against a sha256 on every read.
- About **8.6x** smaller memory content on a realistic corpus (2.2x including the index), while important memories stay exact.
- A reconstruction that behaves like human recall: confident on the gist, honest about faded details, and occasionally blending schema details, which Alexa flags.

## What we learned
- For tiny texts the dictionary matters more than the codec. Archive layout beats per-object compression.
- ROUGE-L floors give "how much may we forget?" a concrete, testable answer.
- Stateless MCP over Streamable HTTP plus file-backed state is a clean way to make an Alexa+ add-on stateful across sessions.

## What's next
- Connect to a live Alexa+ agent, hosted on AWS (deployment plan in the repo).
- Optional Amazon Bedrock summaries and reconstruction (the provider interface is ready), and Bedrock embeddings in place of keyword vectors. This would qualify for the **AWS Builder** mini challenge.
- Real zstd dictionary training through a native binding, and segmented archives for large stores.
- Publish the graded-compression engine as a standalone open-source library (**Open Source** mini challenge).
- An MCP App card that shows "what I remember about you" and lets the user approve exports or deletions when the budget alert fires.

## Built with
typescript · node.js 22 · model-context-protocol (@modelcontextprotocol/sdk) · express · zod · zstd (node:zlib) · brotli · lz4 (lz4-napi) · lzma · vis-network · tsx · node:test
