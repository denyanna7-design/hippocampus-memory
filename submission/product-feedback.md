# Product feedback

Primary track: **Alexa+**. Mini challenges: none at submission time; no AWS services are used at runtime yet. Each entry answers the five required questions: what it was used for, what worked, what needs work, onboarding, and whether I'd use it again.

## 1. Model Context Protocol TypeScript SDK (`@modelcontextprotocol/sdk` 1.32.1)
- **Used for:** `McpServer.registerTool` with zod input schemas, stateless `StreamableHTTPServerTransport` mounted on Express, and the client side (`Client` + `StreamableHTTPClientTransport`) for the smoke test and the simulated Alexa+ client.
- **What worked well:** zero to a working 2025-11-25 server took under 30 minutes. Stateless mode (`sessionIdGenerator: undefined`) maps cleanly onto "every Alexa+ turn is a new session". zod schemas give typed handler arguments for free. Protocol negotiation just worked; the client reports `2025-11-25`.
- **What needs work:**
  - The stateless pattern (one `McpServer` per request, closed on `res.close`) is easy to get wrong and is only shown in examples. A one-line helper such as `app.post("/mcp", statelessHandler(buildServer))` would help.
  - Tool results are free-form text. A documented pattern for attaching a side-channel notice, such as our budget alert, to every result would help.
  - The docs don't say clearly how Alexa+ itself discovers and authenticates a self-hosted MCP server.
- **Onboarding:** very good. The quickstart and examples are enough.
- **Again?** Yes. It's the cleanest way to make one capability usable by Alexa+ and every other agent at once.

## 2. Alexa+ track guidance (MCP path, self-hosted server)
- **Used for:** choosing the integration surface (self-hosted MCP over Streamable HTTP) and building the simulated Alexa+ experience the rules allow.
- **What worked well:** the rules spell out the minimum spec version and transport, and allow a simulated experience, so I could build and demo without a device or account.
- **What needs work:** there's no public sandbox to point a real Alexa+ agent at a self-hosted MCP URL, and no documented auth or headers or allow-listing. A hosted test harness that replays Alexa+ tool calls against your server would make demos far more convincing. A sample "Alexa+ simulator" reference client would also standardise the simulated path.
- **Onboarding:** reading the docs was quick, but zero to "Alexa+ actually calls my server" isn't possible yet without extra access.
- **Again?** Yes, if a sandbox becomes available.

## 3. Node.js 22 `node:zlib`: zstd, brotli, deflate
- **Used for:** zstd levels 3 and 19 with raw-content dictionaries for warm memories, delta encoding (a similar memory used as the dictionary), and the archives; brotli-5/11 and deflate-9 as competing candidates.
- **What worked well:** synchronous APIs, no native build, and the `dictionary` option works for both zstd compress and decompress. Performance is excellent for KB-sized payloads.
- **What needs work:**
  - zstd is missing on Node 20 (still common on servers) with no polyfill hint. I had to install Node 22.15+ separately.
  - There's no dictionary *training* API (ZDICT_trainFromBuffer), so I wrote a heuristic trainer.
  - A raw-content dictionary mismatch decodes silently to garbage instead of throwing. An opt-in dictionary-ID check would help.
  - The zstd option names in `zlib.constants` are only lightly documented.
- **Onboarding:** easy once on Node ≥ 22.15.
- **Again?** Yes. Built-in zstd removes a whole class of native dependencies.

## 4. lz4-napi 2.10.0
- **Used for:** the fast LZ4 candidate in the hot and warm tiers.
- **What worked well:** prebuilt binaries installed instantly; the sync API matched my codec interface.
- **What needs work:** the package's `exports` field blocks `require("lz4-napi/package.json")`, so reading its version needs a workaround. On ~100-byte memories LZ4 rarely beats storing the text as-is, which is expected but worth stating in its docs.
- **Onboarding:** under 5 minutes.
- **Again?** Yes, for hot paths with larger payloads.

## 5. lzma (LZMA-JS) 2.3.2, and the failed attempt with lzma-native
- **Used for:** the LZMA candidate for cool and cold archives (xz family, LZMA-alone format).
- **What worked well:** pure JS, synchronous, no build step, and competitive ratios on archives.
- **What needs work:** `decompress()` returns a *string* when the bytes are valid UTF-8 and a number array otherwise, which is dangerous for byte-exact use; I guard it with sha256. It's slow on large inputs. `lzma-native` (native .xz) installed fine, but its `synchronous: true` streams produced 0 bytes, then threw `LZMA_BUF_ERROR` on end (friction log F2).
- **Onboarding:** 10 minutes, after giving up on lzma-native.
- **Again?** Only as a fallback. I'd prefer native xz with a working sync API.

## 6. Express 5, zod 4, tsx, TypeScript 7, node:test
- **Used for:** HTTP hosting (`/mcp`, demo REST endpoints, SSE for the live graph), tool input schemas, running TypeScript without a build step, typechecking, and tests.
- **What worked well:** everything. `tsx --test` with `node:test` needed no test framework at all.
- **What needs work:** TypeScript 7 inferred `Record<string, Buffer> | {}` for a cache's empty-object branch, which broke indexing (TS7053) until I added an explicit return type. That's minor. Otherwise smooth.
- **Again?** Yes.

## 7. vis-network (CDN): first brain view only, since replaced
- **Used for:** the first version of the live graph (activation flashes during recall, tier colours, node labels). The shipped brain view (`public/index.html`) no longer uses it: since commit `25e6b16` it is a self-contained custom 60 fps canvas renderer + force layout with no external libraries or CDN.
- **What worked well:** a DataSet plus incremental `update()` is perfect for streaming SSE events.
- **What needs work:** I didn't tune it for large graphs. Beyond a few hundred nodes, the default physics may need tweaking for a clean recording.
- **Again?** Yes, for quick prototypes.

## Feature requests (optional section)
| Request | Why it matters | Priority |
|---|---|---|
| Alexa+ sandbox that calls a self-hosted MCP URL (with documented auth headers) | Demo the real device experience instead of a simulator | Critical |
| zstd dictionary training in `node:zlib` (`zstdTrainDictionary(samples, size)`) | Short-text memory stores depend on dictionaries | Important |
| Error on a zstd raw-dictionary mismatch (opt-in) | Silent garbage output is a data-integrity hazard | Important |
| MCP SDK helper for the stateless Streamable HTTP pattern | Removes boilerplate and prevents server or transport leaks | Nice-to-have |
| MCP result "notices" (out-of-band warnings attached to any tool result) | Budget alerts and consent prompts without abusing text content | Nice-to-have |
