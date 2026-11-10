import { stepCountIs, streamText, type LanguageModel } from "ai";
import { TtlCache } from "../lib/cache.js";
import { createSearchTool, type Hit, type SearchProvider } from "../tools/search.js";
import type { SourceRef, Store } from "../store/db.js";
import { buildLedger, splitMemory, toModelMessages } from "./memory.js";
import { buildSystem } from "./prompt.js";
import { SourceRegistry, type SearchLogEntry } from "./sources.js";

/** Round 1 searches, round 2 only if something unexpected turned up, last round must be the answer. */
export const MAX_STEPS = 3;
const MAX_OUTPUT_TOKENS = 1_500;

export interface AgentDeps {
  model: LanguageModel;
  provider: SearchProvider;
  store: Store;
  cache?: TtlCache<Hit[]>;
}

export interface SeedMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
}

export interface RunInput {
  sessionId: string;
  message: string;
  tz: string;
  /** Injectable clock: makes evals and tests deterministic. */
  now: Date;
  history?: SeedMessage[];
  signal?: AbortSignal;
}

export interface Metrics {
  ttftMs: number | null;
  totalMs: number;
  steps: number;
  searches: SearchLogEntry[];
}

export type AgentEvent =
  | { type: "status"; text: string }
  | { type: "token"; text: string }
  | { type: "reset" } // discard text streamed so far (a step that turned out to be tool preamble)
  | { type: "sources"; items: SourceRef[] }
  | { type: "done"; metrics: Metrics }
  | { type: "error"; message: string };

export function friendlyError(err: unknown): string {
  const status = (err as { statusCode?: number })?.statusCode;
  if (status === 401 || status === 403) return "The model provider rejected the API key. Check ANTHROPIC_API_KEY.";
  if (status === 429) return "The model provider is rate limiting requests. Please retry in a moment.";
  if (status === 529 || (status !== undefined && status >= 500)) return "The model provider is overloaded. Please retry.";
  return "Something went wrong while generating the answer. Please retry.";
}

const defaultCache = new TtlCache<Hit[]>(200, 10 * 60_000);

export async function* runAgent(deps: AgentDeps, input: RunInput): AsyncGenerator<AgentEvent> {
  const started = performance.now();
  const { store, model, provider, cache = defaultCache } = deps;
  const { sessionId, message, tz, now, signal } = input;

  try {
    store.ensureSession(sessionId, tz, now);
    if (input.history?.length) {
      store.addMessages(sessionId, input.history.map((h) => ({ role: h.role, content: h.content, createdAt: h.timestamp })));
    }
    const { live, earlier } = splitMemory(store.sessionMessages(sessionId), store.earlierMessages(sessionId, 400));
    const registry = new SourceRegistry();

    const result = streamText({
      model,
      system: buildSystem(now, tz, buildLedger(earlier, now, tz)),
      messages: toModelMessages(live, message, now, tz),
      tools: { web_search: createSearchTool({ provider, cache, registry }) },
      stopWhen: stepCountIs(MAX_STEPS),
      // On the final step force prose, so a step cap can never end the turn on a dangling tool call.
      prepareStep: ({ stepNumber }) => (stepNumber >= MAX_STEPS - 1 ? { toolChoice: "none" as const } : undefined),
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      abortSignal: signal,
      onError: () => {}, // surfaced below via the stream's error part
    });

    let answer = "";
    let stepText = "";
    let steps = 0;
    let ttftMs: number | null = null;

    for await (const part of result.fullStream) {
      if (part.type === "text-delta") {
        ttftMs ??= performance.now() - started;
        stepText += part.text;
        yield { type: "token", text: part.text };
      } else if (part.type === "tool-call") {
        const q = (part.input as { query?: string }).query ?? "";
        yield { type: "status", text: `Searching: ${q}` };
      } else if (part.type === "finish-step") {
        steps++;
        if (part.finishReason === "tool-calls") {
          if (stepText) yield { type: "reset" };
        } else {
          answer += stepText;
        }
        stepText = "";
      } else if (part.type === "error") {
        throw part.error;
      } else if (part.type === "abort") {
        return;
      }
    }
    if (signal?.aborted) return;
    if (!answer.trim()) throw new Error("model returned an empty answer");

    // floor, never round: the answer must not be stamped later than the instant the next queued turn can start.
    // Persist only a completed turn: a retry after a failure never duplicates the user's message.
    const sources = registry.cited(answer);
    const totalMs = performance.now() - started;
    store.addMessages(sessionId, [
      { role: "user", content: message, createdAt: now },
      { role: "assistant", content: answer, sources, createdAt: new Date(now.getTime() + Math.floor(totalMs)) },
    ]);

    if (sources.length) yield { type: "sources", items: sources };
    yield { type: "done", metrics: { ttftMs, totalMs, steps, searches: registry.log } };
  } catch (err) {
    if (signal?.aborted) return;
    console.error("[agent]", err);
    yield { type: "error", message: friendlyError(err) };
  }
}
