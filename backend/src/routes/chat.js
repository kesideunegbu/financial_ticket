const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const requireAuth = require('../middleware/requireAuth');
const gemini = require('../chat/gemini');
const { buildSystemInstruction } = require('../chat/prompt');
const { buildSpendingContext } = require('../chat/spendingContext');

const router = express.Router();
router.use(requireAuth); // every chat route needs a logged-in user

const MAX_MESSAGE_LENGTH = 2000;
const HISTORY_LIMIT = 20; // earlier messages sent to Gemini for context
const TITLE_LENGTH = 60;

// Protects the Gemini quota: messages per user per 10 minutes.
const chatLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: Number(process.env.CHAT_RATE_LIMIT || 30),
  keyGenerator: (req) => `user:${req.user.id}`,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'You\'re sending messages too quickly. Please wait a few minutes and try again.' },
});

function makeTitle(text) {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > TITLE_LENGTH ? oneLine.slice(0, TITLE_LENGTH - 1).trimEnd() + '…' : oneLine;
}

function getOwnedConversation(userId, conversationId) {
  return db.prepare('SELECT id, title, created_at, updated_at FROM conversations WHERE id = ? AND user_id = ?')
    .get(conversationId, userId);
}

function getShareSpending(userId) {
  const row = db.prepare('SELECT share_spending FROM user_settings WHERE user_id = ?').get(userId);
  return row ? Boolean(row.share_spending) : true;
}

// GET /api/chat/conversations -> most recently used first
router.get('/conversations', (req, res) => {
  const conversations = db.prepare(`
    SELECT id, title, created_at, updated_at FROM conversations
    WHERE user_id = ? ORDER BY updated_at DESC, id DESC LIMIT 50
  `).all(req.user.id);
  res.json({ conversations });
});

// GET /api/chat/conversations/:id -> the conversation and all its messages
router.get('/conversations/:id', (req, res) => {
  const conversation = getOwnedConversation(req.user.id, Number(req.params.id));
  if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
  const messages = db.prepare('SELECT id, role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY id')
    .all(conversation.id);
  res.json({ conversation, messages });
});

// DELETE /api/chat/conversations/:id
router.delete('/conversations/:id', (req, res) => {
  const result = db.prepare('DELETE FROM conversations WHERE id = ? AND user_id = ?')
    .run(Number(req.params.id), req.user.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Conversation not found' });
  res.status(204).end();
});

// GET/PUT /api/chat/settings  { shareSpending: boolean }
router.get('/settings', (req, res) => {
  res.json({ shareSpending: getShareSpending(req.user.id) });
});

router.put('/settings', (req, res) => {
  if (typeof req.body?.shareSpending !== 'boolean') {
    return res.status(400).json({ error: 'shareSpending must be true or false' });
  }
  db.prepare(`
    INSERT INTO user_settings (user_id, share_spending) VALUES (?, ?)
    ON CONFLICT(user_id) DO UPDATE SET share_spending = excluded.share_spending
  `).run(req.user.id, req.body.shareSpending ? 1 : 0);
  res.json({ shareSpending: req.body.shareSpending });
});

/**
 * POST /api/chat/messages  { message, conversationId? }
 * Leave out conversationId to start a new conversation.
 *
 * The reply streams back as newline-delimited JSON (one event per line):
 *   { "type": "delta", "text": "..." }                     a piece of the reply, in order
 *   { "type": "done", "conversation": {...}, "messages": [userMsg, modelMsg] }   saved
 *   { "type": "error", "error": "message to show the user" }                    nothing saved
 */
router.post('/messages', chatLimiter, async (req, res) => {
  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  if (!message) return res.status(400).json({ error: 'Please type a message.' });
  if (message.length > MAX_MESSAGE_LENGTH) {
    return res.status(400).json({ error: `Messages can be at most ${MAX_MESSAGE_LENGTH} characters.` });
  }

  let conversation = null;
  if (req.body.conversationId != null) {
    conversation = getOwnedConversation(req.user.id, Number(req.body.conversationId));
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
  }

  if (!gemini.isConfigured()) {
    return res.status(503).json({ error: 'The AI assistant isn\'t set up yet (missing GEMINI_API_KEY on the server).' });
  }

  const earlier = conversation
    ? db.prepare(`
        SELECT role, content FROM (
          SELECT id, role, content FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?
        ) ORDER BY id
      `).all(conversation.id, HISTORY_LIMIT)
    : [];
  const history = [...earlier, { role: 'user', content: message }];

  const spendingContext = getShareSpending(req.user.id)
    ? await buildSpendingContext(req.headers.cookie || '')
    : null;
  const systemInstruction = buildSystemInstruction({ userName: req.user.name, spendingContext });

  // Stop asking Gemini if the user closes the page mid-reply.
  const abort = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) abort.abort();
  });

  res.status(200).set({
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no', // don't let proxies hold back the stream
  });
  res.flushHeaders();
  const send = (event) => res.write(JSON.stringify(event) + '\n');

  let reply = '';
  try {
    for await (const text of gemini.streamReply({ history, systemInstruction, signal: abort.signal })) {
      reply += text;
      send({ type: 'delta', text });
    }
    if (!reply.trim()) throw new Error('Empty reply from Gemini');
  } catch (err) {
    if (abort.signal.aborted) return res.end();
    console.error('Gemini error:', err.status ?? '', err.message);
    let error = 'Sorry, the assistant couldn\'t answer that. Please try again.';
    if (err.status === 429 || err.status === 503) error = 'The assistant is busy right now. Please try again in a minute.';
    if (err.status === 504) error = 'The assistant took too long to respond. Please try again.';
    send({ type: 'error', error });
    return res.end();
  }

  // Save the question and answer together, only once the reply is complete.
  let saved;
  db.exec('BEGIN');
  try {
    let conversationId = conversation?.id;
    if (!conversationId) {
      conversationId = Number(db.prepare('INSERT INTO conversations (user_id, title) VALUES (?, ?)')
        .run(req.user.id, makeTitle(message)).lastInsertRowid);
    } else {
      db.prepare('UPDATE conversations SET updated_at = datetime(\'now\') WHERE id = ?').run(conversationId);
    }
    const insert = db.prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)');
    const userId = Number(insert.run(conversationId, 'user', message).lastInsertRowid);
    const modelId = Number(insert.run(conversationId, 'model', reply).lastInsertRowid);
    db.exec('COMMIT');
    saved = {
      conversation: getOwnedConversation(req.user.id, conversationId),
      messages: db.prepare('SELECT id, role, content, created_at FROM messages WHERE id IN (?, ?) ORDER BY id').all(userId, modelId),
    };
  } catch (err) {
    db.exec('ROLLBACK');
    console.error('Failed to save chat:', err);
    send({ type: 'error', error: 'Your reply was generated but couldn\'t be saved. Please try again.' });
    return res.end();
  }

  send({ type: 'done', ...saved });
  res.end();
});

module.exports = router;
