# Friction log

Every entry happened during development of this project (Oct 14, 2026). Severity scale: **Blocker** / **High** / **Medium** / **Low**.

### F1: zstd unavailable on the default Node runtime
- **Task:** use zstd (with dictionaries) as the warm-tier codec.
- **Steps:** on the stock Node v20.19.2, `require('zlib').zstdCompressSync` → `undefined`.
- **Expected:** zstd available, since it's widely described as "built into Node".
- **Actual:** zstd only exists from Node 22.15 / 23.8. The tarball needed `xz` to extract, and `xz` wasn't installed (`tar (child): xz: Cannot exec`).
- **Severity:** High (blocked a design requirement).
- **Workaround:** downloaded the `.tar.gz` Node 22.23.3 build into `~/.local/node22`, added `.nvmrc` and `engines.node >= 22.15`, and kept a brotli fallback.
- **Suggestion:** put a "since v22.15.0" badge on the zlib zstd docs, and have `zlib` throw a helpful error (rather than returning undefined) when zstd is used on older runtimes.

### F2: `lzma-native` synchronous mode produces no output
- **Task:** add native xz as a cold-tier codec through a synchronous interface.
- **Steps:** `npm i lzma-native`, then `createCompressor({preset: 9, synchronous: true})`, write the input, `.end()`, and collect `data` events synchronously.
- **Expected:** compressed bytes available right after `.end()` returns.
- **Actual:** 0 bytes, then the decompressor emitted an unhandled `LZMA_BUF_ERROR: No progress is possible`. There is also no `compressSync` in its API.
- **Severity:** Medium.
- **Workaround:** uninstalled it and used pure-JS `lzma` (LZMA-alone format, sync), guarded by sha256.
- **Suggestion:** document whether `synchronous: true` guarantees output before `end()` returns, or provide `compressSync`/`decompressSync`.

### F3: no zstd dictionary training in Node
- **Task:** train a zstd dictionary on the user's own memories (warm tier).
- **Steps:** searched `node:zlib` for ZDICT or `train`; nothing found.
- **Expected:** a `zstdTrainDictionary(samples, maxSize)` equivalent of `zstd --train`.
- **Actual:** only *using* a dictionary is supported (the `dictionary` option).
- **Severity:** Medium.
- **Workaround:** a heuristic raw-content dictionary: recurring sentences and word 4-grams, scored by (df − 1) × length, most valuable bytes last. It does help: zstd-19 with the dictionary beats zstd-19 alone on short memories (tested), and warm reaches 3.2x.
- **Suggestion:** expose ZDICT training in `node:zlib`.

### F4: a raw-content dictionary mismatch decodes silently to garbage
- **Task:** batch re-encode memories during a sleep pass.
- **Steps:** a memory's blob was rewritten under the *same filename* with the new dictionary, while a delta-dependent memory was verified before the base's metadata switched to the new dictionary ID.
- **Expected:** decompressing with the wrong dictionary throws.
- **Actual:** zstd returned plausible-looking garbage ("Ttro line 3 at 8:20, normal.dumplings…"). Only my sha256 check caught it.
- **Severity:** High (data integrity).
- **Workaround:** the commit now switches all metadata first, then verifies every moved memory, then removes superseded blobs. Every read is sha256-verified.
- **Suggestion:** an opt-in check of the raw dictionary's checksum on decompress in Node's zstd binding.

### F5: short memories make the original compression targets unreachable
- **Task:** hit target ratios of 8–15x (cool) and 20–50x (cold).
- **Steps:** measured on a 290-memory, 60-day corpus, about 165 B per memory.
- **Expected:** schema + residual plus a strong codec reaches the targets.
- **Actual:** compressing each memory on its own gave 3.4x cool and 6x cold. Per-object codec overhead (zstd frame headers of about 10 B) dominates 100-byte texts.
- **Severity:** Medium (design change).
- **Workaround:** shared tier archives (cool and cold), compact residual encoding (`[pos, del, "ins"]`, no scores stored), and a trained dictionary. Result: cool 5.2–5.4x, cold 9.2–9.6x. Targets re-set from the data and documented.
- **Suggestion (for MCP memory builders):** publish expected compression ranges for agent-memory-sized texts. Most codec benchmarks use MB-sized corpora.

### F6: delta-encoding cycle within one pass
- **Task:** choose the most similar memory as a delta base for each memory moving tiers.
- **Steps:** two memories moved in the same pass, and each picked the other as its base.
- **Expected:** the planner prevents cycles.
- **Actual:** `Maximum call stack size exceeded` on read.
- **Severity:** High (it would have been unreadable without the integrity checks).
- **Workaround:** track planned delta nodes and planned bases per pass. Chains are limited to depth 1, and memories that may become lossy are never used as bases.
- **Suggestion:** none for vendors; it's a design note for anyone building content-addressed stores.

### F7: no documented way to point a real Alexa+ agent at a self-hosted MCP server
- **Task:** show the server working with Alexa+ itself.
- **Steps:** read the track rules and MCP getting-started docs, looking for a registration flow, auth headers, or a test console.
- **Expected:** a sandbox or console to register an HTTPS MCP endpoint.
- **Actual:** none found. The rules allow a simulated Alexa+ experience instead.
- **Severity:** Medium.
- **Workaround:** `src/alexa-sim.ts`, an MCP client that opens a fresh session per turn and uses a small tool-selection policy.
- **Suggestion:** provide an Alexa+ MCP test harness, or document the endpoint registration and authentication requirements.

### F8: `lz4-napi` blocks reading its own version
- **Task:** print codec versions in test output.
- **Steps:** `require("lz4-napi/package.json")`.
- **Expected:** returns the version.
- **Actual:** `ERR_PACKAGE_PATH_NOT_EXPORTED`, because the `exports` map omits `package.json`.
- **Severity:** Low.
- **Workaround:** resolve the main entry and read the `package.json` next to it.
- **Suggestion:** add `"./package.json": "./package.json"` to `exports`.
