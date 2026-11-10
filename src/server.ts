import { createAnthropic } from "@ai-sdk/anthropic";
import { serve } from "@hono/node-server";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { runAgent, type AgentDeps, type AgentEvent } from "./agent/run.js";
import { isValidTimezone } from "./agent/temporal.js";
import { loadConfig } from "./config.js";
import { KeyedLock } from "./lib/keyedLock.js";
import { Store } from "./store/db.js";
import { TavilyProvider } from "./tools/search.js";

const chatBody = z.object({
  sessionId: z.string().regex(/^[\w-]{1,100}$/).optional(),
  message: z.string().trim().min(1, "message is empty").max(4_000),
  tz: z.string().optional(),
  /** Test hook: pretend it is this instant. Lets a harness replay "last Tuesday" scenarios deterministically. */
  now: z.iso.datetime({ offset: true }).optional(),
  /** Seeds prior turns with their original timestamps (idempotent). */
  history: z
    .array(z.object({
      role: z.enum(["user", "assistant"]),
      content: z.string().min(1).max(8_000),
      timestamp: z.union([z.string(), z.number()]).optional(), // ISO, date-only or unix ms; spaced back from now if absent
    }))
    .max(200)
    .optional(),
});

const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));
const STATIC_FILES: Record<string, string> = { "/": "index.html", "/markdown.js": "markdown.js" };
const CONTENT_TYPES: Record<string, string> = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8" };

export function createApp(deps: AgentDeps & { defaultTz: string }) {
  const app = new Hono();
  const lock = new KeyedLock();

  for (const [route, file] of Object.entries(STATIC_FILES)) {
    app.get(route, async (c) => {
      const body = await readFile(PUBLIC_DIR + file, "utf8");
      return c.body(body, 200, { "content-type": CONTENT_TYPES[file.split(".").pop()!]!, "cache-control": "no-cache" });
    });
  }

  app.get("/health", (c) => c.json({ ok: true }));

  app.get("/api/history", (c) => {
    const sessionId = c.req.query("sessionId") ?? "";
    const messages = deps.store.sessionMessages(sessionId).map((m) => ({
      role: m.role, content: m.content, sources: m.sources, timestamp: m.createdAt.toISOString(),
    }));
    return c.json({ sessionId, tz: deps.store.sessionTz(sessionId) ?? null, messages });
  });

  app.post("/api/chat", async (c) => {
    const parsed = chatBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") }, 400);
    }
    const b = parsed.data;
    const sessionId = b.sessionId ?? randomUUID();
    const tz = [b.tz, deps.store.sessionTz(sessionId), deps.defaultTz].find((t) => t && isValidTimezone(t))!;
    // The clock is read when the turn actually starts (inside the lock), not when the request arrived,
    // so queued requests on one session are stamped in the order they run.
    const input = () => ({
      sessionId, tz, message: b.message,
      now: b.now ? new Date(b.now) : new Date(),
      history: b.history && seedHistory(b.history, b.now ? new Date(b.now) : new Date()),
    });

    // JSON is the default (curl, scripts, harnesses); the UI opts into streaming with Accept: text/event-stream.
    const wantsStream = c.req.query("stream") === "true" || c.req.header("accept")?.includes("text/event-stream");
    if (!wantsStream) {
      const events = await lock.run(sessionId, async () => {
        const out: AgentEvent[] = [];
        for await (const e of runAgent(deps, { ...input(), signal: c.req.raw.signal })) out.push(e);
        return out;
      });
      const err = events.find((e): e is Extract<AgentEvent, { type: "error" }> => e.type === "error");
      if (err) return c.json({ sessionId, error: err.message }, 502);
      const sources = events.find((e): e is Extract<AgentEvent, { type: "sources" }> => e.type === "sources");
      const done = events.find((e): e is Extract<AgentEvent, { type: "done" }> => e.type === "done");
      return c.json({ sessionId, answer: finalAnswer(events), sources: sources?.items ?? [], metrics: done?.metrics });
    }

    return streamSSE(c, async (stream) => {
      const ctrl = new AbortController();
      stream.onAbort(() => ctrl.abort());
      await stream.writeSSE({ event: "session", data: JSON.stringify({ type: "session", sessionId, tz }) });
      await lock.run(sessionId, async () => {
        for await (const e of runAgent(deps, { ...input(), signal: ctrl.signal })) {
          await stream.writeSSE({ event: e.type, data: JSON.stringify(e) });
        }
      });
    });
  });

  return app;
}

/** Accepts whatever a harness sends for timestamps; unparseable or missing ones are spaced one minute apart before `now`. */
function seedHistory(items: z.infer<typeof chatBody>["history"] & object, now: Date) {
  return items.map((h, i) => {
    const parsed = h.timestamp === undefined ? NaN : new Date(h.timestamp).getTime();
    const ts = Number.isFinite(parsed) ? new Date(parsed) : new Date(now.getTime() - (items.length - i) * 60_000);
    return { role: h.role, content: h.content, timestamp: ts };
  });
}

/** Rebuilds the final answer text from events, honouring `reset` (discarded preamble). */
function finalAnswer(events: AgentEvent[]): string {
  let text = "";
  for (const e of events) {
    if (e.type === "reset") text = "";
    else if (e.type === "token") text += e.text;
  }
  return text;
}

function main() {
  const cfg = loadConfig();
  const app = createApp({
    model: createAnthropic({ apiKey: cfg.anthropicKey })(cfg.model),
    provider: new TavilyProvider(cfg.tavilyKey),
    store: new Store(cfg.dbPath),
    defaultTz: cfg.defaultTz,
  });
  serve({ fetch: app.fetch, port: cfg.port }, (info) =>
    console.log(`Minimi is running at http://localhost:${info.port}  (model: ${cfg.model})`),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (err) {
    console.error(`\n${(err as Error).message}\n`);
    process.exit(1);
  }
}
