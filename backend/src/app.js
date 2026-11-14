const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('node:path');
const authRoutes = require('./routes/auth');

const app = express();

app.set('trust proxy', 1); // correct client IPs for rate limiting when behind a host's proxy
app.use(express.json({ limit: '10kb' }));
app.use(cookieParser());

app.use('/api/auth', authRoutes);

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
