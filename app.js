// The Docket — standalone PWA build. No AI parsing here (see README); updates are logged via a short form.
const STORAGE_KEY = 'docket-data-v1';

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const todayISO = () => new Date().toISOString().slice(0, 10);
const esc = (s) => (s || '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
function daysDiff(iso) {
  if (!iso) return null;
  const t = new Date(todayISO() + 'T00:00:00');
  const d = new Date(iso + 'T00:00:00');
  return Math.round((d - t) / 86400000);
}
function dueLabel(iso) {
  const diff = daysDiff(iso);
  if (diff === null) return '';
  if (diff < 0) return `${Math.abs(diff)}d overdue`;
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff <= 7) return `In ${diff}d`;
  return fmtDate(iso);
}

const STATUS_META = {
  active: { label: 'Active', color: 'var(--moss)' },
  adjourned: { label: 'Adjourned', color: 'var(--brass)' },
  judgment: { label: 'Awaiting judgment', color: 'var(--ink)' },
  closed: { label: 'Closed', color: 'var(--ink-faint)' },
};
const PRIORITY_META = {
  high: { label: 'High', color: 'var(--brick)' },
  medium: { label: 'Medium', color: 'var(--brass)' },
  low: { label: 'Low', color: 'var(--ink-faint)' },
};

let state = {
  cases: [], tasks: [], updates: [], expenses: [],
  tab: 'today', openCaseId: null,
  caseModal: null, taskModal: null, expenseModal: null,
  logCaseId: '',
  search: '', searchFocused: false,
  settings: { theme: 'ink-brass', reminderDays: 7, notifyOnOpen: false },
  finance: { mode: 'case', caseId: '', periodType: 'month', anchorDate: todayISO(), customFrom: '', customTo: '' },
};

const EXPENSE_CATEGORIES = {
  filing: { label: 'Filing fee' },
  transport: { label: 'Transportation' },
  other: { label: 'Other' },
};

const THEMES = [
  { id: 'ink-brass', label: 'Ink & Brass' },
  { id: 'slate-sage', label: 'Slate & Sage' },
  { id: 'midnight', label: 'Midnight' },
  { id: 'parchment', label: 'Parchment' },
];

function applyTheme() {
  const t = state.settings.theme;
  if (!t || t === 'ink-brass') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      state.cases = parsed.cases || [];
      state.tasks = parsed.tasks || [];
      state.updates = parsed.updates || [];
      state.expenses = parsed.expenses || [];
      state.settings = { ...state.settings, ...(parsed.settings || {}) };
    }
  } catch (e) { /* start empty */ }
  applyTheme();
}
function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      cases: state.cases, tasks: state.tasks, updates: state.updates,
      expenses: state.expenses, settings: state.settings,
    }));
  } catch (e) { console.error('Save failed', e); }
}

// ---- Calendar export (.ics) ----
function downloadIcs(title, dateISO, notes) {
  if (!dateISO) return;
  const d = dateISO.replace(/-/g, '');
  const uidStr = uid() + '@thedocket';
  const stamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//The Docket//EN',
    'BEGIN:VEVENT', `UID:${uidStr}`, `DTSTAMP:${stamp}`,
    `DTSTART;VALUE=DATE:${d}`, `SUMMARY:${(title || '').replace(/\n/g, ' ')}`,
    notes ? `DESCRIPTION:${notes.replace(/\n/g, '\\n')}` : '',
    'END:VEVENT', 'END:VCALENDAR',
  ].filter(Boolean).join('\r\n');
  const blob = new Blob([ics], { type: 'text/calendar' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'event.ics'; document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}

// ---- Mutations ----
function setTab(t) { state.tab = t; render(); }
function toggleTask(id) {
  state.tasks = state.tasks.map((t) => t.id === id ? { ...t, done: !t.done } : t);
  save(); render();
}
function deleteTask(id) { state.tasks = state.tasks.filter((t) => t.id !== id); save(); render(); }
function deleteCase(id) {
  if (!confirm('Delete this case and its linked tasks/updates/expenses?')) return;
  state.cases = state.cases.filter((c) => c.id !== id);
  state.tasks = state.tasks.filter((t) => t.caseId !== id);
  state.updates = state.updates.filter((u) => u.caseId !== id);
  state.expenses = state.expenses.filter((x) => x.caseId !== id);
  state.openCaseId = null; save(); render();
}
function toggleCase(id) { state.openCaseId = state.openCaseId === id ? null : id; render(); }
function openCaseModal(idOrNull) { state.caseModal = idOrNull ? state.cases.find((c) => c.id === idOrNull) : 'new'; render(); }
function closeCaseModal() { state.caseModal = null; render(); }
function openTaskModal(idOrCaseId, isCase) {
  if (isCase) state.taskModal = { id: null, caseId: idOrCaseId };
  else state.taskModal = idOrCaseId ? state.tasks.find((t) => t.id === idOrCaseId) : 'new';
  render();
}
function closeTaskModal() { state.taskModal = null; render(); }

function submitCaseForm(e) {
  e.preventDefault();
  const f = e.target;
  const id = f.dataset.id || null;
  const data = {
    id, title: f.elements.title.value.trim(), clientName: f.elements.clientName.value.trim(), court: f.elements.court.value.trim(),
    suitNo: f.elements.suitNo.value.trim(), status: f.elements.status.value,
    nextDate: f.elements.nextDate.value, notes: f.elements.notes.value.trim(),
  };
  if (!data.title) return;
  if (id) state.cases = state.cases.map((c) => c.id === id ? data : c);
  else state.cases = [...state.cases, { ...data, id: uid() }];
  save(); closeCaseModal();
}
function setTheme(themeId) { state.settings.theme = themeId; save(); applyTheme(); render(); }
function setReminderDays(val) {
  const n = Math.max(1, Math.min(60, parseInt(val, 10) || 7));
  state.settings.reminderDays = n; save(); render();
}
function setNotify(checked) {
  if (checked && 'Notification' in window && Notification.permission !== 'granted') {
    Notification.requestPermission().then((perm) => {
      state.settings.notifyOnOpen = perm === 'granted';
      save(); render();
    });
  } else {
    state.settings.notifyOnOpen = checked;
    save(); render();
  }
}

// ---- Finances ----
function openExpenseModal(caseId, existingId) {
  if (existingId) state.expenseModal = state.expenses.find((x) => x.id === existingId);
  else state.expenseModal = { id: null, caseId, date: todayISO(), category: 'filing', amount: '', note: '' };
  render();
}
function closeExpenseModal() { state.expenseModal = null; render(); }
function submitExpenseForm(e) {
  e.preventDefault();
  const f = e.target;
  const id = f.dataset.id || null;
  const amount = parseFloat(f.elements.amount.value);
  if (!amount || amount <= 0) return;
  const data = { id, caseId: f.dataset.caseId, date: f.elements.date.value || todayISO(), category: f.elements.category.value, amount, note: f.elements.note.value.trim() };
  if (id) state.expenses = state.expenses.map((x) => x.id === id ? data : x);
  else state.expenses = [...state.expenses, { ...data, id: uid() }];
  save(); closeExpenseModal();
}
function deleteExpense(id) {
  state.expenses = state.expenses.filter((x) => x.id !== id);
  save(); render();
}
function formatNaira(n) {
  const num = Number(n) || 0;
  return '₦' + num.toLocaleString('en-NG', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}
function caseExpenseTotals(caseId) {
  const items = state.expenses.filter((x) => x.caseId === caseId);
  const totals = { filing: 0, transport: 0, other: 0, total: 0 };
  items.forEach((x) => { totals[x.category] = (totals[x.category] || 0) + x.amount; totals.total += x.amount; });
  return { totals, items: items.sort((a, b) => b.date.localeCompare(a.date)) };
}
function periodRange(type, anchor, from, to) {
  if (type === 'custom') return { start: from || '0000-01-01', end: to || '9999-12-31' };
  const a = new Date((anchor || todayISO()) + 'T00:00:00');
  if (type === 'week') {
    const day = (a.getDay() + 6) % 7; // Monday = 0
    const monday = new Date(a); monday.setDate(a.getDate() - day);
    const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
    return { start: monday.toISOString().slice(0, 10), end: sunday.toISOString().slice(0, 10) };
  }
  if (type === 'month') {
    const start = new Date(a.getFullYear(), a.getMonth(), 1);
    const end = new Date(a.getFullYear(), a.getMonth() + 1, 0);
    return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
  }
  if (type === 'year') {
    return { start: `${a.getFullYear()}-01-01`, end: `${a.getFullYear()}-12-31` };
  }
  return { start: '0000-01-01', end: '9999-12-31' }; // all time
}
function periodReport(start, end) {
  const items = state.expenses.filter((x) => x.date >= start && x.date <= end);
  const casesById = Object.fromEntries(state.cases.map((c) => [c.id, c]));
  const byCategory = { filing: 0, transport: 0, other: 0 };
  const byCaseMap = {};
  let total = 0;
  items.forEach((x) => {
    byCategory[x.category] = (byCategory[x.category] || 0) + x.amount;
    total += x.amount;
    const label = casesById[x.caseId]?.title || 'Unlinked';
    byCaseMap[x.caseId || 'none'] = { title: label, total: (byCaseMap[x.caseId || 'none']?.total || 0) + x.amount };
  });
  const byCase = Object.values(byCaseMap).sort((a, b) => b.total - a.total);
  return { total, byCategory, byCase, items: items.sort((a, b) => b.date.localeCompare(a.date)) };
}
function submitTaskForm(e) {
  e.preventDefault();
  const f = e.target;
  const id = f.dataset.id || null;
  const data = {
    id, text: f.elements.text.value.trim(), dueDate: f.elements.dueDate.value,
    priority: f.elements.priority.value, caseId: f.elements.caseId.value || null,
    done: f.dataset.done === 'true',
  };
  if (!data.text) return;
  if (id) state.tasks = state.tasks.map((t) => t.id === id ? data : t);
  else state.tasks = [...state.tasks, { ...data, id: uid(), done: false }];
  save(); closeTaskModal();
}
function submitLogForm(e) {
  e.preventDefault();
  const f = e.target;
  const caseId = state.logCaseId;
  if (!caseId) return;
  const summary = f.elements.summary.value.trim();
  const adjournedDate = f.elements.adjournedDate.value || null;
  const nextAction = f.elements.nextAction.value.trim() || null;
  const nextActionDueDate = f.elements.nextActionDueDate.value || null;
  if (!summary && !adjournedDate && !nextAction) return;

  state.updates = [...state.updates, { id: uid(), caseId, date: todayISO(), parsed: { summary, adjournedDate, nextAction, nextActionDueDate } }];
  if (adjournedDate) state.cases = state.cases.map((c) => c.id === caseId ? { ...c, nextDate: adjournedDate } : c);
  if (nextAction) {
    state.tasks = [...state.tasks, { id: uid(), text: nextAction, dueDate: nextActionDueDate || adjournedDate || todayISO(), priority: 'medium', caseId, done: false }];
  }
  save();
  f.reset();
  render();
}

// ---- Render ----
function render() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <header class="app-header">
      <div class="header-mark">⚖</div>
      <div>
        <h1>The Docket</h1>
        <p class="header-date">${new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}</p>
      </div>
      <div class="header-actions">
        <button class="icon-btn" onclick="setTab('settings')" title="Settings">⚙</button>
      </div>
    </header>
    <main class="app-body">${renderTab()}</main>
    <nav class="bottom-nav">
      ${navBtn('today', '☀', 'Today')}
      ${navBtn('cases', '⚖', 'Cases')}
      ${navBtn('tasks', '☑', 'Tasks')}
      ${navBtn('log', '✎', 'Log')}
      ${navBtn('finance', '₦', 'Finance')}
    </nav>
    ${state.caseModal ? caseModalHtml() : ''}
    ${state.taskModal ? taskModalHtml() : ''}
    ${state.expenseModal ? expenseModalHtml() : ''}
  `;
  wireForms();
  if (state.searchFocused) {
    const el = document.getElementById('search-input');
    if (el) { el.focus(); const v = el.value; el.setSelectionRange(v.length, v.length); }
  }
}

function navBtn(id, icon, label) {
  return `<button class="nav-btn${state.tab === id ? ' active' : ''}" onclick="setTab('${id}')">
    <span class="nav-icon">${icon}</span><span>${label}</span></button>`;
}

function renderTab() {
  if (state.tab === 'today') return renderToday();
  if (state.tab === 'cases') return renderCases();
  if (state.tab === 'tasks') return renderTasks();
  if (state.tab === 'log') return renderLog();
  if (state.tab === 'settings') return renderSettings();
  if (state.tab === 'finance') return renderFinance();
  return '';
}

function renderToday() {
  const days = state.settings.reminderDays;
  const open = state.tasks.filter((t) => !t.done).sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999'));
  const overdue = open.filter((t) => t.dueDate && daysDiff(t.dueDate) < 0);
  const dueToday = open.filter((t) => t.dueDate && daysDiff(t.dueDate) === 0);
  const week = open.filter((t) => t.dueDate && daysDiff(t.dueDate) > 0 && daysDiff(t.dueDate) <= days);
  const courtSoon = [...state.cases].filter((c) => c.nextDate && daysDiff(c.nextDate) >= 0 && daysDiff(c.nextDate) <= days && c.status !== 'closed')
    .sort((a, b) => a.nextDate.localeCompare(b.nextDate)).slice(0, 5);
  const casesById = Object.fromEntries(state.cases.map((c) => [c.id, c]));

  let html = '';
  if (overdue.length) html += section('Overdue', 'var(--brick)', overdue.map((t) => taskRow(t, casesById[t.caseId]?.title)).join(''));
  html += section('Due today', 'var(--brass)', dueToday.length ? dueToday.map((t) => taskRow(t, casesById[t.caseId]?.title)).join('') : emptyRow('Nothing due today.'));
  html += section(`Next ${days} days`, 'var(--ink-faint)', week.length ? week.map((t) => taskRow(t, casesById[t.caseId]?.title)).join('') : emptyRow(`Nothing else on the horizon in the next ${days} days.`));
  if (courtSoon.length) {
    html += section('Coming up in court', 'var(--moss)', courtSoon.map((c) => `
      <button class="court-row" onclick="toggleCase('${c.id}');setTab('cases')">
        <div><div class="court-row-title">${esc(c.title)}</div>
        <div class="court-row-sub">${esc(c.court || 'Court not set')}${c.suitNo ? ' · ' + esc(c.suitNo) : ''}</div></div>
        <div class="court-row-date">${dueLabel(c.nextDate)}</div>
      </button>`).join(''));
  }
  return html + fab(() => {}, 'log');
}

function renderCases() {
  if (!state.cases.length) return emptyState('No matters yet', 'Add your first case to start tracking hearing dates and tasks against it.', 'Add a case', "openCaseModal(null)");
  const q = state.search.trim().toLowerCase();
  const filtered = state.cases.filter((c) => !q || [c.title, c.clientName, c.court, c.suitNo].some((v) => (v || '').toLowerCase().includes(q)));
  const sorted = [...filtered].sort((a, b) => (a.nextDate || '9999').localeCompare(b.nextDate || '9999'));
  const searchBar = `<div class="search-bar"><span>🔍</span><input id="search-input" type="text" placeholder="Search cases, clients, courts…" value="${esc(state.search)}"
    oninput="state.search=this.value;render()" onfocus="state.searchFocused=true" onblur="state.searchFocused=false" /></div>`;
  if (!sorted.length) return searchBar + emptyRow('No matters match your search.');
  const html = sorted.map((c) => {
    const meta = STATUS_META[c.status] || STATUS_META.active;
    const isOpen = state.openCaseId === c.id;
    const caseTasks = state.tasks.filter((t) => t.caseId === c.id);
    const caseUpdates = state.updates.filter((u) => u.caseId === c.id).sort((a, b) => b.date.localeCompare(a.date));
    return `<div class="case-card" style="border-left-color:${meta.color}">
      <button class="case-card-head" onclick="toggleCase('${c.id}')">
        <div><div class="case-title">${esc(c.title)}</div>
        <div class="case-sub">${c.clientName ? 'Client: ' + esc(c.clientName) + ' · ' : ''}${esc(c.court || 'Court not set')}${c.suitNo ? ' · ' + esc(c.suitNo) : ''}</div></div>
        <div class="case-card-right">
          <span class="status-dot" style="background:${meta.color}"></span>
          <span class="status-label">${meta.label}</span>
          <span class="chev${isOpen ? ' chev-open' : ''}">›</span>
        </div>
      </button>
      ${c.nextDate ? `<div class="case-next-date">
          <span>📅 Next date: ${fmtDate(c.nextDate)} · ${dueLabel(c.nextDate)}</span>
          <button class="cal-btn" title="Add to calendar" onclick="downloadIcs('${esc(c.title).replace(/'/g,"\\'")} — court date','${c.nextDate}','${esc(c.court||'')}')">⬇︎ .ics</button>
        </div>` : ''}
      ${isOpen ? `<div class="case-detail">
          ${c.notes ? `<p class="case-notes">${esc(c.notes)}</p>` : ''}
          <div class="case-tasks-label">Tasks on this matter</div>
          ${caseTasks.length ? caseTasks.map((t) => taskRow(t, null, true)).join('') : emptyRow('No tasks linked yet.')}
          ${caseUpdates.length ? `<div class="case-updates-label">Logged updates</div>${caseUpdates.map(logEntryHtml).join('')}` : ''}
          ${financeSectionHtml(c.id)}
          <div class="case-actions">
            <button class="text-btn" onclick="openTaskModal('${c.id}', true)">＋ Add task</button>
            <button class="text-btn" onclick="openCaseModal('${c.id}')">✎ Edit</button>
            <button class="text-btn text-btn-danger" onclick="deleteCase('${c.id}')">🗑 Delete</button>
          </div>
        </div>` : ''}
    </div>`;
  }).join('');
  return searchBar + `<div class="case-list">${html}</div>` + fab("openCaseModal(null)");
}

function financeSectionHtml(caseId) {
  const { totals, items } = caseExpenseTotals(caseId);
  return `
    <div class="case-updates-label">Finances</div>
    <div class="finance-totals">
      <div><span>Filing</span><b>${formatNaira(totals.filing)}</b></div>
      <div><span>Transport</span><b>${formatNaira(totals.transport)}</b></div>
      <div><span>Other</span><b>${formatNaira(totals.other)}</b></div>
      <div class="finance-total-row"><span>Total spent</span><b>${formatNaira(totals.total)}</b></div>
    </div>
    ${items.length ? `<div class="expense-list">${items.map((x) => expenseRow(x)).join('')}</div>` : emptyRow('No expenses logged for this matter yet.')}
    <button class="text-btn" onclick="openExpenseModal('${caseId}')">＋ Add expense</button>
  `;
}
function expenseRow(x) {
  return `<div class="expense-row">
    <div class="expense-row-main" onclick="openExpenseModal('${x.caseId}','${x.id}')">
      <span class="expense-cat">${EXPENSE_CATEGORIES[x.category]?.label || x.category}</span>
      <span class="expense-note">${esc(x.note) || fmtDate(x.date)}</span>
    </div>
    <span class="expense-amount">${formatNaira(x.amount)}</span>
    <button class="task-delete" onclick="deleteExpense('${x.id}')">🗑</button>
  </div>`;
}

function renderTasks() {
  const casesById = Object.fromEntries(state.cases.map((c) => [c.id, c]));
  const q = state.search.trim().toLowerCase();
  const all = [...state.tasks].sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999'));
  if (!all.length) return emptyState('No tasks yet', "Add a task to keep track of what's outstanding, with or without a case attached.", 'Add a task', "openTaskModal(null)");
  const searchBar = `<div class="search-bar"><span>🔍</span><input id="search-input" type="text" placeholder="Search tasks…" value="${esc(state.search)}"
    oninput="state.search=this.value;render()" onfocus="state.searchFocused=true" onblur="state.searchFocused=false" /></div>`;
  const sorted = all.filter((t) => !q || t.text.toLowerCase().includes(q) || (casesById[t.caseId]?.title || '').toLowerCase().includes(q));
  if (!sorted.length) return searchBar + emptyRow('No tasks match your search.');
  const open = sorted.filter((t) => !t.done), done = sorted.filter((t) => t.done);
  let html = section('Outstanding', 'var(--brass)', open.length ? open.map((t) => taskRow(t, casesById[t.caseId]?.title, false, true)).join('') : emptyRow('Nothing outstanding.'));
  if (done.length) html += section('Done', 'var(--moss)', done.map((t) => taskRow(t, casesById[t.caseId]?.title, false, true)).join(''));
  return searchBar + html + fab("openTaskModal(null)");
}

function renderSettings() {
  const s = state.settings;
  const swatches = THEMES.map((t) => `
    <button class="theme-swatch" onclick="setTheme('${t.id}')">
      <span class="theme-swatch-preview${s.theme === t.id ? ' selected' : ''}" data-theme-preview="${t.id}"></span>
      <span>${t.label}</span>
    </button>`).join('');
  const notifSupported = 'Notification' in window;
  return `
    <button class="text-btn" style="margin-bottom:18px" onclick="setTab('today')">‹ Back</button>

    <div class="settings-group">
      <h3>Appearance</h3>
      <p class="settings-desc">Pick the colour theme for the app.</p>
      <div class="theme-swatches">${swatches}</div>
    </div>

    <div class="settings-group">
      <h3>Reminders</h3>
      <p class="settings-desc">How far ahead should Today and "Coming up in court" look?</p>
      <div class="settings-row">
        <div>
          <div class="settings-row-label">Look-ahead window</div>
          <div class="settings-row-sub">Cases and tasks due within this many days show up as "coming soon"</div>
        </div>
        <input class="days-input" type="number" min="1" max="60" value="${s.reminderDays}"
          onchange="setReminderDays(this.value)" /> days
      </div>
      <div class="settings-row">
        <div>
          <div class="settings-row-label">Notify when I open the app</div>
          <div class="settings-row-sub">${notifSupported ? 'Shows a browser notification if anything falls inside the window above. Only fires while you have the app open — there\'s no background push.' : 'Not supported in this browser.'}</div>
        </div>
        <label class="toggle">
          <input type="checkbox" ${s.notifyOnOpen ? 'checked' : ''} ${notifSupported ? '' : 'disabled'} onchange="setNotify(this.checked)" />
          <span class="toggle-track"></span><span class="toggle-thumb"></span>
        </label>
      </div>
    </div>
  `;
}

function renderLog() {
  if (!state.cases.length) return emptyState('Add a case first', "Once you have a matter on the docket, you can log what happened after each sitting here.", 'Add a case', "openCaseModal(null)");
  const options = state.cases.map((c) => `<option value="${c.id}" ${state.logCaseId === c.id ? 'selected' : ''}>${esc(c.title)}</option>`).join('');
  const entries = state.logCaseId ? state.updates.filter((u) => u.caseId === state.logCaseId).sort((a, b) => b.date.localeCompare(a.date)) : [];
  return `
    <div class="field" style="margin-bottom:14px">
      <select onchange="state.logCaseId=this.value;render()">
        <option value="">Choose a case to log against…</option>
        ${options}
      </select>
    </div>
    ${!state.logCaseId ? `<p class="log-hint">Pick a case above, then log what happened at the sitting — the date and next action feed straight into Today and Tasks.</p>` : `
      <form onsubmit="submitLogForm(event)" class="modal-form" style="margin-bottom:20px">
        <div class="field"><span class="field-label">What happened at this sitting</span>
          <textarea name="summary" rows="2" placeholder="e.g. Matter came up, plaintiff's counsel absent"></textarea></div>
        <div class="field"><span class="field-label">Adjourned / next court date</span>
          <input type="date" name="adjournedDate" /></div>
        <div class="field"><span class="field-label">Next action (optional)</span>
          <input name="nextAction" placeholder="e.g. File additional witness statement" /></div>
        <div class="field"><span class="field-label">Next action due by</span>
          <input type="date" name="nextActionDueDate" /></div>
        <button type="submit" class="primary-btn">Log update</button>
      </form>
      ${entries.length ? entries.map(logEntryHtml).join('') : `<p class="log-hint">No updates logged for this matter yet.</p>`}
    `}
  `;
}

function renderFinance() {
  if (!state.cases.length) return emptyState('No matters yet', 'Add a case first, then you can log filing and transport costs against it.', 'Add a case', "openCaseModal(null)");
  const fin = state.finance;
  const modeTabs = `
    <div class="finance-mode-tabs">
      <button class="finance-mode-btn${fin.mode === 'case' ? ' active' : ''}" onclick="state.finance.mode='case';render()">By case</button>
      <button class="finance-mode-btn${fin.mode === 'period' ? ' active' : ''}" onclick="state.finance.mode='period';render()">By period</button>
    </div>`;
  return modeTabs + (fin.mode === 'case' ? renderCaseFinanceReport() : renderPeriodFinanceReport());
}

function renderCaseFinanceReport() {
  const fin = state.finance;
  const options = state.cases.map((c) => `<option value="${c.id}" ${fin.caseId === c.id ? 'selected' : ''}>${esc(c.title)}</option>`).join('');
  let body = `<p class="log-hint">Pick a case to see everything spent on it.</p>`;
  if (fin.caseId) {
    const c = state.cases.find((x) => x.id === fin.caseId);
    if (c) {
      const { totals, items } = caseExpenseTotals(c.id);
      body = `
        <div class="finance-totals">
          <div><span>Filing</span><b>${formatNaira(totals.filing)}</b></div>
          <div><span>Transport</span><b>${formatNaira(totals.transport)}</b></div>
          <div><span>Other</span><b>${formatNaira(totals.other)}</b></div>
          <div class="finance-total-row"><span>Total spent on ${esc(c.title)}</span><b>${formatNaira(totals.total)}</b></div>
        </div>
        ${items.length ? `<div class="expense-list">${items.map((x) => expenseRow(x)).join('')}</div>` : emptyRow('No expenses logged for this matter yet.')}
        <button class="text-btn" onclick="openExpenseModal('${c.id}')">＋ Add expense</button>
      `;
    }
  }
  return `<div class="field" style="margin:14px 0">
      <select onchange="state.finance.caseId=this.value;render()">
        <option value="">Choose a case…</option>${options}
      </select>
    </div>${body}`;
}

function renderPeriodFinanceReport() {
  const fin = state.finance;
  const typeSelect = `
    <select onchange="state.finance.periodType=this.value;render()">
      <option value="week" ${fin.periodType === 'week' ? 'selected' : ''}>Weekly</option>
      <option value="month" ${fin.periodType === 'month' ? 'selected' : ''}>Monthly</option>
      <option value="year" ${fin.periodType === 'year' ? 'selected' : ''}>Yearly</option>
      <option value="all" ${fin.periodType === 'all' ? 'selected' : ''}>All time</option>
      <option value="custom" ${fin.periodType === 'custom' ? 'selected' : ''}>Custom range</option>
    </select>`;
  let rangeInput = '';
  if (fin.periodType === 'custom') {
    rangeInput = `
      <div class="finance-range-row">
        <input type="date" value="${fin.customFrom}" onchange="state.finance.customFrom=this.value;render()" />
        <span>to</span>
        <input type="date" value="${fin.customTo}" onchange="state.finance.customTo=this.value;render()" />
      </div>`;
  } else if (fin.periodType !== 'all') {
    rangeInput = `<input type="date" value="${fin.anchorDate}" onchange="state.finance.anchorDate=this.value;render()" />`;
  }
  const { start, end } = periodRange(fin.periodType, fin.anchorDate, fin.customFrom, fin.customTo);
  const report = periodReport(start, end);
  const rangeLabel = fin.periodType === 'all' ? 'all time' : `${fmtDate(start)} – ${fmtDate(end)}`;

  return `
    <div class="field" style="margin:14px 0">${typeSelect}${rangeInput}</div>
    <p class="log-hint">Showing ${rangeLabel}</p>
    <div class="finance-totals">
      <div><span>Filing</span><b>${formatNaira(report.byCategory.filing)}</b></div>
      <div><span>Transport</span><b>${formatNaira(report.byCategory.transport)}</b></div>
      <div><span>Other</span><b>${formatNaira(report.byCategory.other)}</b></div>
      <div class="finance-total-row"><span>Total expended</span><b>${formatNaira(report.total)}</b></div>
    </div>
    ${report.byCase.length ? `
      <div class="case-updates-label">By case</div>
      <div class="expense-list">${report.byCase.map((c) => `<div class="expense-row"><div class="expense-row-main"><span class="expense-note">${esc(c.title)}</span></div><span class="expense-amount">${formatNaira(c.total)}</span></div>`).join('')}</div>
    ` : emptyRow('No expenses recorded in this period.')}
  `;
}
function logEntryHtml(u) {
  const p = u.parsed;
  return `<div class="log-entry">
    <div class="log-entry-date">${fmtDate(u.date)}</div>
    ${p.summary ? `<p>${esc(p.summary)}</p>` : ''}
    <ul>
      ${p.adjournedDate ? `<li>Adjourned to ${fmtDate(p.adjournedDate)}</li>` : ''}
      ${p.nextAction ? `<li>Next: ${esc(p.nextAction)}${p.nextActionDueDate ? ' (by ' + fmtDate(p.nextActionDueDate) + ')' : ''}</li>` : ''}
      ${!p.adjournedDate && !p.nextAction ? '<li>No date or action logged.</li>' : ''}
    </ul>
  </div>`;
}

function section(title, accent, body) {
  return `<section class="section">
    <div class="section-head"><span class="section-bar" style="background:${accent}"></span><h2>${title}</h2></div>
    <div class="section-body">${body}</div>
  </section>`;
}
function emptyRow(text) { return `<div class="empty-row">${esc(text)}</div>`; }
function emptyState(title, body, cta, onclick) {
  return `<div class="empty-state"><h3>${esc(title)}</h3><p>${esc(body)}</p>
    <button class="primary-btn" onclick="${onclick}">${esc(cta)}</button></div>`;
}
function fab(onclick, gotoLog) {
  const action = gotoLog === 'log' ? "setTab('log')" : onclick;
  return `<button class="fab" onclick="${action}">${gotoLog === 'log' ? '✎' : '＋'}</button>`;
}
function taskRow(t, caseLabel, compact, showDelete) {
  const pr = PRIORITY_META[t.priority] || PRIORITY_META.medium;
  const overdue = t.dueDate && !t.done && daysDiff(t.dueDate) < 0;
  return `<div class="task-row" style="border-left-color:${t.done ? 'var(--ink-faint)' : pr.color}">
    <button class="task-check" onclick="toggleTask('${t.id}')">${t.done ? '✓' : '○'}</button>
    <button class="task-main" onclick="openTaskModal('${t.id}')">
      <div class="task-text${t.done ? ' task-text-done' : ''}">${esc(t.text)}</div>
      <div class="task-meta">
        ${caseLabel ? `<span class="task-case">${esc(caseLabel)}</span>` : ''}
        ${t.dueDate ? `<span class="task-due${overdue ? ' task-due-overdue' : ''}">${overdue ? '⚠ ' : ''}${dueLabel(t.dueDate)}</span>` : ''}
      </div>
    </button>
    ${t.dueDate ? `<button class="cal-btn" title="Add to calendar" onclick="event.stopPropagation();downloadIcs('${esc(t.text).replace(/'/g,"\\'")}','${t.dueDate}','')">⬇︎</button>` : ''}
    ${showDelete ? `<button class="task-delete" onclick="deleteTask('${t.id}')">🗑</button>` : ''}
  </div>`;
}

function caseModalHtml() {
  const c = state.caseModal === 'new' ? null : state.caseModal;
  const statusOpts = Object.entries(STATUS_META).map(([k, v]) => `<option value="${k}" ${c?.status === k ? 'selected' : ''}>${v.label}</option>`).join('');
  return `<div class="modal-overlay" onclick="closeCaseModal()">
    <div class="modal-sheet" onclick="event.stopPropagation()">
      <div class="modal-head"><h2>${c ? 'Edit case' : 'Add case'}</h2><button class="modal-close" onclick="closeCaseModal()">✕</button></div>
      <form onsubmit="submitCaseForm(event)" class="modal-form" data-id="${c ? c.id : ''}">
        <div class="field"><span class="field-label">Case title / parties</span><input name="title" autofocus value="${esc(c?.title)}" placeholder="e.g. Polaris Bank v. Okafor" /></div>
        <div class="field"><span class="field-label">Client name</span><input name="clientName" value="${esc(c?.clientName)}" placeholder="e.g. Chukwuma Okafor" /></div>
        <div class="field"><span class="field-label">Court</span><input name="court" value="${esc(c?.court)}" placeholder="e.g. High Court of Enugu State" /></div>
        <div class="field"><span class="field-label">Suit number</span><input name="suitNo" value="${esc(c?.suitNo)}" placeholder="e.g. E/123/2026" /></div>
        <div class="field"><span class="field-label">Status</span><select name="status">${statusOpts}</select></div>
        <div class="field"><span class="field-label">Next court date</span><input type="date" name="nextDate" value="${c?.nextDate || ''}" /></div>
        <div class="field"><span class="field-label">Notes</span><textarea name="notes" rows="3">${esc(c?.notes)}</textarea></div>
        <button type="submit" class="primary-btn">${c ? 'Save changes' : 'Add case'}</button>
      </form>
    </div>
  </div>`;
}
function taskModalHtml() {
  const t = state.taskModal === 'new' ? null : state.taskModal;
  const prOpts = Object.entries(PRIORITY_META).map(([k, v]) => `<option value="${k}" ${t?.priority === k ? 'selected' : ''}>${v.label}</option>`).join('');
  const caseOpts = state.cases.map((c) => `<option value="${c.id}" ${t?.caseId === c.id ? 'selected' : ''}>${esc(c.title)}</option>`).join('');
  return `<div class="modal-overlay" onclick="closeTaskModal()">
    <div class="modal-sheet" onclick="event.stopPropagation()">
      <div class="modal-head"><h2>${t?.id ? 'Edit task' : 'Add task'}</h2><button class="modal-close" onclick="closeTaskModal()">✕</button></div>
      <form onsubmit="submitTaskForm(event)" class="modal-form" data-id="${t?.id || ''}" data-done="${t?.done || false}">
        <div class="field"><span class="field-label">Task</span><input name="text" autofocus value="${esc(t?.text)}" placeholder="e.g. File written address" /></div>
        <div class="field"><span class="field-label">Due date</span><input type="date" name="dueDate" value="${t?.dueDate || todayISO()}" /></div>
        <div class="field"><span class="field-label">Priority</span><select name="priority">${prOpts}</select></div>
        <div class="field"><span class="field-label">Linked case (optional)</span><select name="caseId"><option value="">No case</option>${caseOpts}</select></div>
        <button type="submit" class="primary-btn">${t?.id ? 'Save changes' : 'Add task'}</button>
      </form>
    </div>
  </div>`;
}
function wireForms() { /* forms use inline onsubmit; nothing extra to wire */ }
function expenseModalHtml() {
  const x = state.expenseModal;
  const catOpts = Object.entries(EXPENSE_CATEGORIES).map(([k, v]) => `<option value="${k}" ${x.category === k ? 'selected' : ''}>${v.label}</option>`).join('');
  return `<div class="modal-overlay" onclick="closeExpenseModal()">
    <div class="modal-sheet" onclick="event.stopPropagation()">
      <div class="modal-head"><h2>${x.id ? 'Edit expense' : 'Add expense'}</h2><button class="modal-close" onclick="closeExpenseModal()">✕</button></div>
      <form onsubmit="submitExpenseForm(event)" class="modal-form" data-id="${x.id || ''}" data-case-id="${x.caseId}">
        <div class="field"><span class="field-label">Category</span><select name="category">${catOpts}</select></div>
        <div class="field"><span class="field-label">Amount (₦)</span><input type="number" name="amount" min="0" step="0.01" autofocus value="${x.amount || ''}" placeholder="e.g. 5000" /></div>
        <div class="field"><span class="field-label">Date</span><input type="date" name="date" value="${x.date || todayISO()}" /></div>
        <div class="field"><span class="field-label">Note (optional)</span><input name="note" value="${esc(x.note)}" placeholder="e.g. Filing of motion, or taxi to court" /></div>
        <button type="submit" class="primary-btn">${x.id ? 'Save changes' : 'Add expense'}</button>
      </form>
    </div>
  </div>`;
}

// ---- Install prompt ----
let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
});

// ---- Service worker ----
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  });
}

load();
render();

// Notify-on-open: fires once per app load, only while the app is actually open in the browser.
if (state.settings.notifyOnOpen && 'Notification' in window && Notification.permission === 'granted') {
  const days = state.settings.reminderDays;
  const soonTasks = state.tasks.filter((t) => !t.done && t.dueDate && daysDiff(t.dueDate) <= days);
  const soonCases = state.cases.filter((c) => c.nextDate && c.status !== 'closed' && daysDiff(c.nextDate) >= 0 && daysDiff(c.nextDate) <= days);
  const count = soonTasks.length + soonCases.length;
  if (count > 0) {
    try {
      new Notification('The Docket', { body: `${count} item${count === 1 ? '' : 's'} coming up within ${days} days.` });
    } catch (e) { /* ignore */ }
  }
}
