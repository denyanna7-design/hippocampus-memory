import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const client = new Client({ name: "smoke-test", version: "0.1.0" });
const transport = new StreamableHTTPClientTransport(new URL(process.env.MCP_URL ?? "http://localhost:3000/mcp"));
await client.connect(transport);
console.log("protocol:", transport.protocolVersion);
console.log("tools:", (await client.listTools()).tools.map(t => t.name));
console.log(JSON.stringify(await client.callTool({ name: "hello", arguments: { name: "Anna" } })));
await client.close();
