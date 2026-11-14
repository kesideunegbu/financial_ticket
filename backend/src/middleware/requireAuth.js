// Protects routes that need a logged-in user (e.g. the upcoming Gemini chat endpoint).
// Sets req.user = { id, email, name } on success.
const { COOKIE_NAME, getUserBySessionToken } = require('../auth/sessions');

function requireAuth(req, res, next) {
  const user = getUserBySessionToken(req.cookies?.[COOKIE_NAME]);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  req.user = user;
  next();
}

module.exports = requireAuth;
