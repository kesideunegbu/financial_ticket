const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('node:path');
const { createProxyMiddleware } = require('http-proxy-middleware');
const authRoutes = require('./routes/auth');
const chatRoutes = require('./routes/chat');

const SPENDING_URL = process.env.SPENDING_URL || 'http://127.0.0.1:8000';

const app = express();

app.set('trust proxy', 1); // correct client IPs for rate limiting when behind a host's proxy

// Spending tracker lives in the Python service (../spending). Forward it from here so the
// browser only ever talks to one address and the login cookie is sent along automatically.
// Must come before express.json(), which would otherwise consume the request body.
app.use(createProxyMiddleware({
  pathFilter: '/api/spending',
  target: SPENDING_URL,
  on: {
    error: (err, req, res) => {
      if (res.headersSent) return res.end();
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Spending service is unavailable' }));
    },
  },
}));

app.use(express.json({ limit: '10kb' }));
app.use(cookieParser());

app.use('/api/auth', authRoutes);
app.use('/api/chat', chatRoutes);

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Serve the frontend from the same origin so the session cookie just works (no CORS setup).
app.use(express.static(path.join(__dirname, '..', '..', 'frontend')));

// Unknown API routes -> JSON 404
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// Malformed JSON and unexpected errors -> JSON instead of an HTML stack trace
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong' });
});

module.exports = app;
