'use strict';
// Spending tracker page. Transactions are saved to the user's account through the
// spending API (/api/spending, the Python service), so they follow the user to any
// device and the AI assistant can use the totals for personalized advice.

const $ = (id) => document.getElementById(id);
const API = '/api/spending';

// One colour per expense category, in the order the backend lists them.
const colors = ['#e9c564', '#91bba3', '#8dace0', '#c29acb', '#e6a27b', '#b7c77a', '#a6a6ad',
  '#d98e8e', '#7fc8c8', '#c9b38b', '#9e9be0', '#e0a3c4', '#86a77a'];

const money = (cents) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
const toCents = (amount) => Math.round(Number(amount) * 100);

const today = new Date();
const localDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

let categories = { expense: [], income: [] }; // filled from the backend
let transactions = []; // the selected month's transactions
let loggedIn = false;

// ---------- Talking to the backend ----------

class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function api(path, options = {}) {
  let res;
  try {
    res = await fetch(API + path, {
      ...options,
      headers: options.body ? { 'Content-Type': 'application/json' } : {},
    });
  } catch {
    throw new ApiError('Can\'t reach the server. Make sure the backend is running and open the site at http://localhost:3000', 0);
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (res.status === 401) throw new ApiError('Please log in to use the spending tracker.', 401);
  if (!res.ok || !data) {
    throw new ApiError(data?.error || 'Something went wrong. Please try again.', res.status);
  }
  return data;
}

function monthRange(month) {
  const [year, m] = month.split('-').map(Number);
  const lastDay = new Date(year, m, 0).getDate();
  return { start: `${month}-01`, end: `${month}-${String(lastDay).padStart(2, '0')}` };
}

async function loadMonth() {
  const month = $('month').value;
  if (!loggedIn || !month) {
    transactions = [];
    render();
    return;
  }
  const { start, end } = monthRange(month);
  const all = [];
  try {
    // The API returns at most 200 per page.
    for (let offset = 0; ; offset += 200) {
      const page = await api(`/transactions?start=${start}&end=${end}&limit=200&offset=${offset}`);
      all.push(...page.transactions);
      if (all.length >= page.total || page.transactions.length === 0) break;
    }
    transactions = all;
  } catch (err) {
    handleError(err);
    transactions = [];
  }
  render();
}

function handleError(err) {
  if (err.status === 401) {
    showLoggedOut();
  } else {
    setStatus(err.message);
  }
}

function setStatus(message) {
  $('status').textContent = message;
}

// ---------- Drawing the page ----------

function render() {
  const sorted = [...transactions].sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
  const expenses = sorted.filter((t) => t.type === 'expense');
  const spent = expenses.reduce((sum, t) => sum + toCents(t.amount), 0);
  const income = sorted.filter((t) => t.type === 'income').reduce((sum, t) => sum + toCents(t.amount), 0);
  const net = income - spent;

  // Summary cards
  $('total').textContent = money(spent);
  $('count-detail').textContent = expenses.length === 1 ? '1 expense this month' : `${expenses.length} expenses this month`;
  $('income').textContent = money(income);
  if (!income && !spent) $('net-detail').textContent = 'Add income to see what you keep';
  else if (net >= 0) $('net-detail').textContent = `You kept ${money(net)} this month`;
  else $('net-detail').textContent = `${money(-net)} more went out than came in`;

  const totals = categories.expense.map((category) =>
    expenses.filter((t) => t.category === category).reduce((sum, t) => sum + toCents(t.amount), 0));
  const top = totals.indexOf(Math.max(...totals, 0));
  $('top').textContent = spent ? categories.expense[top] : '—';
  $('top-detail').textContent = spent
    ? `${money(totals[top])} · ${Math.round(totals[top] / spent * 100)}% of spending`
    : 'Add an expense to get started';

  // Spending by category (donut)
  const chart = $('category-chart');
  chart.replaceChildren();
  if (!spent) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'Your category breakdown will appear here.';
    chart.append(p);
  } else {
    let angle = 0;
    const stops = [];
    totals.forEach((value, i) => {
      if (!value) return;
      const end = angle + value / spent * 360;
      stops.push(`${colors[i % colors.length]} ${angle}deg ${end}deg`);
      angle = end;
    });
    const donut = document.createElement('div');
    donut.className = 'donut';
    donut.style.background = `conic-gradient(${stops.join(',')})`;
    donut.setAttribute('role', 'img');
    donut.setAttribute('aria-label', 'Spending by category; amounts listed alongside.');

    const legend = document.createElement('ul');
    legend.className = 'legend';
    totals.forEach((value, i) => {
      if (!value) return;
      const li = document.createElement('li');
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = colors[i % colors.length];
      const label = document.createElement('span');
      label.textContent = categories.expense[i];
      const amount = document.createElement('strong');
      amount.textContent = money(value);
      li.append(dot, label, amount);
      legend.append(li);
    });
    chart.append(donut, legend);
  }

  // Daily spending (bars)
  const daily = $('daily-chart');
  daily.replaceChildren();
  const [year, month] = ($('month').value || '').split('-').map(Number);
  if (year && month) {
    const days = new Date(year, month, 0).getDate();
    const values = Array.from({ length: days }, (_, i) =>
      expenses.filter((t) => Number(t.date.slice(8)) === i + 1).reduce((sum, t) => sum + toCents(t.amount), 0));
    const max = Math.max(...values, 1);
    values.forEach((value, i) => {
      const day = document.createElement('div');
      day.className = 'day';
      day.tabIndex = 0;
      day.title = `${$('month').value}-${String(i + 1).padStart(2, '0')}: ${money(value)}`;
      day.setAttribute('aria-label', day.title);
      const bar = document.createElement('div');
      bar.className = 'bar';
      bar.style.height = `${value / max * 130}px`;
      if (!value) bar.style.background = '#484b46';
      const label = document.createElement('small');
      label.textContent = i === 0 || (i + 1) % 5 === 0 || i === days - 1 ? i + 1 : '';
      day.append(bar, label);
      daily.append(day);
    });
  }

  // Transactions table (income and expenses)
  $('transactions').replaceChildren();
  $('empty').hidden = sorted.length > 0;
  sorted.forEach((t) => {
    const cents = toCents(t.amount);
    const row = document.createElement('tr');
    const cells = [
      t.note || t.category,
      t.category,
      new Date(`${t.date}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
      t.type === 'income' ? `+${money(cents)}` : money(cents),
    ];
    cells.forEach((value, i) => {
      const cell = document.createElement('td');
      cell.textContent = value; // textContent: user text is never treated as HTML
      if (i === 3) cell.className = t.type === 'income' ? 'money income' : 'money';
      row.append(cell);
    });

    const cell = document.createElement('td');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'delete';
    button.textContent = 'Remove';
    button.setAttribute('aria-label', `Remove ${t.note || t.category}, ${money(cents)}`);
    button.addEventListener('click', () => removeTransaction(t, button));
    cell.append(button);
    row.append(cell);
    $('transactions').append(row);
  });
}

// ---------- Adding and removing ----------

function fillCategories() {
  const type = $('type').value;
  const select = $('category');
  select.replaceChildren(...categories[type].map((c) => new Option(c, c)));
  $('submit-button').textContent = type === 'income' ? '+ Add income' : '+ Add expense';
  $('description').placeholder = type === 'income' ? 'e.g. Paycheck from my job' : 'e.g. Lunch with friends';
}

$('type').addEventListener('change', fillCategories);

$('expense-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const type = $('type').value;
  const description = $('description').value.trim();
  const cents = toCents($('amount').value);
  const date = $('date').value;
  if (!description || !Number.isSafeInteger(cents) || cents <= 0 || !date) {
    setStatus('Enter a description, a positive amount, and a valid date.');
    return;
  }

  const button = $('submit-button');
  button.disabled = true;
  try {
    await api('/transactions', {
      method: 'POST',
      body: JSON.stringify({ type, amount: cents / 100, category: $('category').value, date, note: description }),
    });
    $('description').value = '';
    $('amount').value = '';
    setStatus(type === 'income' ? 'Income added. Your charts are up to date.' : 'Expense added. Your charts are up to date.');
    if ($('month').value !== date.slice(0, 7)) $('month').value = date.slice(0, 7);
    await loadMonth();
    $('description').focus();
  } catch (err) {
    handleError(err); // e.g. "Date can't be in the future"
  } finally {
    button.disabled = false;
  }
});

async function removeTransaction(t, button) {
  button.disabled = true;
  try {
    await api(`/transactions/${t.id}`, { method: 'DELETE' });
    setStatus(t.type === 'income' ? 'Income removed.' : 'Expense removed.');
    await loadMonth();
  } catch (err) {
    handleError(err);
    button.disabled = false;
  }
}

$('month').addEventListener('change', () => {
  setStatus('');
  loadMonth();
});

// Sample data: written to the account, so it asks first.
const SAMPLES = [
  ['income', 'Paycheck from part-time job', 450, 'Part-time Job', 1],
  ['expense', 'Groceries', 68.5, 'Food', 2],
  ['expense', 'Monthly utilities', 120, 'Utilities', 3],
  ['expense', 'Coffee & a catch-up', 12.5, 'Food', 5],
  ['expense', 'Train pass', 45, 'Transportation', 6],
  ['expense', 'Movie night', 24, 'Entertainment', 8],
  ['expense', 'New sneakers', 79, 'Shopping', 10],
  ['expense', 'Pharmacy', 18.5, 'Health', 12],
  ['expense', 'Lunch', 16.75, 'Food', 14],
  ['income', 'Paycheck from part-time job', 450, 'Part-time Job', 15],
];

$('sample').addEventListener('click', async () => {
  if (!$('month').value) $('month').value = localDate.slice(0, 7);
  const month = $('month').value;
  const toAdd = SAMPLES
    .map(([type, note, amount, category, day]) => ({ type, note, amount, category, date: `${month}-${String(day).padStart(2, '0')}` }))
    .filter((s) => s.date <= localDate); // the backend doesn't accept future dates

  if (!toAdd.length) {
    setStatus('Sample data can only be added to this month or earlier.');
    return;
  }
  const alreadyLoaded = toAdd.some((s) =>
    transactions.some((t) => t.note === s.note && t.date === s.date && toCents(t.amount) === toCents(s.amount)));
  if (alreadyLoaded) {
    setStatus('Sample data is already loaded for this month.');
    return;
  }
  if (!confirm(`Add ${toAdd.length} sample transactions to your account for ${month}? You can remove them later.`)) return;

  $('sample').disabled = true;
  try {
    for (const s of toAdd) await api('/transactions', { method: 'POST', body: JSON.stringify(s) });
    setStatus('Sample transactions added. Add your own to try it out.');
  } catch (err) {
    handleError(err);
  } finally {
    $('sample').disabled = false;
    await loadMonth();
  }
});

// ---------- Logged out ----------

function showLoggedOut() {
  loggedIn = false;
  transactions = [];
  $('expense-form').querySelectorAll('input, select, button').forEach((el) => (el.disabled = true));
  $('sample').disabled = true;
  $('status').replaceChildren(
    'Please ',
    Object.assign(document.createElement('a'), { href: 'login.html', textContent: 'log in' }),
    ' or ',
    Object.assign(document.createElement('a'), { href: 'signup.html', textContent: 'sign up' }),
    ' to track your spending.',
  );
  render();
}

// ---------- Start ----------

async function init() {
  $('date').value = localDate;
  $('date').max = localDate;
  $('month').value = localDate.slice(0, 7);

  try {
    categories = await api('/categories');
  } catch (err) {
    setStatus(err.message);
    render();
    return;
  }
  fillCategories();

  const me = await fetch('/api/auth/me').catch(() => null);
  if (!me?.ok) {
    showLoggedOut();
    return;
  }
  loggedIn = true;
  await loadMonth();
}

init();
