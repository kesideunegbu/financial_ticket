// Homepage: if the user is logged in, show their name and a Log Out button
// instead of Log In / Sign Up.

const navButtons = document.querySelector('.nav-buttons');

async function showLoggedInUser() {
  let user;
  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) return; // not logged in: keep Log In / Sign Up
    user = (await res.json()).user;
  } catch {
    return; // backend not reachable: leave the page as it is
  }

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
      window.location.reload();
    }
  });

  navButtons.replaceChildren(name, logoutButton);
}

showLoggedInUser();
