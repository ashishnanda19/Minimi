import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import type { SearchProvider } from "../src/tools/search.js";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

export type Step =
  | { text?: string; tools?: { name?: string; input: object }[] }
  | { error: Error };

/** A model that plays back a fixed script: one entry per step of the agent loop. */
export function scriptedModel(steps: Step[]) {
  let i = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      const step = steps[Math.min(i++, steps.length - 1)]!;
      if ("error" in step) throw step.error;
      const parts: any[] = [{ type: "stream-start", warnings: [] }];
      if (step.text) {
        parts.push({ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: step.text }, { type: "text-end", id: "t" });
      }
      step.tools?.forEach((t, n) =>
        parts.push({ type: "tool-call", toolCallId: `c${i}-${n}`, toolName: t.name ?? "web_search", input: JSON.stringify(t.input) }),
      );
      parts.push({ type: "finish", finishReason: { unified: step.tools?.length ? "tool-calls" : "stop", raw: undefined }, usage });
      return { stream: convertArrayToReadableStream(parts) };
    },
  });
  return model;
}

export const fakeProvider = (results: Record<string, { title: string; url: string; content: string; publishedDate?: string }[]> = {}): SearchProvider => ({
  async search(req) {
    return results[req.query] ?? [{ title: `Result for ${req.query}`, url: `https://example.com/${encodeURIComponent(req.query)}`, content: `Content about ${req.query}` }];
  },
});

export async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const e of gen) out.push(e);
  return out;
}
