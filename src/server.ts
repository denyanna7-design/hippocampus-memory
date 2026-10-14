// Minimal Alexa+ track MCP server: MCP spec 2025-11-25 over Streamable HTTP (stateless).
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

function buildServer() {
  const server = new McpServer({ name: "alexa-plus-hello", version: "0.1.0" });
  server.registerTool(
    "hello",
    { title: "Say hello", description: "Greets a person by name", inputSchema: { name: z.string() } },
    async ({ name }) => ({ content: [{ type: "text", text: `Hello, ${name}! Greetings from your Alexa+ MCP server.` }] })
  );
  return server;
}

const app = express();
app.use(express.json());
app.post("/mcp", async (req, res) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});
app.get("/health", (_req, res) => { res.json({ ok: true }); });
const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`MCP server on http://localhost:${port}/mcp`));
