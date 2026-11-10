import "dotenv/config";

export type ProviderName = "anthropic" | "google" | "groq" | "openrouter";

export interface Config {
  keys: Partial<Record<ProviderName, string>>;
  models: Record<ProviderName, string>;
  /** Providers that have a key, in the order they are tried. */
  order: ProviderName[];
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
      anthropic: get("ANTHROPIC_MODEL") ?? "claude-sonnet-5-5",
      google: get("GEMINI_MODEL") ?? "gemini-2.5-flash",
      groq: get("GROQ_MODEL") ?? "llama-3.3-70b-versatile",
      // The router picks a currently-free model that supports tool calling; a fixed ":free" id can vanish.
      openrouter: get("OPENROUTER_MODEL") ?? "openrouter/free",
    },
    tavilyKey: get("TAVILY_API_KEY")!,
    port: Number(env.PORT) || 3000,
    dbPath: get("DB_PATH") ?? "./data/minimi.db",
    defaultTz: get("DEFAULT_TZ") ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}
