# Backend

Node.js + Express. Uses Node's built-in SQLite, so the setup is `npm install` plus a Gemini API key for the chat.

```bash
cd backend
npm install
cp .env.example .env   # copy (not rename), then put your Gemini API key in .env
npm run dev            # http://localhost:3000, restarts on file changes
npm test
```

Get a free Gemini API key at https://aistudio.google.com/apikey and set `GEMINI_API_KEY=` in `backend/.env`. That file is ignored by git, so **never commit a real key**. Without a key, everything except the chat still works, and the chat says it isn't set up. See `.env.example` for the optional settings (model, rate limit, ports).

Spending tracker requests (`/api/spending/*`) are forwarded to the Python service in [`../spending`](../spending/README.md). Start it too if you need those routes.

The server also serves `../frontend`, so open http://localhost:3000 and the login page and API share an origin (no CORS setup needed).

## Auth API

All requests and responses are JSON. Login keeps itself in an httpOnly cookie, so the frontend never handles a token.

| Method | Path | Body | Success | Errors |
|---|---|---|---|---|
| POST | `/api/auth/signup` | `{ email, password, name? }` | `201 { user }` | `400` invalid input, `409` email taken |
| POST | `/api/auth/login` | `{ email, password }` | `200 { user }` | `400` missing fields, `401` wrong email/password |
| POST | `/api/auth/logout` | none | `200 { ok: true }` | |
| GET | `/api/auth/me` | none | `200 { user }` | `401` not logged in |

`user` is `{ id, email, name }`. Every error looks like `{ "error": "message to show the user" }`.
Login and signup allow 10 attempts per IP every 15 minutes (`429` after that). Passwords must be 8-128 characters.

### Example: calling login from the frontend

```js
const res = await fetch('/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password }),
});
const data = await res.json();
if (res.ok) window.location.href = 'index.html';
else showError(data.error);
```

When the page loads, call `GET /api/auth/me` to check whether the user is already logged in.

## Protecting new routes

```js
const requireAuth = require('./middleware/requireAuth');
router.get('/something', requireAuth, (req, res) => { /* req.user is set here */ });
```

## Chat API

Every chat route needs the user to be logged in (`401` otherwise), and users only ever see their own conversations. The AI is Gemini (`gemini-3.5-flash-lite` by default, chosen for speed: replies start in under a second. Set `GEMINI_MODEL` to change it). Its instructions are in `src/chat/prompt.js`.

Gemini models are sometimes overloaded, so `src/chat/gemini.js` protects against that:
- **Retries:** when Google says it's overloaded (429/503), it retries a couple of times.
- **Fallback model:** if the main model still isn't available, it tries `GEMINI_FALLBACK_MODEL` (default `gemini-3.1-flash-lite`). This happens only before any text has been shown, so a reply never switches models halfway.
- **Time limits:** the SDK has none by default. Here, a reply must start within 30 seconds and finish within 2 minutes, otherwise the user gets a "took too long, please try again" message instead of waiting forever.
- **Cut-short replies:** if a reply ever hits the length limit, a note saying so is added at the end. Gemini's hidden "thinking" counts toward that limit, which is why it's set well above normal answer length.

| Method | Path | Body | Success |
|---|---|---|---|
| POST | `/api/chat/messages` | `{ message, conversationId? }` | streamed reply (see below) |
| GET | `/api/chat/conversations` | none | `{ conversations: [{ id, title, created_at, updated_at }] }`, newest first |
| GET | `/api/chat/conversations/:id` | none | `{ conversation, messages: [{ id, role, content, created_at }] }` |
| DELETE | `/api/chat/conversations/:id` | none | `204` |
| GET | `/api/chat/settings` | none | `{ shareSpending }` |
| PUT | `/api/chat/settings` | `{ shareSpending: true/false }` | `{ shareSpending }` |

`role` is `"user"` or `"model"` (the AI). Messages can be up to 2000 characters. Each user can send 30 messages per 10 minutes (`CHAT_RATE_LIMIT`).

### Sending a message

Leave out `conversationId` to start a new conversation, which is titled after its first message. If something is wrong before the AI starts (empty message, unknown conversation, no API key, too many messages), you get a normal JSON error with status `400`, `404`, `503` or `429`.

Otherwise the reply streams back as newline-delimited JSON (`Content-Type: application/x-ndjson`), one event per line:

```
{"type":"delta","text":"Start with "}
{"type":"delta","text":"an emergency fund."}
{"type":"done","conversation":{"id":7,"title":"How do I start saving?",...},"messages":[{...user},{...model}]}
```

- `delta`: the next piece of the reply. Append it to what you have so far.
- `done`: the reply is complete and saved. Use `conversation.id` for follow-up messages.
- `error`: `{ "type": "error", "error": "message to show the user" }`. Nothing was saved, so the user can just send it again.

`frontend/chat.js` shows how to read the stream with `fetch` and `getReader()`.

### Personalized advice

When `shareSpending` is on (the default), each message also gives the AI a short summary of the user's Savings Tracker data. It gets this month's income, expenses and net, spending and income by category, and the last 3 months' totals, taken from the Python spending service. It never gets individual transactions or notes. If the spending service isn't running, the chat still works without it.
