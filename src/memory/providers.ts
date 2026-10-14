// Pluggable embedding + LLM providers. Defaults are local and deterministic.
import { termFreq, extractiveSummary } from "./text.js";

export interface Embedder { name: string; embed(text: string): Promise<Record<string, number>>; }
export interface Summarizer {
  name: string;
  summarize(text: string): Promise<string>;
  reconstruct(gist: string[], context: string[]): Promise<string>;
}

/** Default: sparse log-scaled term-frequency vector (cosine ≈ keyword overlap). */
export const localEmbedder: Embedder = {
  name: "local-tf",
  async embed(text) {
    const tf = termFreq(text);
    for (const k in tf) tf[k] = 1 + Math.log(tf[k]);
    return tf;
  },
};

export const extractiveSummarizer: Summarizer = {
  name: "extractive",
  async summarize(text) { return extractiveSummary(text); },
  async reconstruct(gist, context) {
    const ctx = context.filter(Boolean).slice(0, 2).join(" / ");
    return `[reconstructed] Something about ${gist.join(", ")}` + (ctx ? `; related: ${ctx}` : "");
  },
};

/** Optional OpenAI-compatible chat summarizer (set MEMORY_LLM=openai + OPENAI_API_KEY, optional OPENAI_BASE_URL/OPENAI_MODEL). */
function openAISummarizer(): Summarizer {
  const base = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
  const model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
  const chat = async (prompt: string) => {
    const r = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], max_tokens: 120 }),
    });
    if (!r.ok) throw new Error(`LLM ${r.status}`);
    const j = (await r.json()) as { choices: { message: { content: string } }[] };
    return j.choices[0].message.content.trim();
  };
  return {
    name: `openai:${model}`,
    async summarize(text) { try { return await chat(`Summarize this memory in one short sentence:\n${text}`); } catch { return extractiveSummary(text); } },
    async reconstruct(gist, context) {
      try { return "[reconstructed] " + await chat(`A faded memory has keywords: ${gist.join(", ")}. Related memories: ${context.join(" | ")}. Reconstruct the most plausible one-sentence memory, hedged.`); }
      catch { return extractiveSummarizer.reconstruct(gist, context); }
    },
  };
}

export function summarizerFromEnv(): Summarizer {
  if (process.env.MEMORY_LLM === "openai" && process.env.OPENAI_API_KEY) return openAISummarizer();
  // Bedrock hook: implement Summarizer with @aws-sdk/client-bedrock-runtime when MEMORY_LLM=bedrock.
  return extractiveSummarizer;
}
