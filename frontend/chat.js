// Homepage chat: sending messages, streaming replies, the Recent Chats list and Settings.
import { renderMarkdown } from './markdown.js';

const content = document.querySelector('.content');
const messagesEl = document.getElementById('messages');
const form = document.getElementById('chatForm');
const input = document.getElementById('chatInput');
const sendButton = document.getElementById('sendButton');
const suggestions = document.querySelectorAll('.suggestions button[data-prompt]');
const newChatButton = document.querySelector('.new-chat');
const conversationList = document.getElementById('conversationList');
const historyNote = document.getElementById('historyNote');
const settingsButton = document.getElementById('settingsButton');
const settingsPanel = document.getElementById('settingsPanel');
const shareSpendingBox = document.getElementById('shareSpending');

let user = null;
let conversationId = null;
let sending = false;

// ---------- Showing messages ----------

function setChatMode(on) {
  content.classList.toggle('chatting', on);
  messagesEl.hidden = !on;
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addMessage(role, text) {
  const el = document.createElement('div');
  el.className = `message ${role}`;
  if (role === 'user') el.textContent = text; // user text is shown exactly as typed
  else el.innerHTML = renderMarkdown(text); // renderMarkdown escapes all HTML first
  messagesEl.append(el);
  scrollToBottom();
  return el;
}

function showNotice(html) {
  setChatMode(true);
  const el = document.createElement('div');
  el.className = 'message notice';
  el.innerHTML = html; // only ever called with fixed text from this file
  messagesEl.append(el);
  scrollToBottom();
}

function setSending(on) {
  sending = on;
  input.disabled = on;
  sendButton.disabled = on;
  suggestions.forEach((b) => (b.disabled = on));
  if (!on) input.focus();
}

// ---------- Sending a message and reading the streamed reply ----------

async function sendMessage(text) {
  text = text.trim();
  if (!text || sending) return;

  if (!user) {
    showNotice('Please <a href="login.html">log in</a> or <a href="signup.html">sign up</a> to chat with the assistant.');
    return;
  }

  setChatMode(true);
  addMessage('user', text);
  input.value = '';
  setSending(true);

  const reply = addMessage('model', '');
  reply.classList.add('thinking');
  reply.textContent = 'Thinking…';
  let replyText = '';

  const fail = (message) => {
    reply.classList.remove('thinking');
    reply.classList.add('error');
    reply.textContent = message;
    input.value = text; // nothing was saved, so give the user their message back to retry
  };

  try {
    const res = await fetch('/api/chat/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, conversationId }),
    });

    // Errors before the reply starts come back as normal JSON.
    if (!res.headers.get('content-type')?.includes('ndjson')) {
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) {
        fail('Your login has expired. Please log in again.');
        return;
      }
      fail(data.error || 'Something went wrong. Please try again.');
      return;
    }

    // The reply streams in as one JSON event per line.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finished = false;

    while (!finished) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep any partial line for the next chunk

      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.type === 'delta') {
          replyText += event.text;
          reply.classList.remove('thinking');
          reply.innerHTML = renderMarkdown(replyText);
          scrollToBottom();
        } else if (event.type === 'done') {
          const isNew = conversationId !== event.conversation.id;
          conversationId = event.conversation.id;
          if (isNew) history.replaceState(null, '', `#chat=${conversationId}`);
          loadConversationList();
          finished = true;
        } else if (event.type === 'error') {
          fail(event.error);
          finished = true;
        }
      }
    }
    if (!finished) fail('The connection was interrupted. Please try again.');
  } catch {
    fail('Can\'t reach the server. Make sure the backend is running and open the site at http://localhost:3000');
  } finally {
    setSending(false);
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  sendMessage(input.value);
});

suggestions.forEach((button) => {
  button.addEventListener('click', () => sendMessage(button.dataset.prompt));
});

// ---------- Conversations (sidebar) ----------

function startNewChat() {
  conversationId = null;
  messagesEl.replaceChildren();
  setChatMode(false);
  history.replaceState(null, '', location.pathname);
  highlightActive();
  input.focus();
}

newChatButton.addEventListener('click', () => {
  if (!sending) startNewChat();
});

async function openConversation(id) {
  if (sending) return;
  const res = await fetch(`/api/chat/conversations/${id}`);
  if (!res.ok) {
    startNewChat();
    return;
  }
  const data = await res.json();
  conversationId = data.conversation.id;
  messagesEl.replaceChildren();
  setChatMode(true);
  data.messages.forEach((m) => addMessage(m.role, m.content));
  history.replaceState(null, '', `#chat=${conversationId}`);
  highlightActive();
}

async function deleteConversation(id, title) {
  if (!confirm(`Delete "${title}"? This can't be undone.`)) return;
  const res = await fetch(`/api/chat/conversations/${id}`, { method: 'DELETE' });
  if (res.ok && id === conversationId) startNewChat();
  loadConversationList();
}

function highlightActive() {
  conversationList.querySelectorAll('li').forEach((li) => {
    li.classList.toggle('active', Number(li.dataset.id) === conversationId);
  });
}

async function loadConversationList() {
  const res = await fetch('/api/chat/conversations').catch(() => null);
  if (!res?.ok) return;
  const { conversations } = await res.json();

  historyNote.hidden = conversations.length > 0;
  historyNote.textContent = 'No chats yet. Ask a question to start one!';

  conversationList.replaceChildren(...conversations.map((c) => {
    const li = document.createElement('li');
    li.dataset.id = c.id;

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'conversation-title';
    open.textContent = c.title;
    open.title = c.title;
    open.addEventListener('click', () => openConversation(c.id));

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'conversation-delete';
    del.textContent = '×';
    del.setAttribute('aria-label', `Delete chat: ${c.title}`);
    del.addEventListener('click', () => deleteConversation(c.id, c.title));

    li.append(open, del);
    return li;
  }));
  highlightActive();
}

// ---------- Settings ----------

settingsButton.addEventListener('click', () => {
  const open = settingsPanel.hidden;
  settingsPanel.hidden = !open;
  settingsButton.setAttribute('aria-expanded', String(open));
});

shareSpendingBox.addEventListener('change', async () => {
  shareSpendingBox.disabled = true;
  try {
    const res = await fetch('/api/chat/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shareSpending: shareSpendingBox.checked }),
    });
    if (!res.ok) shareSpendingBox.checked = !shareSpendingBox.checked; // undo if it didn't save
  } finally {
    shareSpendingBox.disabled = false;
  }
});

async function loadSettings() {
  const res = await fetch('/api/chat/settings').catch(() => null);
  if (res?.ok) shareSpendingBox.checked = (await res.json()).shareSpending;
}

// ---------- Start ----------

export async function initChat(currentUser) {
  user = currentUser;
  if (!user) {
    historyNote.textContent = 'Log in to save your chats.';
    settingsButton.hidden = true;
    return;
  }
  await Promise.all([loadConversationList(), loadSettings()]);

  // Reopen the chat in the address bar (e.g. after a page refresh).
  const match = location.hash.match(/^#chat=(\d+)$/);
  if (match) openConversation(Number(match[1]));
}
