// Thin wrapper around the Gemini SDK, kept in one place so tests can swap it for a fake.
//
// The SDK has no time limit by default, so a request Google accepts but never answers
// (it happens when a model is overloaded) would leave the user on "Thinking..." forever.
// This wrapper adds:
//   - time limits: one for the reply to START, one for the whole reply
//   - a few quick retries when Google says it's overloaded (429 / 503)
//   - a fallback model, tried once if the main model is unavailable before any text was sent

const { GoogleGenAI } = require('@google/genai');

const env = (name, fallback) => (process.env[name] !== undefined ? process.env[name] : fallback);

const MODEL = env('GEMINI_MODEL', 'gemini-3.5-flash-lite');
const FALLBACK_MODEL = env('GEMINI_FALLBACK_MODEL', 'gemini-3.1-flash-lite'); // set to empty to disable
const FIRST_CHUNK_TIMEOUT_MS = Number(env('GEMINI_FIRST_CHUNK_TIMEOUT_MS', 30_000));
const TOTAL_TIMEOUT_MS = Number(env('GEMINI_TOTAL_TIMEOUT_MS', 120_000));
const RETRY_ATTEMPTS = Number(env('GEMINI_RETRY_ATTEMPTS', 3)); // including the first try
const OVERLOADED = [429, 503];
// Gemini "thinks" before answering, and those hidden thinking tokens count toward this
// limit (often 600-1500 of them), so it must be well above the visible answer length.
// Answer length itself is kept in check by the instructions in prompt.js.
const MAX_OUTPUT_TOKENS = 8192;
const CUT_SHORT_NOTE = '\n\n*(This reply was cut short. Ask me to continue if you\'d like more.)*';

class GeminiTimeoutError extends Error {
  constructor(phase) {
    super(phase === 'start' ? 'Gemini did not start replying in time' : 'Gemini reply took too long');
    this.name = 'GeminiTimeoutError';
    this.status = 504;
    this.phase = phase; // 'start' | 'total'
  }
}

let client;

function getClient() {
  client ??= new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
    httpOptions: {
      retryOptions: { attempts: RETRY_ATTEMPTS, initialDelay: 1, maxDelay: 4, httpStatusCodes: OVERLOADED },
    },
  });
  return client;
}

function isConfigured() {
  return Boolean(process.env.GEMINI_API_KEY);
}

async function* streamFromModel(model, { history, systemInstruction, signal }) {
  // One abort switch for: the user leaving, the start time limit, and the total time limit.
  const controller = new AbortController();
  let timedOut = null;
  const onCallerAbort = () => controller.abort();
  signal?.addEventListener('abort', onCallerAbort, { once: true });
  const startTimer = setTimeout(() => { timedOut = 'start'; controller.abort(); }, FIRST_CHUNK_TIMEOUT_MS);
  const totalTimer = setTimeout(() => { timedOut = 'total'; controller.abort(); }, TOTAL_TIMEOUT_MS);

  try {
    const stream = await getClient().models.generateContentStream({
      model,
      contents: history.map((m) => ({ role: m.role, parts: [{ text: m.content }] })),
      config: {
        systemInstruction,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        temperature: 0.7,
        abortSignal: controller.signal,
      },
    });
    let finishReason;
    for await (const chunk of stream) {
      clearTimeout(startTimer);
      finishReason = chunk.candidates?.[0]?.finishReason ?? finishReason;
      if (chunk.text) yield chunk.text;
    }
    // Don't let a reply stop mid-sentence without saying so.
    if (finishReason === 'MAX_TOKENS') yield CUT_SHORT_NOTE;
  } catch (err) {
    if (timedOut && !signal?.aborted) throw new GeminiTimeoutError(timedOut);
    throw err;
  } finally {
    clearTimeout(startTimer);
    clearTimeout(totalTimer);
    signal?.removeEventListener('abort', onCallerAbort);
  }
}

/**
 * Streams Gemini's reply, yielding text chunks as they arrive.
 * Errors have a `status`: 429/503 = overloaded, 504 = took too long.
 * @param {object} opts
 * @param {{ role: 'user' | 'model', content: string }[]} opts.history  oldest first, ending with the new user message
 * @param {string} opts.systemInstruction
 * @param {AbortSignal} [opts.signal]  aborts the request (e.g. the user closed the page)
 */
async function* streamReply(opts) {
  let sentAnything = false;
  try {
    for await (const text of streamFromModel(MODEL, opts)) {
      sentAnything = true;
      yield text;
    }
  } catch (err) {
    const unavailable = OVERLOADED.includes(err.status) || (err instanceof GeminiTimeoutError && err.phase === 'start');
    const canFallBack = FALLBACK_MODEL && FALLBACK_MODEL !== MODEL && !sentAnything && !opts.signal?.aborted && unavailable;
    if (!canFallBack) throw err;

    console.warn(`Gemini ${MODEL} unavailable (${err.status}), trying ${FALLBACK_MODEL}`);
    yield* streamFromModel(FALLBACK_MODEL, opts);
  }
}

module.exports = { MODEL, FALLBACK_MODEL, GeminiTimeoutError, isConfigured, streamReply };
