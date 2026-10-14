# Hippocampus — brain-inspired memory MCP server for Alexa+

Agents usually "remember" by stuffing logs into the context window. Hippocampus stores memories as **files**, recalls them by **spreading activation** like a brain, and lets memories **fade without ever losing them**. Decay only lowers how easily a memory is recalled and moves its raw bytes to colder, **losslessly** compressed storage. Every memory can always be recovered byte-for-byte, and each read is checked against its sha256.

Built for the Amazon Developer Hackathon (Alexa+ track). Runs as an MCP server, spec 2025-11-25, over Streamable HTTP. No API keys are needed.

## Architecture
```
Alexa+ / any MCP client ──POST /mcp──► server.ts (stateless, one McpServer per request)
                                          │
                                   MemoryEngine (src/memory/engine.ts)
                    ┌──────────────┬──────┴───────┬────────────────┐
              Embedder (pluggable)  Summarizer (pluggable)   data/memory/
              local TF vector       extractive | OpenAI-compat   nodes/<id>.json (metadata+index)
                                                                 raw/<id>.txt|.z|.dz  chunks/<sha>.br
                                                                 packs/cold.pack  edges.json  meta.json
Browser ──GET /──► public/index.html (vis-network) ◄──SSE /api/events (recall lights up nodes)
```

## Algorithms
| Mechanism | Formula / rule |
|---|---|
| Forgetting curve (power law, FSRS-style) | `R(t) = (1 + t / (9·S))⁻¹`, where t is days since last access and S is stability in days |
| Salience at encoding | `S₀ = 1 · (1 + 3·salience)` |
| Cue seeding | `aᵢ = cos(cue, i) · (0.5 + 0.5·Rᵢ)`, then normalised by `max(maxⱼ aⱼ, 0.5)` |
| Spreading activation | per hop (2 hops): `aⱼ += Σᵢ aᵢ · wᵢⱼ · δ`, δ = 0.7, capped at 1 |
| Retrieval | return the top-k nodes with `a ≥ θ` (θ = 0.1) |
| Spacing effect (retrieval strengthens) | `S += S · g · (1 − R) · (1 + salience) · a + 0.1`, g = 1.5 (bigger gain when the memory was nearly forgotten) |
| Hebbian learning | for co-recalled i, j: `wᵢⱼ += η · aᵢ · aⱼ · (1 − wᵢⱼ)`, η = 0.2 |
| Association at encoding | `w = cos(new, old)` if ≥ 0.15; temporal link to the previous episode `w ≥ 0.25` |
| Decay = colder *lossless* storage | R ≥ 0.6 → **hot** (stored as-is, fastest) · R ≥ 0.35 → **warm** (fast codecs: brotli-4 / deflate-6 / zstd-3, plus chunk dedup and delta) · R ≥ 0.15 → **cool** (max codecs: brotli-11 / deflate-9 / zstd-19, plus dedup and delta) · else **cold** (all cold memories packed into one archive, compressed with the smallest of the cold codecs). Each tier tries every candidate and keeps the **smallest** output. The algorithm used is recorded per node (`enc`). |
| Delta encoding | raw-deflate with the most similar memory's raw bytes as a preset dictionary (LZ77 back-references into it). Chains are kept to depth 1: a base is never itself a delta, and a memory that others depend on never becomes one. |
| Chunk dedup | content-defined chunks split at sentence and line boundaries, stored by sha256 in `chunks/`; shared passages are stored once |
| Integrity | the new encoding is written and verified (sha256) **before** the old copy is removed; every read is checked |
| Index layers | a summary (extractive, or from an LLM) and keywords are *added* once a memory leaves the hot tier. The raw text is never replaced. |
| Recall | always returns the exact original text; a recalled memory warms back up to the warm tier (reconsolidation) |
| Budget | `MEMORY_BUDGET_BYTES`. When exceeded, the weakest memories are pushed to cool, then cold. If the store is still over budget, the server **raises an alert** instead of deleting: `memory_stats.overBudget` and `.alert` are set, a ⚠️ line is appended to every MCP tool result, and the alert is logged once. The user decides what happens next. |
| Sleep | replay unconsolidated episodes → strengthen similar pairs (+0.1) → merge clusters (cos ≥ 0.55) into **semantic** nodes (S = 4·n, linked to their sources at 0.8) → synaptic homeostasis (`w *= 0.95`, floor 0.05, no pruning) → move faded memories to colder lossless tiers. Episodes are kept alongside the semantic node. |

`memory_stats` reports `compressionRatio` and a `perTier` table: raw vs. stored bytes, ratio, and algorithm counts per tier. Shared chunks are split by refcount and the pack is split by raw share. `inspect` previews `t = 9S(1/R* − 1)` days until each colder tier. Codecs are pluggable via `registerCodec()` / `TIER_CODECS` in `src/memory/rawstore.ts`: add lz4, xz, or zstd with a trained dictionary there. zstd turns on automatically on Node ≥ 22.15.

## MCP tools
- `remember(text, salience?, tags?)`
- `recall(cue, k?)`
- `sleep()`
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

## Demo script (under 3 minutes)
1. Open `http://localhost:3000/`. The graph is empty.
2. Remember: "My daughter Mia loves strawberries" (salience 0.8), "Strawberries are on sale at the farmers market Saturday", "Farmers market opens 8am by the river", "Lunch was a forgettable sandwich" (salience 0).
3. Recall "What does Mia like?". The nodes light up yellow: Mia is matched by the cue, and the market is reached by spreading activation. Point out that only above-threshold memories come back.
4. Click **sleep**, then **+7 days** several times. Watch the colours move hot→warm→cool→cold, with each node labelled by its algorithm (delta, brotli-11, pack). The sandwich fades first, the salient memory lasts, and the stats panel shows per-tier ratios.
5. Recall the faded memory. It comes back **word for word** from the cold archive and warms up again.
6. Restart with `MEMORY_BUDGET_BYTES=900`. The stats panel turns red and Alexa reads out the alert: nothing was deleted, and the user has to decide.
7. Show the same thing through Alexa+ or an MCP client (`npm run smoke`).
