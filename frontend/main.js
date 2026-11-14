// Homepage: checks who is logged in, updates the navbar, and starts the chat.
import { initChat } from './chat.js';

const navButtons = document.querySelector('.nav-buttons');

async function getCurrentUser() {
  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) return null; // not logged in
    return (await res.json()).user;
  } catch {
    return null; // backend not reachable
  }
}

function showLoggedInUser(user) {
  const name = document.createElement('span');
  name.className = 'user-name';
  name.textContent = `Hi, ${user.name || user.email}`; // textContent, never innerHTML, for user data

  const logoutButton = document.createElement('button');
  logoutButton.type = 'button';
  logoutButton.textContent = 'Log Out';
  logoutButton.addEventListener('click', async () => {
    logoutButton.disabled = true;
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } finally {
      window.location.href = 'index.html'; // also clears any open chat from the address bar
    }
  });

  navButtons.replaceChildren(name, logoutButton);
}

// The Spending Tracker suggestion opens the tracker page instead of asking the AI.
const spendingTrackerButton = Array.from(document.querySelectorAll('.suggestions button'))
  .find(button => button.textContent.includes('Spending Tracker'));
if (spendingTrackerButton) {
  spendingTrackerButton.addEventListener('click', () => {
    window.location.href = 'sptracker.html';
  });
}

const user = await getCurrentUser();
if (user) showLoggedInUser(user);
initChat(user);
