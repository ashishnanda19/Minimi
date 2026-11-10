import "dotenv/config";

export interface Config {
  anthropicKey: string;
  tavilyKey: string;
  model: string;
  port: number;
  dbPath: string;
  defaultTz: string;
}

/** Fails fast with one actionable message instead of a stack trace on the first chat. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const missing = ["ANTHROPIC_API_KEY", "TAVILY_API_KEY"].filter((k) => !env[k]?.trim());
  if (missing.length) {
    throw new Error(
      `Missing ${missing.join(" and ")}. Copy .env.example to .env and fill it in (see README for where to get keys).`,
    );
  }
  return {
    anthropicKey: env.ANTHROPIC_API_KEY!.trim(),
    tavilyKey: env.TAVILY_API_KEY!.trim(),
    model: env.MODEL?.trim() || "claude-sonnet-5-5",
    port: Number(env.PORT) || 3000,
    dbPath: env.DB_PATH?.trim() || "./data/minimi.db",
    defaultTz: env.DEFAULT_TZ?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}
