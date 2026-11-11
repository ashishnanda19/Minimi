import { stepCountIs, streamText } from "ai";
import { TtlCache } from "../lib/cache.js";
import { createSearchTool, type Hit, type SearchProvider } from "../tools/search.js";
import { DEFAULT_USER, type SourceRef, type Store } from "../store/db.js";
import { claimsBlock, gatherClaims, type PriorClaim } from "./claims.js";
import { classifyIntent, type IntentKind } from "./intent.js";
import { buildLedger, resolveLookup, splitMemory, toModelMessages } from "./memory.js";
import { civilOf, isoDate, resolveDateRefs } from "./temporal.js";
import { retryAfterMs, statusOf, type ModelPool, type PoolEntry } from "./models.js";
import { buildSystem } from "./prompt.js";
import { formatRecalled, retrieveRelevant } from "./retrieval.js";
import { normalizeCitations, SourceRegistry, stripInternalMarkers, type SearchLogEntry } from "./sources.js";
import { correctCitations, describeProblems, verifyAnswer, type EvidenceSource, type VerificationReport } from "./verify.js";

/** Round 1 searches, later rounds only if something unexpected turned up, the last round must be the answer. */
export const MAX_STEPS = 4;
const MAX_OUTPUT_TOKENS = 2_500;
// Exhausted providers fail over immediately; only the last candidate is worth the SDK's own backoff-and-retry.
const LAST_RESORT_RETRIES = 2;
/**
 * Deadlines. A provider stuck on "high demand" once held a turn for 75 s before erroring, so every model gets a
 * deadline for its first content, and a stalled stream is cut. The last candidate is allowed to be slow: nobody is left.
 */
export const TIMEOUTS = { firstChunkMs: 10_000, lastResortFirstChunkMs: 45_000, chunkMs: 15_000, toolMs: 20_000 };

export interface AgentDeps {
  models: ModelPool;
  provider: SearchProvider;
  store: Store;
  cache?: TtlCache<Hit[]>;
  memoryScope?: "global" | "session";
  /** Override the model deadlines (tests use tiny ones). */
  timeouts?: Partial<typeof TIMEOUTS>;
  /** Injectable so tests don't actually wait. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
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
  /** Whose chats these are. Memory, titles and the sidebar never cross users. */
  userId?: string;
  signal?: AbortSignal;
}

export interface Metrics {
  /** Which model produced the answer, and which ones failed before it. */
  model: string;
  fallbacks: { model: string; error: string; ms: number }[];
  ttftMs: number | null;
  /** Time until the user first sees "Searching: ..." */
  firstStatusMs: number | null;
  /** Wall-clock time spent waiting on searches. Compare with the sum of each search's ms to see the parallel speed-up. */
  searchWallMs: number;
  totalMs: number;
  steps: number;
  usage: Usage;
  searches: SearchLogEntry[];
  /** What the code decided about this turn before the model saw it. */
  intent: IntentKind;
  /** The answer was rewritten once because the checker found problems. */
  repaired: boolean;
  /** Citation numbers corrected in code (no model call). */
  citationsFixed: number;
  /** Earlier conversations found by topic, and earlier claims put on the re-verification checklist. */
  retrieved: number;
  priorClaims: number;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Tokens served from Anthropic's prompt cache (0 elsewhere). */
  cacheReadTokens: number;
}

export type AgentEvent =
  | { type: "status"; text: string }
  | { type: "token"; text: string }
  | { type: "reset" } // discard text streamed so far (a step that turned out to be tool preamble)
  | { type: "sources"; items: SourceRef[] }
  | { type: "verification"; report: VerificationReport }
  | { type: "done"; metrics: Metrics }
  | { type: "error"; message: string };

export function friendlyError(err: unknown): string {
  const status = (err as { statusCode?: number })?.statusCode;
  if (status === 401 || status === 403) return "The model provider rejected the API key. Check ANTHROPIC_API_KEY.";
  if (status === 429) return "The model provider is rate limiting requests. Please retry in a moment.";
  if (status === 529 || (status !== undefined && status >= 500)) return "The model provider is overloaded. Please retry.";
  return "Something went wrong while generating the answer. Please retry.";
}

/** If every provider is rate-limited, wait for the shortest hinted reset (capped) and go round once more. */
const MAX_RATE_LIMIT_WAIT_MS = 20_000;
const DEFAULT_RATE_LIMIT_WAIT_MS = 10_000;
/** A rate limit that resets within this long is waited out (once per turn) rather than skipped. */
const SHORT_RETRY_MS = 8_000;

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });

const defaultCache = new TtlCache<Hit[]>(200, 10 * 60_000);

/** Some weaker models emit their tool call as plain text. Never show that to a user; fail over instead. */
export const BROKEN_TOOL_MARKUP = /<\/?tool_call>|<arg_key>|<function=|<\|tool_call|\{"name":\s*"web_search"/i;

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 200);

interface Attempt {
  answer: string;
  sources: SourceRef[];
  steps: number;
  ttftMs: number | null;
  firstStatusMs: number | null;
  searchWallMs: number;
  usage: Usage;
  searches: SearchLogEntry[];
  registry: SourceRegistry;
  /** What was streamed to the user, before markers were stripped and citations normalised. */
  streamed: string;
}

/** One full agent run on one model. Throws on any model/provider failure so the caller can fail over. */
async function* attempt(
  entry: PoolEntry, isLast: boolean, ctx: { provider: SearchProvider; cache: TtlCache<Hit[]>; started: number; timeouts: typeof TIMEOUTS },
  prompt: { system: ReturnType<typeof buildSystem>; messages: ReturnType<typeof toModelMessages> },
  signal: AbortSignal | undefined,
  policy: { forbid: boolean; require: boolean },
): AsyncGenerator<AgentEvent, Attempt | undefined> {
  const registry = new SourceRegistry(); // fresh per attempt: a failed model's sources must not leak into the next

  // Deadline for the model's first content, re-armed for each model call. It aborts the real HTTP request, which also
  // covers a provider that never responds at all (the SDK's own firstChunk timeout only starts after the connection).
  const deadline = new AbortController();
  const firstContentMs = isLast ? ctx.timeouts.lastResortFirstChunkMs : ctx.timeouts.firstChunkMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => { disarm(); timer = setTimeout(() => deadline.abort(), firstContentMs); };
  const disarm = () => { if (timer) clearTimeout(timer); timer = undefined; };
  arm();

  const result = streamText({
    model: entry.model,
    system: prompt.system,
    messages: prompt.messages,
    tools: { web_search: createSearchTool({ provider: ctx.provider, cache: ctx.cache, registry }) },
    stopWhen: stepCountIs(MAX_STEPS),
    // Code, not the prompt, decides whether searching is allowed. Recall and small talk never search; re-verification must
    // search on its first step; and on the final step prose is forced, so a step cap can never end on a dangling tool call.
    prepareStep: ({ stepNumber }) =>
      policy.forbid || stepNumber >= MAX_STEPS - 1 ? { toolChoice: "none" as const }
      : stepNumber === 0 && policy.require ? { toolChoice: "required" as const }
      : undefined,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    maxRetries: isLast ? LAST_RESORT_RETRIES : 0,
    timeout: { chunkMs: ctx.timeouts.chunkMs, toolMs: ctx.timeouts.toolMs },
    providerOptions: entry.providerOptions as never,
    abortSignal: signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal,
    onError: () => {}, // surfaced below via the stream's error part
  });

  let answer = "";
  let stepText = "";
  let steps = 0;
  let ttftMs: number | null = null;
  let firstStatusMs: number | null = null;
  let searchWallMs = 0;
  let toolStart: number | null = null;
  let lastToolDone = 0;
  const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };

  try {
    for await (const part of result.fullStream) {
      if (part.type === "text-delta" || part.type === "tool-call" || part.type === "reasoning-delta") disarm();
      if (part.type === "text-delta") {
        ttftMs ??= performance.now() - ctx.started;
        stepText += part.text;
        yield { type: "token", text: part.text };
      } else if (part.type === "tool-call") {
        firstStatusMs ??= performance.now() - ctx.started;
        toolStart ??= performance.now();
        yield { type: "status", text: `Searching: ${(part.input as { query?: string }).query ?? ""}` };
      } else if (part.type === "tool-result" || part.type === "tool-error") {
        lastToolDone = performance.now();
      } else if (part.type === "finish-step") {
        steps++;
        usage.inputTokens += part.usage.inputTokens ?? 0;
        usage.outputTokens += part.usage.outputTokens ?? 0;
        usage.cacheReadTokens += part.usage.inputTokenDetails?.cacheReadTokens ?? 0;
        if (toolStart !== null) searchWallMs += Math.max(0, lastToolDone - toolStart);
        toolStart = null;
        if (part.finishReason === "tool-calls") arm(); // the next model call starts now
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
        if (signal?.aborted) return undefined; // the user cancelled
        throw new Error("model timed out"); // our own deadline fired: that is a provider failure, not a cancellation
      }
    }
  } finally {
    disarm();
  }
  if (signal?.aborted) return undefined;
  // A weak model that returns nothing is a provider failure like any other: try the next one.
  if (!answer.trim()) throw new Error("model returned an empty answer");
  if (BROKEN_TOOL_MARKUP.test(answer)) throw new Error("model printed tool-call markup instead of calling the tool");
  const streamed = answer;
  answer = stripInternalMarkers(normalizeCitations(answer));
  // Searched, got results, then stated facts with no citation: a weaker model ignoring the rules.
  // Hand the turn to the next model; the last candidate's answer is accepted as is.
  if (!isLast && registry.log.some((l) => l.results > 0) && !/\[\d+/.test(answer) && /\d/.test(answer)) {
    throw new Error("model searched but cited no sources");
  }
  return { answer, sources: registry.cited(answer), steps, ttftMs, firstStatusMs, searchWallMs, usage, searches: registry.log, registry, streamed };
}

const REPAIR_SYSTEM =
  "You correct a draft answer so that it is fully supported by the evidence provided. You never add facts that the evidence does not contain.";

/**
 * One repair pass. The checker found figures or citations the evidence does not support; the same model gets the
 * evidence, its draft and the exact problems, and rewrites. Streams the rewrite so the user watches the correction.
 */
async function* repairAnswer(
  entry: PoolEntry,
  args: { question: string; draft: string; evidence: EvidenceSource[]; earlier: string; problems: string[]; timeoutMs: number },
  signal: AbortSignal | undefined,
): AsyncGenerator<AgentEvent, string | undefined> {
  const evidence = args.evidence
    .map((e) => `[${e.id}] ${e.title} | ${e.url}${e.published ? ` | published ${e.published}` : ""}\n${e.text}`)
    .join("\n\n");
  const prompt = [
    `USER QUESTION:\n${args.question}`,
    `EVIDENCE FROM THE WEB THIS TURN:\n${evidence || "(no web evidence this turn)"}`,
    args.earlier ? `EARLIER CONVERSATION (things you already told the user; you may restate them, but as what you said then, with the date):\n${args.earlier}` : "",
    `YOUR DRAFT ANSWER:\n${args.draft}`,
    `PROBLEMS FOUND BY THE CHECKER:\n${args.problems.map((p) => `- ${p}`).join("\n")}`,
    "Rewrite the answer fixing every problem. Never delete a fact just because it is missing from the web evidence: if the earlier conversation contains it, keep it and attribute it to when you said it. Keep citation numbers exactly as in the evidence, keep the same structure and a similar length, and where the evidence cannot support a claim say you could not verify it. Output only the corrected answer.",
  ].filter(Boolean).join("\n\n");

  const timeout = AbortSignal.timeout(args.timeoutMs);
  const result = streamText({
    model: entry.model,
    system: REPAIR_SYSTEM,
    messages: [{ role: "user", content: prompt }],
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    maxRetries: 0,
    providerOptions: entry.providerOptions as never,
    abortSignal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    onError: () => {},
  });
  let text = "";
  for await (const part of result.fullStream) {
    if (part.type === "text-delta") {
      text += part.text;
      yield { type: "token", text: part.text };
    } else if (part.type === "error") throw part.error;
    else if (part.type === "abort") return undefined;
  }
  return stripInternalMarkers(normalizeCitations(text));
}

export async function* runAgent(deps: AgentDeps, input: RunInput): AsyncGenerator<AgentEvent> {
  const started = performance.now();
  const { store, models, provider, cache = defaultCache, sleep = defaultSleep, memoryScope = "global" } = deps;
  const timeouts = { ...TIMEOUTS, ...deps.timeouts };
  const { sessionId, message, tz, now, signal } = input;
  const userId = input.userId ?? DEFAULT_USER;

  try {
    store.ensureSession(sessionId, tz, now, userId);
    if (input.history?.length) {
      store.addMessages(sessionId, input.history.map((h) => ({ role: h.role, content: h.content, createdAt: h.timestamp })));
    }

    // ---- remember: what the user has said, what is stored for the days they named, what they discussed on this topic ----
    const sessionMsgs = store.sessionMessages(sessionId);
    const global = memoryScope === "global";
    const otherChats = global ? store.earlierMessages(sessionId, 400, userId) : [];
    const { live, earlier } = splitMemory(sessionMsgs, otherChats);
    const ledger = buildLedger(earlier, now, tz);
    const lookup = resolveLookup(
      message,
      {
        between: (from, to) => store.messagesBetween(userId, from, to).filter((m) => global || m.sessionId === sessionId),
        activeDays: () => store.userMessageTimes(userId),
      },
      now, tz,
    );
    const recalled = global ? retrieveRelevant(store, userId, message, sessionId, now) : [];
    const retrievedText = recalled.length ? formatRecalled(recalled, now, tz) : "";

    // ---- reason: turn earlier answers into a checklist of claims, then decide in code whether searching is allowed or required ----
    const priorClaims: PriorClaim[] = gatherClaims([
      ...live.filter((m) => m.role === "assistant").slice(-4),
      ...lookup.messages,
      ...recalled.flatMap((r) => (r.answerMessage ? [r.answerMessage] : [])),
    ]).slice(0, 12);
    const hasContext = live.length > 0 || recalled.length > 0 || lookup.messages.length > 0 || earlier.length > 0;
    const intent = classifyIntent(message, { hasDateRefs: lookup.text !== "", hasPriorClaims: priorClaims.length > 0, hasContext });
    const claimsText = intent.kind === "reverify" || intent.kind === "change" ? claimsBlock(priorClaims, tz) : "";
    const messages = toModelMessages(live, message, now, tz);
    const extras = {
      lookup: lookup.text, retrieved: retrievedText, claims: claimsText,
      searchPolicy: intent.clarify ? ("clarify" as const) : intent.forbidSearch ? ("forbid" as const) : intent.requireSearch ? ("require" as const) : undefined,
    };

    const fallbacks: Metrics["fallbacks"] = [];
    let outcome: Attempt | undefined;
    let used = "";

    let shortRetryUsed = false;
    for (let round = 0; round < 2 && !outcome; round++) {
      const candidates = models.ordered();
      const waits: number[] = [];
      let allRateLimited = true;
      let lastErr: unknown;

      for (let i = 0; i < candidates.length; i++) {
        const entry = candidates[i]!;
        const isLast = i === candidates.length - 1;
        const attemptStart = performance.now();
        try {
          const run = yield* attempt(
            entry, isLast, { provider, cache, started, timeouts },
            { system: buildSystem(now, tz, ledger, entry.cacheable, extras), messages }, signal,
            { forbid: intent.forbidSearch, require: intent.requireSearch },
          );
          if (!run) return; // client aborted
          models.markOk(entry.name, performance.now() - attemptStart);
          outcome = run;
          used = entry.name;
          break;
        } catch (err) {
          if (signal?.aborted) return;
          console.error(`[agent] ${entry.name} failed:`, errorText(err));

          // A rate limit about to reset (Groq: "try again in 4s") is cheaper to wait out than a cascade to slower models.
          const hint = statusOf(err) === 429 ? retryAfterMs(err) : undefined;
          if (!shortRetryUsed && !isLast && hint !== undefined && hint <= SHORT_RETRY_MS) {
            shortRetryUsed = true;
            const ms = Math.ceil(hint + 300);
            yield { type: "reset" };
            yield { type: "status", text: `${entry.name.split(":")[0]} is busy, retrying in ${Math.ceil(ms / 1000)}s` };
            await sleep(ms, signal);
            if (signal?.aborted) return;
            i--; // same model again
            continue;
          }

          models.markFailed(entry.name, err);
          fallbacks.push({ model: entry.name, error: errorText(err), ms: performance.now() - attemptStart });
          lastErr = err;
          if (statusOf(err) === 429) waits.push(retryAfterMs(err) ?? DEFAULT_RATE_LIMIT_WAIT_MS);
          else allRateLimited = false;
          if (!isLast) {
            yield { type: "reset" }; // discard whatever the failed model had streamed
            yield { type: "status", text: `${entry.name.split(":")[0]} unavailable, switching model` };
          }
        }
      }
      if (outcome) break;

      // Everyone is throttled: waiting a few seconds beats showing an error.
      const wait = Math.min(...waits);
      if (round === 0 && allRateLimited && wait <= MAX_RATE_LIMIT_WAIT_MS) {
        const ms = Math.ceil(wait + 500);
        yield { type: "reset" };
        yield { type: "status", text: `All models are rate-limited. Retrying in ${Math.ceil(ms / 1000)}s` };
        await sleep(ms, signal);
        if (signal?.aborted) return;
        continue;
      }
      throw lastErr;
    }
    if (!outcome) return;

    // If cleaning changed the text the user already watched stream in, show them the clean version.
    if (outcome.answer !== outcome.streamed.trim() && outcome.answer !== outcome.streamed) {
      yield { type: "reset" };
      yield { type: "token", text: outcome.answer };
    }

    // ---- verify: check every figure and citation against what the answer was written from; repair once if needed ----
    const evidence = outcome.registry.evidence();
    const memoryText = [ledger, live.map((m) => m.content).join("\n"), retrievedText, claimsText, lookup.text, message].join("\n");
    // The window the user asked about: from the earliest day they named, else from when the earlier claims were made.
    const named = resolveDateRefs(message, now, tz).map((r) => isoDate(r.date)).sort();
    const windowStart = named[0] ?? (priorClaims.length ? isoDate(civilOf(new Date(Math.min(...priorClaims.map((c) => c.when.getTime()))), tz)) : undefined);
    const check = (answer: string) =>
      verifyAnswer({
        answer, evidence, memoryText, priorClaims,
        searched: outcome!.searches.some((s) => s.results > 0),
        recall: intent.kind === "recall" || intent.kind === "chat",
        reverify: intent.kind === "reverify" || intent.kind === "change",
        windowStart,
        now,
      });
    let finalAnswer = outcome.answer;
    let report = check(finalAnswer);
    let repaired = false;
    let citationsFixed = 0;

    // Cheapest fix first: a wrong citation number is corrected in code, with no model call.
    const corrected = correctCitations(finalAnswer, report, evidence);
    if (corrected.fixed > 0) {
      const after = check(corrected.answer);
      if (describeProblems(after).length < describeProblems(report).length) {
        yield { type: "reset" };
        yield { type: "token", text: corrected.answer };
        finalAnswer = corrected.answer; report = after; citationsFixed = corrected.fixed;
      }
    }
    const problems = describeProblems(report);
    if (!report.ok && problems.length) {
      const entry = models.ordered().find((e) => e.name === used);
      if (entry) {
        yield { type: "status", text: "Double-checking the figures against the sources" };
        try {
          const draft = finalAnswer;
          yield { type: "reset" };
          const fixed = yield* repairAnswer(entry, { question: message, draft, evidence, earlier: [retrievedText, claimsText, lookup.text].filter(Boolean).join("\n"), problems, timeoutMs: 25_000 }, signal);
          if (signal?.aborted) return;
          const fixedReport = fixed?.trim() && !BROKEN_TOOL_MARKUP.test(fixed) ? check(fixed) : undefined;
          if (fixed && fixedReport && describeProblems(fixedReport).length < problems.length) {
            finalAnswer = fixed; report = fixedReport; repaired = true;
          } else { // the rewrite was no better: put the original back in front of the user
            yield { type: "reset" };
            yield { type: "token", text: draft };
          }
        } catch (err) {
          if (signal?.aborted) return;
          console.error("[agent] repair failed:", errorText(err));
          yield { type: "reset" };
          yield { type: "token", text: finalAnswer };
        }
      }
    }

    // floor, never round: the answer must not be stamped later than the instant the next queued turn can start.
    // Persist only a completed turn: a retry after a failure never duplicates the user's message.
    const totalMs = performance.now() - started;
    const sources = outcome.registry.cited(finalAnswer);
    store.addMessages(sessionId, [
      { role: "user", content: message, createdAt: now },
      { role: "assistant", content: finalAnswer, sources, verification: report, createdAt: new Date(now.getTime() + Math.floor(totalMs)) },
    ]);

    if (sources.length) yield { type: "sources", items: sources };
    yield { type: "verification", report };
    yield {
      type: "done",
      metrics: {
        model: used, fallbacks, ttftMs: outcome.ttftMs, firstStatusMs: outcome.firstStatusMs, searchWallMs: outcome.searchWallMs,
        totalMs, steps: outcome.steps, usage: outcome.usage, searches: outcome.searches,
        intent: intent.kind, repaired, citationsFixed, retrieved: recalled.length, priorClaims: priorClaims.length,
      },
    };
  } catch (err) {
    if (signal?.aborted) return;
    console.error("[agent] all providers failed:", errorText(err));
    yield { type: "error", message: friendlyError(err) };
  }
}
