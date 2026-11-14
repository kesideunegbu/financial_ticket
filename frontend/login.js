// Login page: sends the form to the backend (POST /api/auth/login).
// The backend sets a login cookie itself, so there's no token to store here.

const form = document.getElementById('loginForm');
const emailInput = document.getElementById('email');
const passwordInput = document.getElementById('password');
const loginButton = document.getElementById('loginButton');
const errorMessage = document.getElementById('errorMessage');

const SERVER_HINT = 'Can\'t reach the server. Make sure the backend is running and open the site at http://localhost:3000';

function showError(message) {
  errorMessage.textContent = message;
}

// Already logged in? Skip the login page.
fetch('/api/auth/me')
  .then((res) => {
    if (res.ok) window.location.replace('index.html');
  })
  .catch(() => {}); // server not reachable: the submit handler explains it

form.addEventListener('submit', async (event) => {
  event.preventDefault(); // stop the browser's normal form submit (page reload)
  showError('');

  loginButton.disabled = true;
  loginButton.textContent = 'Logging in...';

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: emailInput.value.trim(),
        password: passwordInput.value,
      }),
    });

    // If the page wasn't opened through the backend, the reply won't be JSON.
    const data = await res.json().catch(() => null);
    if (!data) {
      showError(SERVER_HINT);
      return;
    }

    if (res.ok) {
      window.location.href = 'index.html';
      return;
    }

    // Backend errors are already written for users, e.g. "Incorrect email or password."
    showError(data.error || 'Login failed. Please try again.');
    passwordInput.value = '';
    passwordInput.focus();
  } catch {
    showError(SERVER_HINT);
  } finally {
    loginButton.disabled = false;
    loginButton.textContent = 'Log In';
  }
});
