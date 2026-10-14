// End-to-end MCP smoke test against a running server (npm start, then npm run smoke).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const client = new Client({ name: "smoke-test", version: "0.1.0" });
const transport = new StreamableHTTPClientTransport(new URL(process.env.MCP_URL ?? "http://localhost:3000/mcp"), process.env.MCP_API_KEY ? { requestInit: { headers: { authorization: `Bearer ${process.env.MCP_API_KEY}` } } } : undefined);
await client.connect(transport);
console.log("protocol:", transport.protocolVersion);
console.log("tools:", (await client.listTools()).tools.map(t => t.name));
const call = async (name: string, args: Record<string, unknown> = {}) => console.log(name, (await client.callTool({ name, arguments: args })).content);
await call("remember", { text: "My daughter Mia loves strawberries.", salience: 0.8 });
await call("remember", { text: "Strawberries are on sale at the farmers market on Saturday." });
await call("recall", { cue: "What does Mia like?" });
await call("memory_stats");
await client.close();
