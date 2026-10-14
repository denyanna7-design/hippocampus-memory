// Simulated Alexa+ conversation client. Each "session" opens a fresh MCP connection (like a new Alexa+
// conversation), so continuity can only come from the memory server. Between sessions it fast-forwards
// the server clock (demo-only /api/timeskip) and lets the agent "sleep" (consolidation + compression).
//   npm run alexa:demo            scripted multi-session demo
//   npm run alexa:demo -- --chat  interactive: type as the user; "/sleep", "/skip 30", "/stats", "/quit"
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createInterface } from "node:readline/promises";
import { corpus } from "./demo-corpus.js";

const MCP = new URL(process.env.MCP_URL ?? "http://localhost:3000/mcp");
const BASE = MCP.origin;
let budgetAlert = false;
const pause = (ms: number) => new Promise(r => setTimeout(r, Number(process.env.DEMO_PACE ?? 1) * ms));

async function session<T>(fn: (call: (name: string, args?: Record<string, unknown>) => Promise<any>) => Promise<T>): Promise<T> {
  const client = new Client({ name: "alexa-plus-sim", version: "0.3.0" });
  await client.connect(new StreamableHTTPClientTransport(MCP, process.env.MCP_API_KEY ? { requestInit: { headers: { authorization: `Bearer ${process.env.MCP_API_KEY}` } } } : undefined));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args }) as { content: { text: string }[] };
    const alert = r.content.find(c => c.text.startsWith("⚠️"));
    if (alert) { console.log(`   ${alert.text}`); budgetAlert = true; }
    try { return JSON.parse(r.content[0].text); } catch { return r.content[0].text; }
  };
  try { return await fn(call); } finally { await client.close(); }
}

/** Tiny agent policy: decide which memory tool(s) Alexa+ calls for an utterance. */
async function turn(call: (n: string, a?: Record<string, unknown>) => Promise<any>, user: string) {
  console.log(`\n👤 ${user}`); await pause(600);
  const u = user.toLowerCase();
  if (/^(good ?night|go to sleep)/.test(u)) {
    const r = await call("sleep"); console.log(`   🔧 sleep()\n${String(r.report).split("\n").map(l => "      " + l).join("\n")}`);
    return say(`Good night. I consolidated today's memories: ratio ${r.totals.ratioBefore}x → ${r.totals.ratioAfter}x, nothing deleted.`);
  }
  const salient = /(!|accepted|hospital|lost my|won|deadline|important|never forget)/i.test(user) ? 0.9 : 0.3;
  const isQuestion = /\?$|^(what|when|where|who|how|do you|did i|remind me what)/i.test(u);
  if (!isQuestion) {
    const r = await call("remember", { text: user, salience: salient });
    console.log(`   🔧 remember(salience=${salient}) → ${r.id} [${r.keywords.join(", ")}]`);
    if (budgetAlert) { budgetAlert = false; return say("Saved — but my memory storage is full and I've compressed everything I safely can. I won't delete anything on my own: should I raise the limit, export old memories, or would you like to pick some to delete?"); }
    return say(salient > 0.5 ? "That sounds important — I'll keep it word-for-word." : "Got it, I'll remember that.");
  }
  const hits = await call("recall", { cue: user, k: 3 }) as { id: string; text: string; via: string; activation: number; storage: string; exact: boolean; fidelity: number }[];
  console.log(`   🔧 recall → ${hits.map(h => `${h.id}(${h.via}, a=${h.activation}, ${h.storage}${h.exact ? "" : `, fidelity ${h.fidelity}`})`).join(" ") || "nothing above threshold"}`);
  if (!hits.length) return say("I don't remember anything about that.");
  const top = hits[0];
  return say(`${top.exact ? "You told me" : "If I remember right (details may have faded)"}: "${top.text}"` + (hits[1] && hits[1].activation >= 0.5 ? ` — that also reminds me: "${hits[1].text}"` : ""));
}
async function say(t: string) { await pause(400); console.log(`🔵 Alexa: ${t}`); }
async function skip(days: number, quiet = false) {
  const r = await (await fetch(`${BASE}/api/timeskip`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ days }) })).json() as { days: number };
  if (!quiet) console.log(`\n⏩ ${days} days later… (server clock +${r.days}d)`);
}

const SCRIPT: (string | { skip: number } | { banner: string })[] = [
  { banner: "Session 1 · Monday evening" },
  "My daughter Mia loves strawberries.",
  "The farmers market sells strawberries on Saturday mornings.",
  "Mia has swimming practice on Monday at 5pm.",
  "Mia has swimming practice on Wednesday at 5pm.",
  "Mia has swimming practice on Friday at 5pm.",
  "Lunch was a forgettable tuna sandwich at the canteen.",
  "Important: Grandpa's hospital checkup is on November 3rd at 9am, ward 7B!",
  "Good night",
  { skip: 3 },
  { banner: "Session 2 · Thursday — a brand-new conversation" },
  "What does Mia love?",
  "When is Grandpa's checkup?",
  "Good night",
  { skip: 60 },
  { banner: "Session 3 · two months later" },
  "What did I have for lunch at the canteen?",
  "What happened in the weekly sync about the release?",
  "When does Mia swim?",
  "When is Grandpa's checkup?",
];

/** --with-history: give the agent a month of everyday life first (via MCP), so schemas and compression have material. */
async function history(days = 30) {
  console.log(`\n📚 Loading ${days} days of everyday memories (standups, commutes, lunches, journals)…`);
  let day = 0;
  await session(async c => { for (const m of corpus(days)) { while (day < m.day) { await c("sleep"); await skip(1, true); day++; } await c("remember", { text: m.text, salience: m.salience }); } });
}
async function scripted() {
  if (process.argv.includes("--with-history")) await history();
  for (const step of SCRIPT) {
    if (typeof step === "string") await session(c => turn(c, step));       // every turn = fresh MCP session
    else if ("skip" in step) await skip(step.skip);
    else { console.log(`\n━━━━━━━━ ${step.banner} ━━━━━━━━`); await pause(800); }
  }
  const st = await session(c => c("memory_stats"));
  console.log(`\n📊 ${st.memories} memories, ${st.schemas} schemas, stored ${st.storedBytes}B for ${st.rawBytes}B raw (${st.compressionRatio}x), lossy ${st.lossyMemories}, min fidelity ${st.minFidelity}, unrecoverable ${st.unrecoverable}`);
}
async function chat() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  for (;;) {
    const line = (await rl.question("\nyou> ")).trim(); if (!line) continue;
    if (line === "/quit") break;
    if (line.startsWith("/skip")) { await skip(Number(line.split(" ")[1] ?? 7)); continue; }
    if (line === "/sleep") { await session(c => turn(c, "good night")); continue; }
    if (line === "/stats") { console.log(await session(c => c("memory_stats"))); continue; }
    await session(c => turn(c, line));
  }
  rl.close();
}
await (process.argv.includes("--chat") ? chat() : scripted());
