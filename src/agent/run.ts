import { stepCountIs, streamText } from "ai";
import { TtlCache } from "../lib/cache.js";
import { createSearchTool, type Hit, type SearchProvider } from "../tools/search.js";
import type { SourceRef, Store } from "../store/db.js";
import { buildLedger, splitMemory, toModelMessages } from "./memory.js";
import type { ModelPool, PoolEntry } from "./models.js";
import { buildSystem } from "./prompt.js";
import { normalizeCitations, SourceRegistry, type SearchLogEntry } from "./sources.js";

/** Round 1 searches, round 2 only if something unexpected turned up, last round must be the answer. */
export const MAX_STEPS = 3;
const MAX_OUTPUT_TOKENS = 2_500;
// Exhausted providers fail over immediately; only the last candidate is worth the SDK's own backoff-and-retry.
const LAST_RESORT_RETRIES = 2;

export interface AgentDeps {
  models: ModelPool;
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
  /** Which model produced the answer, and which ones failed before it. */
  model: string;
  fallbacks: { model: string; error: string }[];
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

/** Some weaker models emit their tool call as plain text. Never show that to a user; fail over instead. */
export const BROKEN_TOOL_MARKUP = /<\/?tool_call>|<arg_key>|<function=|<\|tool_call|\{"name":\s*"web_search"/i;

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 200);

interface Attempt {
  answer: string;
  sources: SourceRef[];
  steps: number;
  ttftMs: number | null;
  searches: SearchLogEntry[];
}

/** One full agent run on one model. Throws on any model/provider failure so the caller can fail over. */
async function* attempt(
  entry: PoolEntry, isLast: boolean, ctx: { provider: SearchProvider; cache: TtlCache<Hit[]>; started: number },
  prompt: { system: ReturnType<typeof buildSystem>; messages: ReturnType<typeof toModelMessages> },
  signal: AbortSignal | undefined,
): AsyncGenerator<AgentEvent, Attempt | undefined> {
  const registry = new SourceRegistry(); // fresh per attempt: a failed model's sources must not leak into the next
  const result = streamText({
    model: entry.model,
    system: prompt.system,
    messages: prompt.messages,
    tools: { web_search: createSearchTool({ provider: ctx.provider, cache: ctx.cache, registry }) },
    stopWhen: stepCountIs(MAX_STEPS),
    // On the final step force prose, so a step cap can never end the turn on a dangling tool call.
    prepareStep: ({ stepNumber }) => (stepNumber >= MAX_STEPS - 1 ? { toolChoice: "none" as const } : undefined),
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    maxRetries: isLast ? LAST_RESORT_RETRIES : 0,
    providerOptions: entry.providerOptions as never,
    abortSignal: signal,
    onError: () => {}, // surfaced below via the stream's error part
  });

  let answer = "";
  let stepText = "";
  let steps = 0;
  let ttftMs: number | null = null;

  for await (const part of result.fullStream) {
    if (part.type === "text-delta") {
      ttftMs ??= performance.now() - ctx.started;
      stepText += part.text;
      yield { type: "token", text: part.text };
    } else if (part.type === "tool-call") {
      yield { type: "status", text: `Searching: ${(part.input as { query?: string }).query ?? ""}` };
    } else if (part.type === "finish-step") {
      steps++;
      if (part.finishReason === "tool-calls") {
        if (stepText) yield { type: "reset" };
      } else {
        answer += stepText;
        if (part.finishReason === "length") {
          const note = "\n\n_(Answer cut off at the length limit. Ask me to continue.)_";
          answer += note;
          yield { type: "token", text: note };
        }
      }
      stepText = "";
    } else if (part.type === "error") {
      throw part.error;
    } else if (part.type === "abort") {
      return undefined;
    }
  }
  if (signal?.aborted) return undefined;
  // A weak model that returns nothing is a provider failure like any other: try the next one.
  if (!answer.trim()) throw new Error("model returned an empty answer");
  if (BROKEN_TOOL_MARKUP.test(answer)) throw new Error("model printed tool-call markup instead of calling the tool");
  answer = normalizeCitations(answer);
  return { answer, sources: registry.cited(answer), steps, ttftMs, searches: registry.log };
}

export async function* runAgent(deps: AgentDeps, input: RunInput): AsyncGenerator<AgentEvent> {
  const started = performance.now();
  const { store, models, provider, cache = defaultCache } = deps;
  const { sessionId, message, tz, now, signal } = input;

  try {
    store.ensureSession(sessionId, tz, now);
    if (input.history?.length) {
      store.addMessages(sessionId, input.history.map((h) => ({ role: h.role, content: h.content, createdAt: h.timestamp })));
    }
    const { live, earlier } = splitMemory(store.sessionMessages(sessionId), store.earlierMessages(sessionId, 400));
    const ledger = buildLedger(earlier, now, tz);
    const messages = toModelMessages(live, message, now, tz);

    const candidates = models.ordered();
    const fallbacks: Metrics["fallbacks"] = [];
    let outcome: Attempt | undefined;
    let used = "";

    for (const [i, entry] of candidates.entries()) {
      const isLast = i === candidates.length - 1;
      try {
        const run = yield* attempt(entry, isLast, { provider, cache, started }, { system: buildSystem(now, tz, ledger, entry.cacheable), messages }, signal);
        if (!run) return; // client aborted
        models.markOk(entry.name);
        outcome = run;
        used = entry.name;
        break;
      } catch (err) {
        if (signal?.aborted) return;
        console.error(`[agent] ${entry.name} failed:`, errorText(err));
        models.markFailed(entry.name, err);
        fallbacks.push({ model: entry.name, error: errorText(err) });
        if (isLast) throw err;
        yield { type: "reset" }; // discard whatever the failed model had streamed
        yield { type: "status", text: `${entry.name.split(":")[0]} unavailable, switching model` };
      }
    }
    if (!outcome) return;

    // floor, never round: the answer must not be stamped later than the instant the next queued turn can start.
    // Persist only a completed turn: a retry after a failure never duplicates the user's message.
    const totalMs = performance.now() - started;
    store.addMessages(sessionId, [
      { role: "user", content: message, createdAt: now },
      { role: "assistant", content: outcome.answer, sources: outcome.sources, createdAt: new Date(now.getTime() + Math.floor(totalMs)) },
    ]);

    if (outcome.sources.length) yield { type: "sources", items: outcome.sources };
    yield {
      type: "done",
      metrics: { model: used, fallbacks, ttftMs: outcome.ttftMs, totalMs, steps: outcome.steps, searches: outcome.searches },
    };
  } catch (err) {
    if (signal?.aborted) return;
    console.error("[agent] all providers failed:", errorText(err));
    yield { type: "error", message: friendlyError(err) };
  }
}
