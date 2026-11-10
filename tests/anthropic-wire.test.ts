import { createAnthropic } from "@ai-sdk/anthropic";
import { describe, expect, it } from "vitest";
import { ModelPool } from "../src/agent/models.js";
import { runAgent } from "../src/agent/run.js";
import { Store } from "../src/store/db.js";
import { collect, fakeProvider } from "./helpers.js";

const sse = (events: object[]) =>
  new Response(events.map((e) => `event: ${(e as any).type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });

const start = { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } };
const textTurn = (text: string) => sse([
  start,
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } },
  { type: "message_stop" },
]);
const toolTurn = (queries: string[]) => sse([
  start,
  ...queries.flatMap((q, i) => [
    { type: "content_block_start", index: i, content_block: { type: "tool_use", id: `tu_${i}`, name: "web_search", input: {} } },
    { type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify({ query: q }) } },
    { type: "content_block_stop", index: i },
  ]),
  { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 5 } },
  { type: "message_stop" },
]);

describe("what we actually send to Anthropic", () => {
  it("marks the static rules cacheable, ships one web_search tool, and completes a tool loop", async () => {
    const bodies: any[] = [];
    const replies = [toolTurn(["hubspot pricing", "pipedrive pricing"]), textTurn("Answer [1][2].")];
    const fetchStub = (async (_url: unknown, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      return replies.shift()!;
    }) as typeof fetch;

    const model = createAnthropic({ apiKey: "test", fetch: fetchStub })("claude-sonnet-5-5");
    const store = new Store(":memory:");
    const events = await collect(runAgent({ models: ModelPool.single(model, "anthropic", true), provider: fakeProvider(), store }, {
      sessionId: "s", message: "compare", tz: "UTC", now: new Date("2026-11-10T13:15:00Z"),
    }));

    expect(events.at(-1)?.type).toBe("done");
    expect(bodies).toHaveLength(2);
    const first = bodies[0];
    expect(first.model).toBe("claude-sonnet-5-5");
    expect(first.stream).toBe(true);
    expect(first.tools.map((t: any) => t.name)).toEqual(["web_search"]); // exactly ONE tool
    expect(first.tools[0].input_schema.properties).toHaveProperty("since");

    const blocks = Array.isArray(first.system) ? first.system : [{ text: first.system }];
    expect(blocks[0].cache_control).toEqual({ type: "ephemeral" });
    expect(blocks[0].text).toContain("You are Minimi");
    expect(blocks.map((b: any) => b.text).join("\n")).toContain("Calendar (authoritative");
    expect(blocks.at(-1).cache_control).toBeUndefined(); // the volatile block must not be cached

    expect(first.messages[0].role).toBe("user");
    // second request carries both parallel tool results back in a single user turn
    const toolResults = bodies[1].messages.at(-1).content.filter((c: any) => c.type === "tool_result");
    expect(toolResults).toHaveLength(2);
    // last allowed step is not forced here (2 of 3), but tool_choice must be valid JSON the API accepts
    expect(bodies[1].tool_choice === undefined || typeof bodies[1].tool_choice === "object").toBe(true);
  });

  it("on the last allowed step, forbids tool use in a form the API accepts", async () => {
    const bodies: any[] = [];
    const replies = [toolTurn(["a one"]), toolTurn(["b two"]), textTurn("Done.")];
    const fetchStub = (async (_u: unknown, init: RequestInit) => { bodies.push(JSON.parse(init.body as string)); return replies.shift()!; }) as typeof fetch;
    const model = createAnthropic({ apiKey: "test", fetch: fetchStub })("claude-sonnet-5-5");
    await collect(runAgent({ models: ModelPool.single(model, "anthropic", true), provider: fakeProvider(), store: new Store(":memory:") }, {
      sessionId: "s", message: "q", tz: "UTC", now: new Date("2026-11-10T13:15:00Z"),
    }));
    expect(bodies).toHaveLength(3);
    expect(bodies[2].tool_choice?.type === "none" || !bodies[2].tools).toBe(true);
  });
});
