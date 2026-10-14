# Hippocampus — brain-inspired memory MCP server for Alexa+

Agents usually "remember" by stuffing logs into the context window. Hippocampus stores memories as **files**, recalls them by **spreading activation** like a brain, and **forgets by compressing**, not deleting: vivid episodes fade into summaries, then gists, then faint traces that can still be *reconstructed* from their associations.

Built for the Amazon Developer Hackathon (Alexa+ track). Runs as an MCP server, spec 2025-11-25, over Streamable HTTP. No API keys are needed.

## Architecture
```
Alexa+ / any MCP client ──POST /mcp──► server.ts (stateless, one McpServer per request)
                                          │
                                   MemoryEngine (src/memory/engine.ts)
                    ┌──────────────┬──────┴───────┬────────────────┐
              Embedder (pluggable)  Summarizer (pluggable)   data/memory/
              local TF vector       extractive | OpenAI-compat   nodes/<id>.json
                                                                 edges.json  meta.json
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
| Forgetting = compression | R ≥ 0.6 → **L0** raw text · R ≥ 0.35 → **L1** summary · R ≥ 0.15 → **L2** gist (5 keywords) · else **L3** trace (3 keywords). The vector is pruned to ∞/24/8/3 terms. Compression is one-way and nodes are never deleted. |
| Reconstruction | Recalling an L2/L3 node returns a hedged reconstruction built from its gist plus the summaries of its strongest L0/L1 neighbours (an LLM does this if one is configured) |
| Sleep | replay unconsolidated episodes → strengthen similar pairs (+0.1) → merge clusters (cos ≥ 0.55) into **semantic** nodes (S = 4·n, linked to their sources at 0.8) → synaptic homeostasis (`w *= 0.95`, prune < 0.05) → decay + compress everything |

`memory_stats` reports `bytesSaved` (L0 baseline vs. current file sizes). `inspect` gives a forget preview: `t = 9S(1/R* − 1)` days until each next tier.

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
4. Click **sleep**, then **+7 days** several times. Watch the colours shift L0→L1→L2→L3. The sandwich fades first, the salient memory lasts, and the stats panel shows bytes saved.
5. Recall the faded memory. It comes back as `[reconstructed] …` built from its neighbours, just like human recollection.
6. Show the same thing through Alexa+ or an MCP client (`npm run smoke`).
