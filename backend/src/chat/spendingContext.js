// Builds a short, plain-text summary of the user's finances for the AI.
// Only totals by category and month are included: never individual transactions or notes.
// It asks the Python spending service, passing along the user's login cookie.

const SPENDING_URL = process.env.SPENDING_URL || 'http://127.0.0.1:8000';
const TIMEOUT_MS = 2000;

const usd = (n) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function getJson(path, cookie) {
  const res = await fetch(SPENDING_URL + path, {
    headers: { cookie },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`spending service ${res.status}`);
  return res.json();
}

/**
 * Returns a text block describing the user's finances, or null if the spending
 * service isn't reachable (chat should still work without it).
 */
async function buildSpendingContext(cookie) {
  let month, history;
  try {
    [month, history] = await Promise.all([
      getJson('/api/spending/summary', cookie),
      getJson('/api/spending/summary/monthly?months=3', cookie),
    ]);
  } catch {
    return null;
  }

  const hasAnyData = history.months.some((m) => m.income > 0 || m.expenses > 0);
  if (!hasAnyData) {
    return 'The user has not recorded any income or expenses in the spending tracker yet.';
  }

  const lines = [
    `This month so far (${month.start} to ${month.end}): income ${usd(month.income)}, expenses ${usd(month.expenses)}, net ${usd(month.net)}.`,
  ];
  if (month.expenses_by_category.length) {
    const top = month.expenses_by_category
      .slice(0, 6)
      .map((c) => `${c.category} ${usd(c.total)} (${c.percent}%)`)
      .join(', ');
    lines.push(`Spending by category this month: ${top}.`);
  }
  if (month.income_by_category.length) {
    lines.push(`Income sources this month: ${month.income_by_category.map((c) => `${c.category} ${usd(c.total)}`).join(', ')}.`);
  }
  lines.push(
    'Last 3 months: ' +
      history.months.map((m) => `${m.month}: income ${usd(m.income)}, expenses ${usd(m.expenses)}, net ${usd(m.net)}`).join('; ') +
      '.'
  );
  return lines.join('\n');
}

module.exports = { buildSpendingContext };
