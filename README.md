# Minimi chat agent

A chat agent with exactly one tool, web search, that knows what day it is and remembers every
conversation you've had with it. Ask it "has anything changed since Monday?" and it knows which
Monday, which tools you meant, and what it told you then.

```bash
npm install
cp .env.example .env     # add TAVILY_API_KEY plus at least one model key
npm run dev              # http://localhost:3000
```

## Keys (all free except Anthropic)

| Key | Where | Notes |
|---|---|---|
| `TAVILY_API_KEY` (required) | [app.tavily.com](https://app.tavily.com) | web search; free tier, no card |
| `GOOGLE_GENERATIVE_AI_API_KEY` | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | Gemini free tier |
| `GROQ_API_KEY` | [console.groq.com/keys](https://console.groq.com/keys) | free tier, very fast |
| `OPENROUTER_API_KEY` | [openrouter.ai/keys](https://openrouter.ai/keys) | free models via `openrouter/free` |
| `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com) | paid; best quality, tried first if set |

Set at least one model key. The agent tries providers in order (`LLM_ORDER`); when one is rate-limited, down or
rejects a request it switches to the next mid-turn, and skips the failed one for a cooldown (about 60 s for rate
limits). The default order is Anthropic, Gemini, Groq, OpenRouter, restricted to the keys you set. Free-tier
limits change and are per model (Gemini 2.5 Flash is 20 requests/day), so each provider takes a comma list of models and the agent waits up to 20 s for a rate limit to reset before giving up. Answer quality follows the model: expect the paid and Gemini
tiers to follow the date and re-verification rules most reliably.

| Command | What it does |
|---|---|
| `npm run dev` | server with reload |
| `npm test` | 105 unit and integration tests, no keys or network needed |
| `npm run typecheck` | strict TypeScript |
| `npm run eval` | 16 end-to-end cases against the real models and search, writes `evals/results.md` (needs keys) |

Design, trade-offs and what's next: [DESIGN.md](DESIGN.md).

## API

`POST /api/chat` streams Server-Sent Events: `session`, `status`, `token`, `reset`, `sources`, `done`, `error`.
A plain POST returns one JSON document (`answer`, `sources`, `metrics`); send `Accept: text/event-stream` (or `?stream=true`) to stream. Errors return `502 {error}`.

```bash
curl -s localhost:3000/api/chat -H 'content-type: application/json' -d '{
  "message": "Has any of them changed pricing since?",
  "tz": "Europe/London",
  "history": [
    {"role":"user","content":"Shortlist: HubSpot, Pipedrive","timestamp":"2026-11-09T09:00:00Z"},
    {"role":"assistant","content":"Noted.","timestamp":"2026-11-09T09:00:20Z"}
  ]
}'
```

| Field | Notes |
|---|---|
| `message` | required, up to 4,000 chars |
| `sessionId` | optional; omit to start a new chat. Memory is shared across all chats regardless |
| `tz` | IANA zone; defaults to the session's last zone, then `DEFAULT_TZ`, then the server's |
| `history` | optional prior turns; `timestamp` may be ISO, date-only, unix ms or omitted; seeded idempotently |
| `now` | optional ISO instant to pretend it is (replay "last Tuesday" scenarios deterministically) |

`GET /api/history?sessionId=...` returns a chat's stored messages.
