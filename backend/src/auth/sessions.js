// Server-side sessions. The browser gets a random token in an httpOnly cookie;
// the database only stores a SHA-256 hash of it, so a leaked DB can't be used to log in.
const crypto = require('node:crypto');
const db = require('../db');

const COOKIE_NAME = 'sid';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + SESSION_TTL_MS;
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(sha256(token), userId, expiresAt);
  return { token, expiresAt };
}

function getUserBySessionToken(token) {
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.id, u.email, u.name, s.expires_at
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?
  `).get(sha256(token));
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    deleteSession(token);
    return null;
  }
  return { id: row.id, email: row.email, name: row.name };
}

function deleteSession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

function purgeExpiredSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}

function cookieOptions(expiresAt) {
  return {
    httpOnly: true, // not readable from JavaScript, so XSS can't steal it
    sameSite: 'lax', // basic CSRF protection
    secure: process.env.NODE_ENV === 'production', // HTTPS-only in production
    path: '/',
    expires: new Date(expiresAt),
  };
}

module.exports = {
  COOKIE_NAME,
  createSession,
  getUserBySessionToken,
  deleteSession,
  purgeExpiredSessions,
  cookieOptions,
};
