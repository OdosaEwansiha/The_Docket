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
  cases: [], tasks: [], updates: [],
  tab: 'today', openCaseId: null,
  caseModal: null, taskModal: null,
  logCaseId: '',
};

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      state.cases = parsed.cases || [];
      state.tasks = parsed.tasks || [];
      state.updates = parsed.updates || [];
    }
  } catch (e) { /* start empty */ }
}
function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ cases: state.cases, tasks: state.tasks, updates: state.updates }));
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
  if (!confirm('Delete this case and its linked tasks/updates?')) return;
  state.cases = state.cases.filter((c) => c.id !== id);
  state.tasks = state.tasks.filter((t) => t.caseId !== id);
  state.updates = state.updates.filter((u) => u.caseId !== id);
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
    id, title: f.title.value.trim(), court: f.court.value.trim(),
    suitNo: f.suitNo.value.trim(), status: f.status.value,
    nextDate: f.nextDate.value, notes: f.notes.value.trim(),
  };
  if (!data.title) return;
  if (id) state.cases = state.cases.map((c) => c.id === id ? data : c);
  else state.cases = [...state.cases, { ...data, id: uid() }];
  save(); closeCaseModal();
}
function submitTaskForm(e) {
  e.preventDefault();
  const f = e.target;
  const id = f.dataset.id || null;
  const data = {
    id, text: f.text.value.trim(), dueDate: f.dueDate.value,
    priority: f.priority.value, caseId: f.caseId.value || null,
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
  const summary = f.summary.value.trim();
  const adjournedDate = f.adjournedDate.value || null;
  const nextAction = f.nextAction.value.trim() || null;
  const nextActionDueDate = f.nextActionDueDate.value || null;
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
    </header>
    <main class="app-body">${renderTab()}</main>
    <nav class="bottom-nav">
      ${navBtn('today', '☀', 'Today')}
      ${navBtn('cases', '⚖', 'Cases')}
      ${navBtn('tasks', '☑', 'Tasks')}
      ${navBtn('log', '✎', 'Log')}
    </nav>
    ${state.caseModal ? caseModalHtml() : ''}
    ${state.taskModal ? taskModalHtml() : ''}
  `;
  wireForms();
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
  return '';
}

function renderToday() {
  const open = state.tasks.filter((t) => !t.done).sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999'));
  const overdue = open.filter((t) => t.dueDate && daysDiff(t.dueDate) < 0);
  const dueToday = open.filter((t) => t.dueDate && daysDiff(t.dueDate) === 0);
  const week = open.filter((t) => t.dueDate && daysDiff(t.dueDate) > 0 && daysDiff(t.dueDate) <= 7);
  const courtSoon = [...state.cases].filter((c) => c.nextDate && daysDiff(c.nextDate) >= 0 && c.status !== 'closed')
    .sort((a, b) => a.nextDate.localeCompare(b.nextDate)).slice(0, 5);
  const casesById = Object.fromEntries(state.cases.map((c) => [c.id, c]));

  let html = '';
  if (overdue.length) html += section('Overdue', 'var(--brick)', overdue.map((t) => taskRow(t, casesById[t.caseId]?.title)).join(''));
  html += section('Due today', 'var(--brass)', dueToday.length ? dueToday.map((t) => taskRow(t, casesById[t.caseId]?.title)).join('') : emptyRow('Nothing due today.'));
  html += section('Next 7 days', 'var(--ink-faint)', week.length ? week.map((t) => taskRow(t, casesById[t.caseId]?.title)).join('') : emptyRow('Nothing else on the horizon this week.'));
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
  const sorted = [...state.cases].sort((a, b) => (a.nextDate || '9999').localeCompare(b.nextDate || '9999'));
  const html = sorted.map((c) => {
    const meta = STATUS_META[c.status] || STATUS_META.active;
    const isOpen = state.openCaseId === c.id;
    const caseTasks = state.tasks.filter((t) => t.caseId === c.id);
    const caseUpdates = state.updates.filter((u) => u.caseId === c.id).sort((a, b) => b.date.localeCompare(a.date));
    return `<div class="case-card" style="border-left-color:${meta.color}">
      <button class="case-card-head" onclick="toggleCase('${c.id}')">
        <div><div class="case-title">${esc(c.title)}</div>
        <div class="case-sub">${esc(c.court || 'Court not set')}${c.suitNo ? ' · ' + esc(c.suitNo) : ''}</div></div>
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
          <div class="case-actions">
            <button class="text-btn" onclick="openTaskModal('${c.id}', true)">＋ Add task</button>
            <button class="text-btn" onclick="openCaseModal('${c.id}')">✎ Edit</button>
            <button class="text-btn text-btn-danger" onclick="deleteCase('${c.id}')">🗑 Delete</button>
          </div>
        </div>` : ''}
    </div>`;
  }).join('');
  return `<div class="case-list">${html}</div>` + fab("openCaseModal(null)");
}

function renderTasks() {
  const casesById = Object.fromEntries(state.cases.map((c) => [c.id, c]));
  const sorted = [...state.tasks].sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999'));
  if (!sorted.length) return emptyState('No tasks yet', "Add a task to keep track of what's outstanding, with or without a case attached.", 'Add a task', "openTaskModal(null)");
  const open = sorted.filter((t) => !t.done), done = sorted.filter((t) => t.done);
  let html = section('Outstanding', 'var(--brass)', open.length ? open.map((t) => taskRow(t, casesById[t.caseId]?.title, false, true)).join('') : emptyRow('Nothing outstanding.'));
  if (done.length) html += section('Done', 'var(--moss)', done.map((t) => taskRow(t, casesById[t.caseId]?.title, false, true)).join(''));
  return html + fab("openTaskModal(null)");
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
