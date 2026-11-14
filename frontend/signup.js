// Sign-up page: sends the form to the backend (POST /api/auth/signup).
// The backend logs the new user in straight away (it sets the login cookie),
// so on success we go straight to the homepage.

const form = document.getElementById('signupForm');
const firstNameInput = document.getElementById('firstName');
const lastNameInput = document.getElementById('lastName');
const emailInput = document.getElementById('email');
const passwordInput = document.getElementById('password');
const signupButton = document.getElementById('signupButton');
const errorMessage = document.getElementById('errorMessage');

const SERVER_HINT = 'Can\'t reach the server. Make sure the backend is running and open the site at http://localhost:3000';
const MIN_PASSWORD = 8; // must match the backend (backend/src/routes/auth.js)

function showError(message) {
  errorMessage.textContent = message;
}

// Already logged in? No need to sign up.
fetch('/api/auth/me')
  .then((res) => {
    if (res.ok) window.location.replace('index.html');
  })
  .catch(() => {});

form.addEventListener('submit', async (event) => {
  event.preventDefault(); // stop the browser's normal form submit (page reload)
  showError('');

  const firstName = firstNameInput.value.trim();
  const lastName = lastNameInput.value.trim();
  const password = passwordInput.value;

  // The browser checks these too (required/minlength), but spaces-only names slip through.
  if (!firstName || !lastName) {
    showError('Please enter your first and last name.');
    return;
  }
  if (password.length < MIN_PASSWORD) {
    showError(`Password must be at least ${MIN_PASSWORD} characters.`);
    return;
  }

  signupButton.disabled = true;
  signupButton.textContent = 'Creating account...';

  try {
    const res = await fetch('/api/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `${firstName} ${lastName}`, // the backend stores one name field
        email: emailInput.value.trim(),
        password,
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

    // Backend errors are already written for users,
    // e.g. "An account with that email already exists."
    showError(data.error || 'Sign up failed. Please try again.');
  } catch {
    showError(SERVER_HINT);
  } finally {
    signupButton.disabled = false;
    signupButton.textContent = 'Sign Up!';
  }
});
