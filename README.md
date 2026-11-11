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

**Tavily credits go fast.** A "what changed since" search costs two credits per entity (three when no official page is found), and one `npm run eval` costs on the order of 50-100. The free 1,000 a month is enough to use the app, not to run evals all day. When it runs out Tavily answers `432`, and the agent says plainly that search is unavailable and refuses to claim anything is unchanged. Set at least one model key (`MODEL` picks the Anthropic model; `MEMORY_SCOPE=session` limits memory to one chat, the default `global` lets a new chat recall old ones). The agent tries providers in order (`LLM_ORDER`); when one is rate-limited, down or
rejects a request it switches to the next mid-turn, and skips the failed one for a cooldown (about 60 s for rate
limits). The default order is Anthropic, Groq, Gemini, OpenRouter (fastest first), restricted to the keys you set. Free-tier
limits change and are per model (Gemini 2.5 Flash is 20 requests/day), so each provider takes a comma list of models and the agent waits up to 20 s for a rate limit to reset before giving up. Answer quality follows the model: expect the paid and Gemini
tiers to follow the date and re-verification rules most reliably.

| Command | What it does |
|---|---|
| `npm run dev` | server with reload |
| `npm test` | 311 unit and integration tests, no keys or network needed |
| `npm run typecheck` / `npm run build` | strict TypeScript |
| `npm run bench` | the speed pass: Tavily depth, snippet length, real parallel speed-up; writes `evals/speed.md` (needs keys) |
| `npm run eval` | 16 end-to-end cases against the real models and search, writes `evals/results.md` (needs keys) |

Design, trade-offs and what's next: [DESIGN.md](DESIGN.md).

## API

`POST /api/chat` streams Server-Sent Events: `session`, `status`, `token`, `reset`, `sources`, `verification`, `done`, `title`, `error`.
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

Send an `x-user-id` header to keep one person's chats and memory apart from another's (the browser UI does this automatically). With no header, everyone shares one default user, as before. Someone else's session id reads as empty and returns 403 on write.

The JSON response also carries `title` and a `verification` report: every price, percentage, version and attributed date in the answer, each marked `supported`, `memory`, `derived`, `misattributed` or `unsupported`.

`GET /api/history?sessionId=...` returns a chat's stored messages.
`GET /api/memories` returns the most recent distinct questions across chats. `GET /api/sessions` lists conversations (newest first, titled by the first question) and `DELETE /api/sessions/:id` removes one, which also removes it from the agent's memory.

## What makes the agent good

Beyond calling a search tool, it **remembers, reasons, researches and verifies**:

- **Remembers:** a ledger of recent chats, plus full-text retrieval (SQLite FTS5) of older ones found by topic, so "that Postgres question from months ago" works. Memory is per user.
- **Time:** "last Tuesday", "last week", "in October", "2 weeks ago", "this morning" are resolved to exact, timezone-correct spans, and the agent is told what is actually stored for them, including "nothing".
- **Reasons:** earlier answers become a checklist of claims to re-verify. Code decides whether a turn may search (recall, small talk: never), must search ("is that still correct?"), or must ask first ("has any of *them* changed?" with nothing remembered).
- **Researches:** one tool, parallel searches, official pages ranked above review sites, a dated query paired with a current-page query for "what changed since".
- **Verifies:** every price, percentage, version and attributed date is checked against the sources, with no model involved. Wrong citation numbers are corrected in code; other problems get one repair pass; whatever is left is shown to the user (a chip, and an underline on the figure).

See [DESIGN.md](DESIGN.md) for the reasoning and the measured results.

## The interface

Modelled on the minimi desktop app and structured like ChatGPT.

- **Your chats (left card):** conversations grouped Today, Yesterday, Previous 7 days and older, with AI-generated titles (free models only, with an instant deterministic fallback), search, new chat, and a styled delete dialog.
- **Chat window (centre card):** streaming answers with live "Searching: ..." status, numbered source chips, a copy button, the model that answered, and the verification chip. Pill composer; the send button becomes Stop while it answers.
- **Recent memories (right card):** what minimi remembers across your chats; click one to jump to that conversation.
- **Discover minimi (right card):** a checklist that ticks itself as you try things.
- **Header:** logo, a status dot that goes red if the server is unreachable, and a settings gear (theme, shortcuts).
- **Responsive:** the right rail becomes a drawer below 1180 px, and the chats card becomes a drawer on phones.

Shortcuts: `Enter` send, `Shift+Enter` new line, `⌘K` search chats, `Esc` close panels.
