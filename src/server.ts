// Brain-inspired memory MCP server (Alexa+ track): MCP 2025-11-25 over Streamable HTTP (stateless).
import express from "express";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { MemoryEngine, DAY } from "./memory/engine.js";
import { summarizerFromEnv } from "./memory/providers.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let offset = 0; // demo-only time travel (POST /api/timeskip)
export const engine = new MemoryEngine({ dir: process.env.MEMORY_DIR ?? join(root, "data/memory"), now: () => Date.now() + offset, summarizer: summarizerFromEnv() });
// Every tool result carries the budget alert (if any) so the agent/user is asked to decide; nothing is auto-deleted.
const json = (x: unknown) => {
  const content = [{ type: "text" as const, text: JSON.stringify(x, null, 2) }];
  if (engine.meta.alert) content.push({ type: "text" as const, text: `⚠️ MEMORY BUDGET ALERT: ${engine.meta.alert.message}` });
  return { content };
};

function buildServer() {
  const s = new McpServer({ name: "hippocampus-memory", version: "0.2.0" });
  s.registerTool("remember", { title: "Remember", description: "Store an episodic memory as a file-backed node. salience 0..1 (emotional/important memories fade slower).",
    inputSchema: { text: z.string(), salience: z.number().min(0).max(1).optional(), tags: z.array(z.string()).optional() } },
    async ({ text, salience, tags }) => { const n = await engine.remember(text, salience, tags); return json({ id: n.id, keywords: n.keywords, stability: n.stability }); });
  s.registerTool("recall", { title: "Recall", description: "Activation-based recall: the cue lights up matching memories, activation spreads over associations, only memories above threshold are returned. Always returns the exact original text (losslessly decompressed); recalled memories move back to a warmer tier.",
    inputSchema: { cue: z.string(), k: z.number().int().min(1).max(20).optional() } },
    async ({ cue, k }) => json(await engine.recall(cue, k ?? 5)));
  s.registerTool("sleep", { title: "Sleep / consolidate", description: "Consolidation pass: form schema (prototype) memories from similar episodes, train the zstd dictionary, then move faded memories to colder tiers (hot/warm lossless; cool/cold schema+residual with fidelity floors). Returns a per-tier report: target ratio, expected, actual, bytes, fidelity, algorithms, moves. Never deletes.", inputSchema: {} },
    async () => { const r = await engine.sleep(); return json({ report: r.text, totals: r.totals, moves: r.moves, tiers: r.tiers.map(t => ({ tier: t.tier, target: t.target, floor: t.floor, expected: t.expected.ratio, after: t.after.ratio, fidelity: t.after.fidelity, algorithms: t.after.algorithms })) }); });
  s.registerTool("compress_preview", { title: "Compression preview (dry run)", description: "Show what the next compression pass would do: expected per-tier ratios, fidelity and moves. Writes nothing.", inputSchema: {} },
    async () => { const r = await engine.sleep({ dryRun: true }); return json({ report: r.text, totals: r.totals, moves: r.moves }); });
  s.registerTool("memory_stats", { title: "Memory stats", description: "Counts per compression tier, compression ratio, storage budget and over-budget alert.", inputSchema: {} },
    async () => json(engine.stats()));
  s.registerTool("inspect", { title: "Inspect / forget preview", description: "Inspect one memory: retention, tier, neighbours and when it will move to each colder (lossless) tier.", inputSchema: { id: z.string() } },
    async ({ id }) => json((await engine.inspect(id)) ?? { error: "not found" }));
  return s;
}

const app = express();
app.use(express.json());
// Optional auth for public deployments: MCP_API_KEY requires "Authorization: Bearer <key>".
app.use("/mcp", (req, res, next) => {
  const key = process.env.MCP_API_KEY;
  if (key && req.headers.authorization !== `Bearer ${key}`) { res.status(401).json({ error: "unauthorized" }); return; }
  next();
});
// DEMO_ROUTES=0 disables the demo-only REST writes (remember/recall/sleep/timeskip) and the brain view.
app.use((req, res, next) => {
  if (process.env.DEMO_ROUTES === "0" && (req.path.startsWith("/api/") || req.path === "/" || req.path.endsWith(".html"))) { res.status(404).end(); return; }
  next();
});
app.post("/mcp", async (req, res) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});
app.get("/health", (_req, res) => { res.json({ ok: true }); });
// --- visualization + demo helpers ---
app.use(express.static(join(root, "public")));
app.get("/api/graph", (_req, res) => { res.json(engine.graph()); });
app.get("/api/stats", (_req, res) => { res.json(engine.stats()); });
app.post("/api/remember", async (req, res) => { res.json(await engine.remember(req.body.text, req.body.salience, req.body.tags)); });
app.post("/api/recall", async (req, res) => { res.json(await engine.recall(req.body.cue, req.body.k ?? 5)); });
app.post("/api/sleep", async (_req, res) => { res.json(await engine.sleep()); });
app.post("/api/timeskip", async (req, res) => { offset += Number(req.body.days ?? 1) * DAY; const r = await engine.pass(); res.json({ days: offset / DAY, report: r.text }); });
app.get("/api/preview", async (_req, res) => { res.type("text").send((await engine.sleep({ dryRun: true })).text); });
app.get("/api/events", (req, res) => {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const off = engine.on(ev => res.write(`data: ${JSON.stringify(ev)}\n\n`));
  req.on("close", off);
});
const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`MCP server on http://localhost:${port}/mcp · brain view http://localhost:${port}/`));
