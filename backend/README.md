# Backend

Node.js + Express. Uses Node's built-in SQLite, so the only setup is `npm install`.

```bash
cd backend
npm install
npm run dev     # http://localhost:3000, restarts on file changes
npm test
```

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
if (res.ok) window.location.href = '/chat.html';
else showError(data.error);
```

When the page loads, call `GET /api/auth/me` to check whether the user is already logged in.

## Protecting new routes

```js
const requireAuth = require('./middleware/requireAuth');
router.post('/api/chat', requireAuth, (req, res) => { /* req.user is set here */ });
```
