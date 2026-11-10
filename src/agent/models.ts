import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";

type ProviderOptions = Record<string, Record<string, unknown>>;
import type { Config, ProviderName } from "../config.js";

export interface PoolEntry {
  name: string;
  model: LanguageModel;
  /** Only Anthropic understands cache_control; other providers get one plain system string. */
  cacheable: boolean;
  /** Per-provider latency tuning, e.g. switching off hidden reasoning. */
  providerOptions?: ProviderOptions;
}

/**
 * How long the provider says to wait ("Please retry in 8.3s", "try again in 450ms", or a Retry-After header).
 * undefined when it gave no hint.
 */
export function retryAfterMs(err: unknown): number | undefined {
  const e = err as { message?: string; responseHeaders?: Record<string, string>; lastError?: unknown; errors?: unknown[] };
  const header = Number(e?.responseHeaders?.["retry-after"]);
  if (Number.isFinite(header) && header > 0) return header * 1000;
  const m = /(?:retry|try again) in ([\d.]+)\s*(ms|s)\b/i.exec(e?.message ?? "");
  if (m) return Number(m[1]) * (m[2]!.toLowerCase() === "ms" ? 1 : 1000);
  return e?.lastError ? retryAfterMs(e.lastError) : e?.errors?.length ? retryAfterMs(e.errors.at(-1)) : undefined;
}

const COOLDOWN_MS = { rateLimited: 60_000, maxRateLimited: 60 * 60_000, auth: 10 * 60_000, other: 30_000 };

export const statusOf = (err: unknown): number | undefined => {
  const e = err as { statusCode?: number; lastError?: { statusCode?: number } };
  return e?.statusCode ?? e?.lastError?.statusCode; // the SDK wraps exhausted retries in a RetryError
};

/**
 * Ordered list of models with failover. When a provider fails (rate limit, outage, bad key,
 * missing tool support) it is benched for a cooldown, so the *next* request goes straight to a
 * healthy one instead of paying for a doomed call first. Benched providers are still tried last
 * rather than never, so a total outage degrades to "try everything" and not "refuse everything".
 */
export class ModelPool {
  private readonly benchedUntil = new Map<string, number>();

  constructor(
    private readonly entries: PoolEntry[],
    private readonly clock: () => number = Date.now,
  ) {
    if (!entries.length) throw new Error("ModelPool needs at least one model");
  }

  static single(model: LanguageModel, name = "primary", cacheable = false): ModelPool {
    return new ModelPool([{ name, model, cacheable }]);
  }

  /** Healthy providers in configured order, then benched ones by soonest recovery. */
  ordered(): PoolEntry[] {
    const now = this.clock();
    const until = (e: PoolEntry) => this.benchedUntil.get(e.name) ?? 0;
    const healthy = this.entries.filter((e) => until(e) <= now);
    const benched = this.entries.filter((e) => until(e) > now).sort((a, b) => until(a) - until(b));
    return [...healthy, ...benched];
  }

  markFailed(name: string, err: unknown): void {
    const status = statusOf(err);
    // Honour the provider's own reset hint ("retry in 12h" for a daily quota), bounded so a dead
    // model is re-checked hourly rather than never.
    const hint = retryAfterMs(err);
    const ms = status === 429 ? Math.min(Math.max(hint ?? COOLDOWN_MS.rateLimited, 10_000), COOLDOWN_MS.maxRateLimited)
      : status === 401 || status === 403 || status === 404 ? COOLDOWN_MS.auth
      : COOLDOWN_MS.other;
    this.benchedUntil.set(name, this.clock() + ms);
  }

  markOk(name: string): void {
    this.benchedUntil.delete(name);
  }

  get names(): string[] {
    return this.entries.map((e) => e.name);
  }
}

/**
 * Search-and-summarise needs no deep reasoning, and hidden "thinking" is pure first-token latency.
 * Gemini 2.5 Flash thinks by default; gpt-oss defaults to medium reasoning effort.
 */
const TUNING: Partial<Record<ProviderName, ProviderOptions>> = {
  google: { google: { thinkingConfig: { thinkingBudget: 0 } } },
  groq: { groq: { reasoningEffort: "low" } },
};

export function buildPool(cfg: Config): ModelPool {
  const make: Record<ProviderName, (key: string, id: string) => LanguageModel> = {
    anthropic: (key, id) => createAnthropic({ apiKey: key })(id),
    google: (key, id) => createGoogleGenerativeAI({ apiKey: key })(id),
    groq: (key, id) => createGroq({ apiKey: key })(id),
    openrouter: (key, id) => createOpenRouter({ apiKey: key }).chat(id),
  };
  return new ModelPool(
    cfg.order.flatMap((p) =>
      cfg.models[p].map((id) => ({
        name: `${p}:${id}`,
        model: make[p](cfg.keys[p]!, id),
        cacheable: p === "anthropic",
        providerOptions: TUNING[p],
      })),
    ),
  );
}
