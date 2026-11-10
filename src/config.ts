import "dotenv/config";

export type ProviderName = "anthropic" | "google" | "groq" | "openrouter";

export interface Config {
  keys: Partial<Record<ProviderName, string>>;
  /** Models per provider, tried in order. Quotas are per model, so a list multiplies free capacity. */
  models: Record<ProviderName, string[]>;
  /** Providers that have a key, in the order they are tried. */
  order: ProviderName[];
  /** "global": other chats feed the ledger (default). "session": each chat sees only itself. */
  memoryScope: "global" | "session";
  tavilyKey: string;
  port: number;
  dbPath: string;
  defaultTz: string;
}

const ENV_KEYS: Record<ProviderName, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  groq: "GROQ_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

/** Quality order: best tool-use and instruction-following first, most throttled free tier last. */
const DEFAULT_ORDER: ProviderName[] = ["anthropic", "google", "groq", "openrouter"];

/** Fails fast with one actionable message instead of a stack trace on the first chat. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const get = (k: string) => env[k]?.trim() || undefined;
  const keys: Config["keys"] = {};
  for (const [name, envName] of Object.entries(ENV_KEYS)) {
    const v = get(envName);
    if (v) keys[name as ProviderName] = v;
  }

  const list = (name: string, fallback: string) => (get(name) ?? fallback).split(",").map((m) => m.trim()).filter(Boolean);
  const wanted = (get("LLM_ORDER")?.split(",").map((s) => s.trim()) ?? DEFAULT_ORDER) as ProviderName[];
  const order = wanted.filter((p) => keys[p]);

  const problems: string[] = [];
  if (!order.length) problems.push("at least one model key (GOOGLE_GENERATIVE_AI_API_KEY, GROQ_API_KEY, OPENROUTER_API_KEY or ANTHROPIC_API_KEY)");
  if (!get("TAVILY_API_KEY")) problems.push("TAVILY_API_KEY");
  if (problems.length) {
    throw new Error(`Missing ${problems.join(" and ")}. Copy .env.example to .env and fill it in (see README for where to get keys).`);
  }

  return {
    keys,
    order,
    models: {
      anthropic: list("ANTHROPIC_MODEL", get("MODEL") ?? "claude-sonnet-5-5"), // MODEL is the plan's original name
      // Free-tier daily quotas are per model (gemini-2.5-flash is only 20/day), so chain several.
      google: list("GEMINI_MODEL", "gemini-3.5-flash,gemini-3.6-flash,gemini-3.1-flash-lite,gemini-2.5-flash-lite"),
      // Per-model token-per-minute caps on the free tier, so two models double the headroom.
      groq: list("GROQ_MODEL", "openai/gpt-oss-120b,openai/gpt-oss-20b"),
      // Pinned, not the "openrouter/free" router: a random pick once returned raw tool-call markup as the answer.
      openrouter: list("OPENROUTER_MODEL", "google/gemma-4-31b-it:free,nvidia/nemotron-3-ultra-550b-a55b:free"),
    },
    memoryScope: get("MEMORY_SCOPE") === "session" ? "session" : "global",
    tavilyKey: get("TAVILY_API_KEY")!,
    port: Number(env.PORT) || 3000,
    dbPath: get("DB_PATH") ?? "./data/minimi.db",
    defaultTz: get("DEFAULT_TZ") ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}
