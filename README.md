# Minimi chat agent

A chat agent with exactly one tool, web search, that knows what day it is and remembers every
conversation you've had with it. Ask it "has anything changed since Monday?" and it knows which
Monday, which tools you meant, and what it told you then.

```bash
npm install
cp .env.example .env     # add ANTHROPIC_API_KEY and TAVILY_API_KEY
npm run dev              # http://localhost:3000
```

Keys: [Anthropic console](https://console.anthropic.com) and [Tavily](https://app.tavily.com) (free tier: 1,000 searches/month).

| Command | What it does |
|---|---|
| `npm run dev` | server with reload |
| `npm test` | 50+ unit and integration tests, no keys or network needed |
| `npm run typecheck` | strict TypeScript |
| `npm run eval` | 17 end-to-end cases against the real model and search, writes `evals/results.md` (needs keys) |

Design, trade-offs and what's next: [DESIGN.md](DESIGN.md).

## API

`POST /api/chat` streams Server-Sent Events: `session`, `status`, `token`, `reset`, `sources`, `done`, `error`.
Add `?stream=false` (or `Accept: application/json`) to get one JSON document instead.

```bash
curl -s localhost:3000/api/chat -H 'content-type: application/json' -H 'accept: application/json' -d '{
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
| `history` | optional prior turns with ISO timestamps; seeded idempotently into the session |
| `now` | optional ISO instant to pretend it is (replay "last Tuesday" scenarios deterministically) |

`GET /api/history?sessionId=...` returns a chat's stored messages.
