const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { hashPassword, verifyPassword } = require('../auth/password');
const sessions = require('../auth/sessions');
const requireAuth = require('../middleware/requireAuth');

const router = express.Router();

// Slow down password guessing: 10 login/signup attempts per IP per 15 minutes.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.AUTH_RATE_LIMIT || 10),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again later.' },
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 128;

// A real hash used when the email doesn't exist, so login takes the same time
// whether or not the account exists (prevents discovering registered emails by timing).
const dummyHashPromise = hashPassword('dummy-password-for-timing');

function startSession(res, userId) {
  const { token, expiresAt } = sessions.createSession(userId);
  res.cookie(sessions.COOKIE_NAME, token, sessions.cookieOptions(expiresAt));
}

// POST /api/auth/signup  { email, password, name? }
router.post('/signup', authLimiter, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const name = req.body?.name ? String(req.body.name).trim().slice(0, 100) : null;

  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Please enter a valid email.' });
  if (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
    return res.status(400).json({ error: `Password must be ${MIN_PASSWORD}-${MAX_PASSWORD} characters.` });
  }

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) return res.status(409).json({ error: 'An account with that email already exists.' });

  const passwordHash = await hashPassword(password);
  const result = db.prepare('INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?)')
    .run(email, name, passwordHash);
  const userId = Number(result.lastInsertRowid);

  startSession(res, userId);
  res.status(201).json({ user: { id: userId, email, name } });
});

// POST /api/auth/login  { email, password }
router.post('/login', authLimiter, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });

  const user = db.prepare('SELECT id, email, name, password_hash FROM users WHERE email = ?').get(email);
  const ok = await verifyPassword(password.slice(0, MAX_PASSWORD), user ? user.password_hash : await dummyHashPromise);

  // Same message for "no such user" and "wrong password".
  if (!user || !ok) return res.status(401).json({ error: 'Incorrect email or password.' });

  startSession(res, user.id);
  res.json({ user: { id: user.id, email: user.email, name: user.name } });
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  sessions.deleteSession(req.cookies?.[sessions.COOKIE_NAME]);
  res.clearCookie(sessions.COOKIE_NAME, { path: '/' });
  res.json({ ok: true });
});

// GET /api/auth/me  -> the current user, or 401 if not logged in
router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;
