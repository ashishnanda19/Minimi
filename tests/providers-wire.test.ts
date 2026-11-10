import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { describe, expect, it } from "vitest";
import { ModelPool } from "../src/agent/models.js";
import { runAgent, type AgentEvent } from "../src/agent/run.js";
import { Store } from "../src/store/db.js";
import { collect, fakeProvider } from "./helpers.js";

const sse = (chunks: (object | "[DONE]")[]) =>
  new Response(chunks.map((c) => `data: ${c === "[DONE]" ? c : JSON.stringify(c)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });

// OpenAI-compatible chat completions (Groq, OpenRouter)
const oaiChunk = (delta: object, finish: string | null = null) =>
  ({ id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] });
const oaiToolTurn = (queries: string[]) => sse([
  oaiChunk({ role: "assistant", tool_calls: queries.map((q, i) => ({ index: i, id: `call_${i}`, type: "function", function: { name: "web_search", arguments: JSON.stringify({ query: q }) } })) }),
  oaiChunk({}, "tool_calls"),
  { ...oaiChunk({}), choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
  "[DONE]",
]);
const oaiTextTurn = (text: string) => sse([oaiChunk({ role: "assistant", content: text }), oaiChunk({}, "stop"), { ...oaiChunk({}), choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }, "[DONE]"]);

// Gemini streamGenerateContent
const gemChunk = (parts: object[], finishReason?: string) =>
  ({ candidates: [{ content: { role: "model", parts }, ...(finishReason ? { finishReason } : {}), index: 0 }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } });
const gemToolTurn = (queries: string[]) => sse([gemChunk(queries.map((q) => ({ functionCall: { name: "web_search", args: { query: q } } })), "STOP")]);
const gemTextTurn = (text: string) => sse([gemChunk([{ text }], "STOP")]);

async function drive(make: (fetch: typeof globalThis.fetch) => any, replies: Response[]) {
  const bodies: any[] = [];
  const fetchStub = (async (url: unknown, init: RequestInit) => {
    bodies.push({ url: String(url), body: JSON.parse(init.body as string) });
    return replies.shift()!;
  }) as typeof fetch;
  const events = await collect(runAgent(
    { models: ModelPool.single(make(fetchStub), "p"), provider: fakeProvider(), store: new Store(":memory:") },
    { sessionId: "s", message: "compare two tools", tz: "UTC", now: new Date("2026-11-10T13:15:00Z") },
  ));
  return { events, bodies };
}
const answer = (events: AgentEvent[]) => events.filter((e) => e.type === "token").map((e: any) => e.text).join("");

describe("Gemini (free tier)", () => {
  it("accepts our tool schema, runs parallel tool calls, and returns the answer", async () => {
    const { events, bodies } = await drive(
      (fetch) => createGoogleGenerativeAI({ apiKey: "k", fetch })("gemini-2.5-flash"),
      [gemToolTurn(["alpha pricing", "beta pricing"]), gemTextTurn("Alpha is cheaper [1].")],
    );
    expect(events.at(-1)?.type).toBe("done");
    expect(answer(events)).toContain("Alpha is cheaper");
    const decls = bodies[0].body.tools[0].functionDeclarations;
    expect(decls.map((d: any) => d.name)).toEqual(["web_search"]);
    expect(Object.keys(decls[0].parametersJsonSchema.properties)).toEqual(["query", "since", "topic", "maxResults"]);
    expect(bodies[0].body.systemInstruction.parts.length).toBe(1); // one system instruction
    expect(bodies[1].body.contents.at(-1).parts.filter((p: any) => p.functionResponse)).toHaveLength(2);
  });
});

for (const [label, make, url] of [
  ["Groq", (fetch: typeof globalThis.fetch) => createGroq({ apiKey: "k", fetch })("llama-3.3-70b-versatile"), "groq"],
  ["OpenRouter", (fetch: typeof globalThis.fetch) => createOpenRouter({ apiKey: "k", fetch }).chat("openrouter/free"), "openrouter"],
] as const) {
  describe(`${label} (free tier)`, () => {
    it("runs parallel tool calls and returns the answer", async () => {
      const { events, bodies } = await drive(make, [oaiToolTurn(["alpha pricing", "beta pricing"]), oaiTextTurn("Alpha is cheaper [1].")]);
      expect(events.at(-1)?.type).toBe("done");
      expect(answer(events)).toContain("Alpha is cheaper");
      expect(bodies[0].url).toContain(url);
      expect(bodies[0].body.tools.map((t: any) => t.function.name)).toEqual(["web_search"]);
      expect(bodies[0].body.messages.filter((m: any) => m.role === "system")).toHaveLength(1);
      expect(bodies[1].body.messages.filter((m: any) => m.role === "tool")).toHaveLength(2);
    });
  });
}
