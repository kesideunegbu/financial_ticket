'use strict';
const $ = id => document.getElementById(id);
const categories = ['Food & drinks', 'Shopping', 'Transport', 'Bills & utilities', 'Entertainment', 'Health', 'Other'];
const colors = ['#e9c564', '#91bba3', '#8dace0', '#c29acb', '#e6a27b', '#b7c77a', '#a6a6ad'];
const storageKey = 'financial-ticket-expenses-v1';
const money = cents => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
const today = new Date();
const localDate = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
function validDate(value) { const d = new Date(`${value}T12:00:00`); return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(d.getTime()) && d.getFullYear() === Number(value.slice(0,4)) && d.getMonth()+1 === Number(value.slice(5,7)) && d.getDate() === Number(value.slice(8,10)); }
let expenses = [];
try { const saved = JSON.parse(localStorage.getItem(storageKey) || '[]'); if (Array.isArray(saved)) expenses = saved.filter(e => e && typeof e.id === 'string' && typeof e.description === 'string' && Number.isSafeInteger(e.cents) && e.cents > 0 && categories.includes(e.category) && typeof e.date === 'string' && validDate(e.date)); } catch { $('status').textContent = 'Saved data could not be read. You can still use the tracker.'; }
$('date').value = localDate;
$('month').value = localDate.slice(0,7);
function save(message) { try { localStorage.setItem(storageKey, JSON.stringify(expenses)); $('status').textContent = message; } catch { $('status').textContent = `${message} Browser storage is unavailable; changes will last for this session only.`; } render(); }
function render() {
  const selected = expenses.filter(e => e.date.slice(0,7) === $('month').value).sort((a,b) => b.date.localeCompare(a.date));
  const total = selected.reduce((sum,e) => sum + e.cents, 0);
  const totals = categories.map(category => selected.filter(e => e.category === category).reduce((sum,e) => sum + e.cents, 0));
  $('total').textContent = money(total); $('count').textContent = selected.length;
  const top = totals.indexOf(Math.max(...totals));
  $('top').textContent = total ? categories[top] : '—';
  $('top-detail').textContent = total ? `${money(totals[top])} · ${Math.round(totals[top]/total*100)}% of spending` : 'Add an expense to get started';
  const chart = $('category-chart'); chart.replaceChildren();
  if (!total) { const p = document.createElement('p'); p.className = 'empty'; p.textContent = 'Your category breakdown will appear here.'; chart.append(p); }
  else {
    let angle = 0; const stops = [];
    totals.forEach((value,i) => { if (value) { const end = angle + value/total*360; stops.push(`${colors[i]} ${angle}deg ${end}deg`); angle = end; } });
    const donut = document.createElement('div'); donut.className = 'donut'; donut.style.background = `conic-gradient(${stops.join(',')})`; donut.setAttribute('role','img'); donut.setAttribute('aria-label','Spending by category; amounts listed alongside.');
    const legend = document.createElement('ul'); legend.className = 'legend';
    totals.forEach((value,i) => { if (!value) return; const li = document.createElement('li'); const dot = document.createElement('span'); dot.className = 'dot'; dot.style.background = colors[i]; const label = document.createElement('span'); label.textContent = categories[i]; const amount = document.createElement('strong'); amount.textContent = money(value); li.append(dot,label,amount); legend.append(li); }); chart.append(donut,legend);
  }
  const daily = $('daily-chart'); daily.replaceChildren();
  const [year, month] = $('month').value.split('-').map(Number);
  if (year && month) { const days = new Date(year,month,0).getDate(); const values = Array.from({length:days},(_,i) => selected.filter(e => Number(e.date.slice(8)) === i+1).reduce((sum,e) => sum+e.cents,0)); const max = Math.max(...values,1);
    values.forEach((value,i) => { const day = document.createElement('div'); day.className = 'day'; day.tabIndex = 0; day.title = `${$('month').value}-${String(i+1).padStart(2,'0')}: ${money(value)}`; day.setAttribute('aria-label',day.title); const bar = document.createElement('div'); bar.className = 'bar'; bar.style.height = `${value/max*130}px`; if (!value) bar.style.background = '#484b46'; const label = document.createElement('small'); label.textContent = i === 0 || (i+1)%5 === 0 || i === days-1 ? i+1 : ''; day.append(bar,label); daily.append(day); });
  }
  $('transactions').replaceChildren(); $('empty').hidden = selected.length > 0;
  selected.forEach(e => { const row = document.createElement('tr'); [e.description,e.category,new Date(`${e.date}T12:00:00`).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}),money(e.cents)].forEach((value,i) => { const cell = document.createElement('td'); cell.textContent = value; if(i === 3) cell.className = 'money'; row.append(cell); }); const cell = document.createElement('td'); const button = document.createElement('button'); button.type = 'button'; button.className = 'delete'; button.textContent = 'Remove'; button.setAttribute('aria-label',`Remove ${e.description}, ${money(e.cents)}`); button.addEventListener('click',() => { expenses = expenses.filter(item => item.id !== e.id); save('Expense removed.'); }); cell.append(button); row.append(cell); $('transactions').append(row); });
}
$('expense-form').addEventListener('submit',event => { event.preventDefault(); const description = $('description').value.trim(); const cents = Math.round(Number($('amount').value)*100); const date = $('date').value; if (!description || !Number.isSafeInteger(cents) || cents <= 0 || !validDate(date)) { $('status').textContent = 'Enter a description, a positive amount, and a valid date.'; return; } expenses.push({id:globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`,description,cents,category:$('category').value,date}); $('month').value = date.slice(0,7); $('description').value = ''; $('amount').value = ''; save('Expense added. Your charts are up to date.'); $('description').focus(); });
$('month').addEventListener('change',render);
$('sample').addEventListener('click',() => { if (!$('month').value) $('month').value = localDate.slice(0,7); const month = $('month').value; if (expenses.some(e => e.id.startsWith(`sample-${month}-`))) { $('status').textContent = 'Sample data is already loaded for this month.'; return; } [['Groceries',6850,0,2],['Monthly utilities',12000,3,3],['Coffee & a catch-up',1250,0,5],['Train pass',4500,2,6],['Movie night',2400,4,8],['New sneakers',7900,1,10],['Pharmacy',1850,5,12],['Lunch',1675,0,14]].forEach(([description,cents,index,day],i) => expenses.push({id:`sample-${month}-${i}`,description,cents,category:categories[index],date:`${month}-${String(day).padStart(2,'0')}`})); save('Sample expenses added. Add your own expenses to try it out.'); });
render();
