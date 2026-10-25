import { taskPhase } from './task-state.js';
function readPreference(key, fallback = '') {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function writePreference(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}
let closedFolders = new Set();
try {
  const saved = JSON.parse(readPreference('tasks-closed-folders', '[]'));
  if (Array.isArray(saved)) closedFolders = new Set(saved.filter(id => typeof id === 'string'));
} catch {}
const timeFormatter = new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
let tasksLoading = false;
let detailRequest = 0;
let detailLoadingId = null;
let quickTaskId = null;
let quickDirty = new Set();
let quickSaving = false;
let dragging = null;
let moving = false;
const state = { collections: { folders: [], categories: [] }, category: readPreference('tasks-category'), tasks: [], filter: 'open', label: readPreference('tasks-label'), sort: readPreference('tasks-sort', 'created'), busy: new Set(), selectedTaskId: null, detail: null };
const grid = document.querySelector('#task-grid');
const empty = document.querySelector('#empty-state');
const toast = document.querySelector('#toast');
const dialog = document.querySelector('#task-dialog');
const VIEW_COPY = {
  inbox: ['Inbox', '会話から拾った候補を短時間で仕分けします。'],
  open: ['Open', '未着手と作業中のタスクです。'],
  all: ['All', '候補から完了まで、現在の仕事をまとめて表示します。'],
  closed: ['Closed', '結果を確認して完了にしたタスクです。'],
};

async function api(path, options = {}) {
  const response = await fetch(new URL(path.replace(/^\//, ''), document.baseURI), {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  if (response.status === 401) throw new Error('xangiへの接続を確認して、拡張画面を開き直してください。');
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

function showToast(message) {
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => (toast.hidden = true), 3500);
}

function statusLabel(status) {
  return { inbox: 'Inbox', open: 'Open', closed: 'Closed', idle: '未着手', working: '作業中', delegating: '依頼中', running: '実行中', completing: '完了処理中', review: '確認待ち', failed: '失敗', dismissed: '却下' }[status] || status;
}

function taskStatusLabel(task) {
  return statusLabel(task.status) + (task.status === 'open' ? ` · ${statusLabel(task.executionStatus)}` : task.closedReason === 'dismissed' ? ' · 却下' : '');
}

function typeLabel(type) {
  return { action: 'ACTION', waiting: 'WAITING', hold: 'HOLD' }[type] || '';
}

function formatTime(iso) {
  const date = new Date(iso);
  return timeFormatter.format(date);
}

function taskMatches(task) {
  if (state.category === 'uncategorized' && task.categoryId) return false;
  if (state.category && state.category !== 'uncategorized' && task.categoryId !== state.category) return false;
  if (state.label && !(task.labels || []).includes(state.label)) return false;
  return state.filter === 'all' || task.status === state.filter;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function actionButton(label, action, task, className = '') {
  const button = element('button', `button ${className}`.trim(), label);
  button.dataset.action = action;
  button.dataset.id = task.id;
  button.disabled = state.busy.has(task.id);
  return button;
}

function renderTask(task) {
  const row = element('article', 'task-card');
  row.dataset.status = task.status;
  row.dataset.executionStatus = task.executionStatus;
  row.dataset.id = task.id;
  row.classList.toggle('selected', task.id === state.selectedTaskId);
  const complete = actionButton(taskPhase(task) === 'closed' ? '✓' : '', task.status === 'closed' ? 'open' : 'close', task, 'task-check');
  complete.setAttribute('aria-label', `${task.title}を完了にする`);
  complete.disabled = state.busy.has(task.id) || !['idle', 'working', 'running', 'review', 'closed'].includes(taskPhase(task));
  if (taskPhase(task) === 'closed') complete.setAttribute('aria-label', `${task.title}を未着手に戻す`);
  const open = actionButton('', 'show', task, 'task-open');
  const heading = element('h3', '', task.title);
  open.append(heading);
  open.setAttribute('aria-label', `${task.title}の詳細を開く`);
  const meta = element('span', 'row-meta');
  if (state.filter === 'all' || ['failed', 'completing', 'delegating'].includes(taskPhase(task))) {
    meta.append(element('span', `status-badge status-${taskPhase(task)}`, taskStatusLabel(task)));
  }
  if (task.dueDate) meta.append(element('span', 'row-due', task.dueDate));
  if (task.repeat) {
    const repeat = element('span', 'row-repeat', '↻');
    repeat.setAttribute('aria-label', repeatLabel(task.repeat));
    meta.append(repeat);
  }
  if (task.error || task.titleSyncError) meta.append(element('span', 'row-warning', '要確認'));
  if (meta.children.length) open.append(meta);
  makeDraggable(open, 'task', task.id);
  row.append(moveHandle('task', task.id, task.title), complete, open);
  return row;
}

function conversationUrl(task, xangiOrigin = state.detail?.xangiOrigin) {
  if (!task?.xangiSessionId) return null;
  const embedded = location.pathname.startsWith('/api/extensions/');
  const origin = embedded ? location.origin : xangiOrigin;
  if (!origin) return null;
  const url = new URL(origin);
  if (!embedded && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) url.hostname = location.hostname;
  url.pathname = `/chat/${encodeURIComponent(task.xangiSessionId)}`;
  url.search = ''; url.hash = '';
  return url;
}

function renderTaskActions(task) {
  const actions = element('div', 'card-actions');
  if (taskPhase(task) === 'inbox') {
    actions.append(actionButton('Openにする', 'open', task, 'primary'));
  }
  if (['idle', 'working', 'review', 'failed', 'closed'].includes(taskPhase(task))) actions.append(actionButton('xangiへ依頼', 'delegate', task, 'primary'));
  if (['delegating', 'running', 'completing'].includes(taskPhase(task))) actions.append(actionButton('状態を同期', 'sync', task));
  if (taskPhase(task) === 'idle') actions.append(actionButton('作業中にする', 'start', task));
  if (['working', 'review', 'failed'].includes(taskPhase(task))) actions.append(actionButton('未着手に戻す', 'reset', task));
  if (task.status === 'closed') actions.append(actionButton('Openに戻す', 'open', task));
  if (['idle', 'working', 'running', 'review'].includes(taskPhase(task))) actions.append(actionButton('完了', 'close', task, 'success'));
  actions.append(actionButton('繰り返し・詳細設定', 'edit', task));
  actions.append(actionButton('リンクをコピー', 'copy-link', task));
  if (task.xangiSessionId) {
    const url = conversationUrl(task);
    if (url) {
      const link = element('a', 'button', 'xangiの会話を開く');
      link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer';
      actions.append(link);
    }
  }

  if (!['delegating', 'running', 'completing'].includes(taskPhase(task))) actions.append(actionButton('削除', 'delete', task));
  return actions;
}

function renderDetail() {
  if (!state.detail) return;
  const { task, historyError = '' } = state.detail;
  const status = document.querySelector('#detail-status');
  status.className = `status-badge status-${taskPhase(task)}`;
  status.textContent = taskStatusLabel(task);
  document.querySelector('#detail-session').textContent = `ID: ${task.id}`;
  renderQuickEdit(task);
  renderNotion(task);
  const metadata = [task.repeat && repeatLabel(task.repeat), task.type && typeLabel(task.type), `更新: ${formatTime(task.updatedAt)}`].filter(Boolean);
  document.querySelector('#detail-properties').textContent = metadata.join(' / ');

  const source = document.querySelector('#detail-source');
  source.hidden = !task.source?.text;
  document.querySelector('#detail-source-text').textContent = task.source?.text || '';
  const sourceLink = document.querySelector('#detail-source-link');
  sourceLink.hidden = !task.source?.url;
  sourceLink.href = task.source?.url || '#';

  const error = document.querySelector('#detail-error');
  error.hidden = !historyError && !task.error && !task.titleSyncError;
  error.textContent = [historyError, task.error, task.titleSyncError].filter(Boolean).join('\n');

  const actions = document.querySelector('#detail-actions');
  const focusedAction = actions.contains(document.activeElement) ? document.activeElement.dataset.action : null;
  actions.replaceChildren(renderTaskActions(task));
  if (focusedAction) {
    const next = [...actions.querySelectorAll('button')].find(button => button.dataset.action === focusedAction && !button.disabled);
    (next || document.querySelector('#close-detail')).focus({ preventScroll: true });
  }
}

function renderQuickEdit(task) {
  const changedTask = quickTaskId !== task.id;
  if (changedTask) {
    quickTaskId = task.id;
    quickDirty = new Set();
    document.querySelector('#quick-save-status').textContent = '変更すると保存します';
    document.querySelector('#quick-retry').hidden = true;
  }
  const status = document.querySelector('#quick-status');
  const choices = task.status === 'inbox' ? ['inbox', 'open'] : ['open', 'closed'];
  status.replaceChildren(...choices.map(value => new Option(statusLabel(value), value)));
  status.value = task.status;
  const execution = document.querySelector('#quick-execution');
  const executionChoices = ['idle', 'working'];
  if (!executionChoices.includes(task.executionStatus)) executionChoices.push(task.executionStatus);
  execution.replaceChildren(...executionChoices.map(value => new Option(statusLabel(value), value)));
  execution.value = task.executionStatus;
  for (const [name, value] of [['categoryId', task.categoryId || ''], ['title', task.title], ['description', visibleDescription(task.description)], ['notes', task.notes || ''], ['dueDate', task.dueDate || ''], ['labels', (task.labels || []).join(', ')]]) {
    const input = document.querySelector('#quick-edit').elements.namedItem(name);
    if (changedTask || (!quickDirty.has(name) && document.activeElement !== input)) input.value = value;
  }
  for (const input of document.querySelectorAll('#quick-edit input, #quick-edit select, [form="quick-edit"]')) input.disabled = quickSaving || state.busy.has(task.id);
  status.disabled ||= ['delegating', 'completing'].includes(task.executionStatus);
  execution.disabled = quickSaving || state.busy.has(task.id) || task.status !== 'open' || ['delegating', 'running', 'completing'].includes(task.executionStatus);
}

function visibleDescription(value = '') {
  return value.replace(/\bconversation=discord:\d+\b/g, '').trim();
}

async function saveQuickEdit() {
  if (quickSaving || !state.selectedTaskId || !quickDirty.size) return;
  const id = state.selectedTaskId;
  const payload = {};
  for (const name of quickDirty) {
    const value = document.querySelector('#quick-edit').elements.namedItem(name).value;
    payload[name] = name === 'labels' ? value.split(/[,、]/).map(v => v.trim()).filter(Boolean) : value;
  }
  if ('title' in payload && !payload.title.trim()) {
    document.querySelector('#quick-save-status').textContent = 'タイトルを入力してください';
    document.querySelector('#quick-retry').hidden = false;
    return;
  }
  if ('description' in payload) {
    const references = state.detail.task.description.match(/\bconversation=discord:\d+\b/g) || [];
    if (references.length) payload.description = [payload.description, ...references].filter(Boolean).join('\n');
  }
  quickSaving = true;
  renderQuickEdit(state.detail.task);
  const status = document.querySelector('#quick-save-status');
  status.textContent = '保存中…';
  try {
    await api(`/api/tasks/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
    if (state.selectedTaskId === id) {
      quickDirty.clear();
      status.textContent = '保存しました';
      document.querySelector('#quick-retry').hidden = true;
      await loadTaskDetail();
    }
    await loadTasks();
  } catch (error) {
    if (state.selectedTaskId === id) {
      status.textContent = `保存できませんでした: ${error.message}`;
      document.querySelector('#quick-retry').hidden = false;
    }
  } finally {
    quickSaving = false;
    if (state.detail) renderQuickEdit(state.detail.task);
  }
}

async function loadTaskDetail({ quiet = false } = {}) {
  if (quiet && (dragging || moving)) return;
  if (!state.selectedTaskId) return;
  const id = state.selectedTaskId;
  if (quiet && detailLoadingId === id) return;
  detailLoadingId = id;
  const request = ++detailRequest;
  try {
    const detail = await api(`/api/tasks/${id}?history=0`);
    if (request !== detailRequest || state.selectedTaskId !== id) return;
    if (JSON.stringify(state.detail) === JSON.stringify(detail)) return;
    state.detail = detail;
    renderDetail();
  } catch (error) {
    if (request !== detailRequest || state.selectedTaskId !== id) return;
    if (state.detail) {
      state.detail = { ...state.detail, loading: false, historyError: error.message };
      renderDetail();
    }
    if (!quiet) showToast(error.message);
  } finally {
    if (request === detailRequest) detailLoadingId = null;
  }
}

async function openTask(id) {
  if (state.selectedTaskId === id && dialog.open) return;
  if (state.selectedTaskId && state.selectedTaskId !== id) {
    if (quickSaving) { showToast('保存が完了してから切り替えてください'); return; }
    await saveQuickEdit();
    if (quickDirty.size) return;
  }
  quickTaskId = null;
  state.selectedTaskId = id;
  const task = state.tasks.find((task) => task.id === id);
  state.detail = task ? { task, history: [], loading: true } : null;
  if (!dialog.open) {
    if (matchMedia('(max-width: 900px)').matches) dialog.showModal();
    else dialog.show();
  }
  render();
  document.querySelector('#detail-title').value = '';
  if (state.detail) renderDetail();
  await loadTaskDetail();
}

async function runTaskAction(id, action) {
  state.busy.add(id);
  render();
  renderDetail();
  try {
    const endpoint = ['start', 'reset'].includes(action) ? `execution/${action}` : action;
    const result = await api(`/api/tasks/${id}/${endpoint}`, { method: 'POST', body: JSON.stringify({}) });
    await loadTasks();
    if (state.selectedTaskId === id) await loadTaskDetail();
    showToast(action === 'start' ? '作業中にしました' : action === 'reset' ? '未着手に戻しました' : action === 'open' ? '未着手にしました' : action === 'dismiss' ? '候補から外しました' : action === 'close' ? (result.completionPending ? '完了依頼を受け付けました。返信終了後に完了します' : '完了にしました') : '状態を同期しました');
  } catch (error) {
    showToast(error.message);
    await loadTasks({ quiet: true });
    if (state.selectedTaskId === id) await loadTaskDetail({ quiet: true });
  } finally {
    state.busy.delete(id);
    render();
    renderDetail();
  }
}

function render() {
  if (dragging) return;
  renderCategories();
  const labelSelect = document.querySelector('#label-filter');
  const labels = [...new Set(state.tasks.flatMap(t => t.labels || []))].sort((a,b) => a.localeCompare(b, 'ja'));
  if (state.label && !labels.includes(state.label)) labels.push(state.label);
  labelSelect.replaceChildren(new Option('すべてのラベル', ''), ...labels.map(label => new Option(label, label)));
  labelSelect.value = state.label;
  document.querySelector('#task-sort').value = state.sort;
  const visible = state.tasks.filter(taskMatches);
  if (state.sort.startsWith('due-')) visible.sort((a,b) => {
    if (!a.dueDate) return b.dueDate ? 1 : 0;
    if (!b.dueDate) return -1;
    return a.dueDate.localeCompare(b.dueDate) * (state.sort === 'due-desc' ? -1 : 1);
  });
  const focused = grid.contains(document.activeElement) ? document.activeElement : null;
  const focusId = focused?.dataset.id;
  const focusAction = focused?.dataset.action;
  const focusIndex = focused ? [...grid.children].indexOf(focused.closest('.task-card')) : -1;
  grid.replaceChildren(...visible.map(renderTask));
  if (focused) {
    const same = [...grid.querySelectorAll('button')].find(button => button.dataset.id === focusId && button.dataset.action === focusAction && !button.disabled);
    const next = grid.children[Math.min(focusIndex, grid.children.length - 1)]?.querySelector('.task-open');
    (same || next || document.querySelector('.nav-item.active')).focus({ preventScroll: true });
  }
  document.querySelector('#list-options-summary').textContent = `絞り込み・並べ替え${state.label ? ` · ${state.label}` : ''}${state.sort !== 'created' ? ' · 期限順' : ''}`;
  empty.hidden = visible.length > 0;
  const counts = Object.fromEntries(['inbox', 'open', 'closed'].map(status => [status, state.tasks.filter(task => task.status === status).length]));
  counts.all = state.tasks.length;
  for (const [name, count] of Object.entries(counts)) {
    const counter = document.querySelector(`#count-${name}`);
    if (counter) counter.textContent = count;
  }
}

async function loadTasks({ quiet = false } = {}) {
  if (dragging || moving || (quiet && tasksLoading)) return;
  tasksLoading = true;
  try {
    const [taskData, collections] = await Promise.all([api('/api/tasks'), api('/api/collections')]);
    if (dragging || moving) return;
    const tasks = taskData.tasks;
    const collectionsChanged = JSON.stringify(collections) !== JSON.stringify(state.collections);
    state.collections = collections;
    if (state.category && state.category !== 'uncategorized' && !collections.categories.some(c => c.id === state.category)) state.category = '';
    if (!quiet || collectionsChanged || JSON.stringify(tasks) !== JSON.stringify(state.tasks)) {
      state.tasks = tasks;
      render();
    }
  } catch (error) {
    if (!quiet) showToast(error.message);
  } finally {
    tasksLoading = false;
  }
}

async function checkConnection() {
  const dot = document.querySelector('#status-dot');
  const label = document.querySelector('#connection-label');
  const detail = document.querySelector('#connection-detail');
  try {
    const health = await api('/api/health');
    const connected = health.xangi.connected;
    dot.className = `status-dot ${connected ? 'connected' : 'disconnected'}`;
    label.textContent = connected ? 'xangi接続済み' : 'xangiに接続できません';
    detail.textContent = connected ? `API ${health.xangi.version}` : health.xangi.error;
  } catch (error) {
    dot.className = 'status-dot disconnected';
    label.textContent = '接続確認に失敗しました';
    detail.textContent = error.message;
  }
}

const createDialog = document.querySelector('#create-dialog');
const createLauncher = document.querySelector('#open-create');
const createError = document.querySelector('#create-error');
createLauncher.addEventListener('click', () => {
  renderCategorySelects();
  document.querySelector('#task-form').categoryId.value = state.category === 'uncategorized' ? '' : state.category;
  createDialog.showModal();
  // Touch devices should open the form without summoning the software keyboard.
  if (!matchMedia('(pointer: coarse)').matches) document.querySelector('#task-title').focus();
});
document.querySelector('#close-create').addEventListener('click', () => createDialog.close());
createDialog.addEventListener('close', () => createLauncher.focus());

document.querySelector('#task-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  if (button.disabled) return;
  button.disabled = true;
  createError.hidden = true;
  try {
    await api('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ categoryId: form.categoryId.value, title: form.title.value, description: form.description.value, labels: form.labels.value.split(/[,、]/).map(s => s.trim()).filter(Boolean), dueDate: form.dueDate.value, repeat: readRepeat(form) }),
    });
    // Keep the all-category view when adding a task from it.
    if (state.category) state.category = form.categoryId.value || 'uncategorized';
    form.reset();
    updateRepeatForm(form);
    createDialog.close();
    document.querySelector('[data-filter=open]').click();
    state.label = '';
    writePreference('tasks-label', '');
    document.querySelector('#label-filter').value = '';
    await loadTasks();
    showToast('タスクを追加しました');
  } catch (error) {
    createError.textContent = error.message;
    createError.hidden = false;
    if (!createDialog.open) showToast(error.message);
  } finally {
    button.disabled = false;
  }
});

async function handleTaskAction(event) {
  const button = event.target.closest('button[data-action]');
  if (!button || button.disabled) return;
  const { action, id } = button.dataset;
  if (action === 'edit') {
    const task = state.tasks.find(t => t.id === id);
    const form = document.querySelector('#edit-form');
    form.dataset.id = id;
    form.title.value = task.title; form.description.value = task.description;
    form.labels.value = (task.labels || []).join(', '); form.dueDate.value = task.dueDate || '';
    fillRepeat(form, task.repeat);
    renderCategorySelects();
    form.categoryId.value = task.categoryId || '';
    document.querySelector('#edit-dialog').showModal();
    return;
  }
  if (action === 'delete') {
    const task = state.tasks.find((task) => task.id === id);
    if (!task || !await confirmTaskDeletion(task)) return;
    state.busy.add(id);
    render();
    try {
      await api(`/api/tasks/${id}`, { method: 'DELETE' });
      if (state.selectedTaskId === id) dialog.close();
      await loadTasks();
      showToast('削除しました');
    } catch (error) {
      showToast(error.message);
    } finally {
      state.busy.delete(id);
      render();
    }
    return;
  }
  if (action === 'delegate') { await openDelegation(id); return; }
  if (action === 'copy-link') {
    const url = new URL(location.href);
    url.search = ''; url.hash = '';
    url.searchParams.set('task', id);
    const value = url.href;
    try {
      await copyText(value);
      showToast('コピーしました。xangiに貼り付けてください');
    } catch {
      window.prompt('コピーしてxangiに貼り付けてください', value);
    }
    return;
  }
  if (action === 'show') {
    await openTask(id);
    return;
  }
  await runTaskAction(id, action);
}
grid.addEventListener('click', handleTaskAction);
document.querySelector('#detail-actions').addEventListener('click', handleTaskAction);

function closeDetail() {
  if (quickSaving || quickDirty.size) {
    if (!quickSaving) void saveQuickEdit();
    showToast('保存が完了してから閉じてください');
    return;
  }
  dialog.close();
}
document.querySelector('#close-detail').addEventListener('click', closeDetail);
dialog.addEventListener('cancel', event => { event.preventDefault(); closeDetail(); });
dialog.addEventListener('close', () => {
  if (panelResizeClosures) { panelResizeClosures--; return; }
  const opener = [...grid.querySelectorAll('.task-open')].find(button => button.dataset.id === state.selectedTaskId);
  (opener || document.querySelector('.nav-item.active')).focus({ preventScroll: true });
  state.selectedTaskId = null;
  detailRequest++;
  detailLoadingId = null;
  state.detail = null;
  render();
});

document.querySelectorAll('.nav-item').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelector('.nav-item.active')?.classList.remove('active');
    button.classList.add('active');
    state.filter = button.dataset.filter;
    try { localStorage.setItem('tasks-view', state.filter); } catch {}
    const [title] = VIEW_COPY[state.filter] || VIEW_COPY.all;
    document.querySelector('#view-title').textContent = title;
    render();
  });
});
document.querySelector('#refresh').addEventListener('click', () => loadTasks());
const themeSelect = document.querySelector('#theme-select');
function storedTheme() {
  try { const value = localStorage.getItem('xangi-theme'); return ['light', 'dark'].includes(value) ? value : 'system'; }
  catch { return 'system'; }
}
function applyTheme(value) {
  themeSelect.value = value;
  const dark = value === 'dark' || (value === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}
themeSelect.addEventListener('change', () => {
  try { localStorage.setItem('xangi-theme', themeSelect.value); } catch {}
  applyTheme(themeSelect.value);
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (themeSelect.value === 'system') applyTheme('system');
});
window.addEventListener('storage', event => {
  if (event.key === 'xangi-theme' || event.key === null) applyTheme(storedTheme());
});
applyTheme(storedTheme());
document.querySelector('#xangi-home').hidden = !/^\/api\/extensions\/[^/]+\/ui(?:\/|$)/.test(location.pathname);
document.addEventListener('keydown', (event) => {
  if (event.defaultPrevented || event.isComposing) return;
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    const form = document.querySelector(document.querySelector('#edit-dialog').open ? '#edit-form' : dialog.open ? '#quick-edit' : createDialog.open ? '#task-form' : '#open-create');
    if (form.tagName === 'FORM') {
      event.preventDefault();
      if (!form.querySelector('[type=submit]').disabled) form.requestSubmit();
    }
  }
});

async function openLinkedTask() {
  const id = new URL(location.href).searchParams.get('task');
  if (!id) return;
  try {
    const { task } = await api(`/api/tasks/${encodeURIComponent(id)}?history=0`);
    if (!state.tasks.some(item => item.id === task.id)) state.tasks.push(task);
    state.category = ''; state.label = '';
    document.querySelector('[data-filter=all]').click();
    await openTask(task.id);
  } catch (error) { showToast(`リンク先のタスクを開けません: ${error.message}`); }
}
// Restore only supported views; stale or unavailable storage defaults to Open.
try {
  const savedView = localStorage.getItem('tasks-view');
  if (Object.hasOwn(VIEW_COPY, savedView)) state.filter = savedView;
} catch {}
document.querySelectorAll('.nav-item').forEach(button => button.classList.toggle('active', button.dataset.filter === state.filter));
document.querySelector('#view-title').textContent = VIEW_COPY[state.filter][0];
void loadTasks().then(openLinkedTask);
window.addEventListener('popstate', () => { void openLinkedTask(); });
window.addEventListener('pageshow', event => { if (event.persisted) void openLinkedTask(); });
void checkConnection();
setInterval(async () => {
  await loadTasks({ quiet: true });
  if (dialog.open) await loadTaskDetail({ quiet: true });
}, 4000);

document.querySelector('#cancel-edit').addEventListener('click', () => document.querySelector('#edit-dialog').close());
document.querySelector('#edit-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('[type=submit]'); button.disabled = true;
  try {
    await api(`/api/tasks/${form.dataset.id}`, { method: 'PUT', body: JSON.stringify({
      categoryId: form.categoryId.value, title: form.title.value, description: form.description.value,
      labels: form.labels.value.split(/[,、]/).map(s => s.trim()).filter(Boolean), dueDate: form.dueDate.value, repeat: readRepeat(form),
    }) });
    document.querySelector('#edit-dialog').close();
    await loadTasks();
    if (state.selectedTaskId === form.dataset.id) await loadTaskDetail();
    showToast('保存しました');
  } catch (error) { showToast(error.message); }
  finally { button.disabled = false; }
});

function repeatLabel(rule) {
  if (rule.unit === 'weekdays') return '繰り返し: 平日';
  const labels = {day:'日', week:'週', month:'か月', year:'年'};
  const weekdays = ['日','月','火','水','木','金','土'];
  return `繰り返し: ${rule.interval}${labels[rule.unit]}ごと${rule.daysOfWeek?.length ? '（'+rule.daysOfWeek.map(d=>weekdays[d]).join('・')+'）' : ''}`;
}
function updateRepeatForm(form) {
  const preset = form.elements.repeatPreset.value;
  form.querySelector('.repeat-custom').hidden = preset !== 'custom';
  form.elements.repeatInterval.disabled = preset !== 'custom';
  form.querySelector('.repeat-weekdays').hidden = !(preset === 'week' || (preset === 'custom' && form.elements.repeatUnit.value === 'week'));
}
function readRepeat(form) {
  const preset = form.elements.repeatPreset.value;
  if (preset === 'none') return null;
  const unit = preset === 'custom' ? form.elements.repeatUnit.value : preset;
  return { unit, interval: preset === 'custom' ? Number(form.elements.repeatInterval.value) : 1,
    daysOfWeek: unit === 'week' ? [...form.querySelectorAll('[name=repeatDay]:checked')].map(el=>Number(el.value)) : [] };
}
function fillRepeat(form, rule) {
  form.elements.repeatPreset.value = !rule ? 'none' : rule.interval === 1 ? rule.unit : 'custom';
  form.elements.repeatUnit.value = rule?.unit === 'weekdays' ? 'day' : rule?.unit || 'day';
  form.elements.repeatInterval.value = rule?.interval || 1;
  form.querySelectorAll('[name=repeatDay]').forEach(el=>el.checked = (rule?.daysOfWeek || []).includes(Number(el.value)));
  updateRepeatForm(form);
}
for (const id of ['task-form', 'edit-form']) {
  const form = document.getElementById(id);
  form.elements.repeatPreset.addEventListener('change', ()=>updateRepeatForm(form));
  form.elements.repeatUnit.addEventListener('change', ()=>updateRepeatForm(form));
  updateRepeatForm(form);
}
document.querySelector('#label-filter').addEventListener('change', event => {
  state.label = event.target.value; writePreference('tasks-label', state.label); render();
});
document.querySelector('#task-sort').addEventListener('change', event => {
  state.sort = event.target.value; writePreference('tasks-sort', state.sort); render();
});

for (const input of document.querySelectorAll('#quick-edit input, #quick-category, [form="quick-edit"]')) {
  input.addEventListener('input', () => {
    quickDirty.add(input.name);
    document.querySelector('#quick-save-status').textContent = '編集中・入力欄を離れると保存します';
  });
  input.addEventListener('keydown', event => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter' && (input.tagName !== 'TEXTAREA' || event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      event.stopPropagation();
      void saveQuickEdit();
    }
  });
  input.addEventListener('change', () => { quickDirty.add(input.name); void saveQuickEdit(); });
}
document.querySelector('#quick-edit').addEventListener('submit', event => {
  event.preventDefault();
  void saveQuickEdit();
});
document.querySelector('#quick-status').addEventListener('change', async event => {
  const task = state.detail?.task;
  if (!task || event.target.value === task.status) return;
  await runTaskAction(task.id, event.target.value === 'closed' ? 'close' : 'open');
});
document.querySelector('#quick-execution').addEventListener('change', async event => {
  const task = state.detail?.task;
  if (!task || event.target.value === task.executionStatus) return;
  await runTaskAction(task.id, event.target.value === 'working' ? 'start' : 'reset');
});

function confirmTaskDeletion(task) {
  const confirmation = document.querySelector('#delete-dialog');
  if (confirmation.open) return Promise.resolve(false);
  document.querySelector('#delete-task-title').textContent = `「${task.title}」を削除しますか？`;
  confirmation.returnValue = '';
  return new Promise(resolve => {
    confirmation.addEventListener('close', () => resolve(confirmation.returnValue === 'delete'), { once: true });
    confirmation.showModal();
  });
}


document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !dragging && dialog.open && !dialog.matches(':modal') && !document.querySelector('dialog:modal')) {
    event.preventDefault(); closeDetail();
  }
});

function categoryName(category) {
  const folder = state.collections.folders.find(f => f.id === category.folderId);
  return folder ? `${folder.name} / ${category.name}` : category.name;
}
function renderCategorySelects() {
  for (const select of document.querySelectorAll('.category-select')) {
    const options = [new Option('未分類', ''), ...state.collections.categories.map(c => new Option(categoryName(c), c.id))];
    if ([...select.options].map(o => `${o.value}:${o.text}`).join('|') === options.map(o => `${o.value}:${o.text}`).join('|')) continue;
    const value = select.value;
    select.replaceChildren(...options); select.value = value;
  }
}
function renderCategories() {
  writePreference('tasks-category', state.category);
  document.querySelector('#selected-category').textContent = state.category === 'uncategorized' ? '未分類' : state.collections.categories.find(c => c.id === state.category)?.name || 'すべてのカテゴリ';
  renderCategorySelects();
  const tree = document.querySelector('#category-tree');
  const signature = JSON.stringify([state.collections, state.category]);
  if (tree.dataset.signature === signature) return;
  const expanded = new Set([...tree.querySelectorAll('details[open]')].map(d => d.dataset.id));
  const knownFolders = new Set([...tree.querySelectorAll('details')].map(d => d.dataset.id));
  tree.dataset.signature = signature;
  const choose = (name, id) => {
    const button = element('button', 'category-choice', name);
    if (id) makeDropTarget(button, 'category', id === 'uncategorized' ? '' : id);
    button.type = 'button'; button.setAttribute('aria-pressed', String(state.category === id));
    button.onclick = () => { state.category = id; render(); if (categoryMobile.matches) closeCategories(); else tree.querySelector('[aria-pressed="true"]')?.focus({ preventScroll: true }); };
    return button;
  };
  const categoryRow = c => {
    const row = element('div', 'category-row');
    const edit = element('button', 'icon-button', '…');
    edit.setAttribute('aria-label', `${c.name}を編集`); edit.onclick = () => openCollection('categories', c);
    const choice = choose(c.name, c.id);
    makeDraggable(choice, 'category', c.id);
    row.append(moveHandle('category', c.id, c.name), choice, edit); return row;
  };
  tree.replaceChildren(choose('すべてのカテゴリ', ''), choose('未分類', 'uncategorized'));
  for (const folder of state.collections.folders) {
    const group = element('details', 'category-folder'); group.dataset.id = folder.id;
    group.open = knownFolders.has(folder.id) ? expanded.has(folder.id) : !closedFolders.has(folder.id);
    group.ontoggle = () => {
      if (!group.isConnected) return;
      closedFolders = new Set([...tree.querySelectorAll('details:not([open])')].map(item => item.dataset.id));
      writePreference('tasks-closed-folders', JSON.stringify([...closedFolders]));
    };
    const summary = element('summary');
    summary.append(element('span', 'category-folder-name', folder.name));
    makeDropTarget(summary, 'folder', folder.id);
    const edit = element('button', 'icon-button', '…'); edit.setAttribute('aria-label', `${folder.name}フォルダを編集`);
    edit.onclick = event => { event.preventDefault(); openCollection('folders', folder); };
    summary.append(edit); group.append(summary);
    group.append(...state.collections.categories.filter(c => c.folderId === folder.id).map(categoryRow));
    tree.append(group);
  }
  const outside = element('div', 'category-root-drop', 'フォルダの外へ移動');
  makeDropTarget(outside, 'folder', '');
  tree.append(outside, ...state.collections.categories.filter(c => !c.folderId).map(categoryRow));
}
function openCollection(kind, item = null) {
  const form = document.querySelector('#collection-form');
  form.dataset.kind = kind; form.dataset.id = item?.id || '';
  form.elements.name.value = item?.name || '';
  form.folderId.replaceChildren(new Option('フォルダなし', ''), ...state.collections.folders.map(f => new Option(f.name, f.id)));
  form.folderId.value = item?.folderId || '';
  document.querySelector('#collection-folder-label').hidden = kind === 'folders';
  document.querySelector('#collection-heading').textContent = `${kind === 'folders' ? 'フォルダ' : 'カテゴリ'}を${item ? '編集' : '追加'}`;
  document.querySelector('#delete-collection').hidden = !item;
  document.querySelector('#collection-error').hidden = true;
  document.querySelector('#collection-dialog').showModal(); form.elements.name.focus();
}
document.querySelector('#add-category').onclick = () => openCollection('categories');
document.querySelector('#add-folder').onclick = () => openCollection('folders');
document.querySelector('#close-collection').onclick = () => document.querySelector('#collection-dialog').close();
async function changeCollection(remove = false) {
  const form = document.querySelector('#collection-form');
  const buttons = [...form.querySelectorAll('button')];
  if (buttons.some(b => b.disabled)) return;
  buttons.forEach(b => b.disabled = true);
  try {
    const { kind, id } = form.dataset;
    await api(`/api/${kind}${id ? `/${id}` : ''}`, {
      method: remove ? 'DELETE' : id ? 'PUT' : 'POST',
      ...(remove ? {} : { body: JSON.stringify({ name: form.elements.name.value, folderId: form.folderId.value }) }),
    });
    document.querySelector('#collection-dialog').close(); await loadTasks();
    showToast(remove ? '分類を削除しました' : '分類を保存しました');
  } catch (error) {
    const output = document.querySelector('#collection-error'); output.textContent = error.message; output.hidden = false;
  } finally { buttons.forEach(b => b.disabled = false); }
}
document.querySelector('#collection-form').onsubmit = event => { event.preventDefault(); void changeCollection(); };
document.querySelector('#delete-collection').onclick = () => changeCollection(true);

// Re-enter the native dialog when crossing the mobile breakpoint, preserving edits.
let panelResizeClosures = 0;
matchMedia('(max-width: 900px)').addEventListener('change', event => {
  if (!dialog.open) return;
  const focused = document.activeElement;
  panelResizeClosures++;
  dialog.close();
  if (event.matches) dialog.showModal(); else dialog.show();
  if (dialog.contains(focused)) focused.focus({ preventScroll: true });
});


const categoryMobile = matchMedia('(max-width: 900px)');
const categorySidebar = document.querySelector('#category-sidebar');
const categoryToggle = document.querySelector('#open-categories');
let categoriesOpenedForDrag = false;
function openCategories(forDrag = false) {
  if (!categoryMobile.matches) return;
  categoriesOpenedForDrag = forDrag;
  document.body.classList.add('categories-open');
  categoryToggle.setAttribute('aria-expanded', 'true');
  document.querySelector('#category-backdrop').hidden = false;
  if (!forDrag) {
    categorySidebar.setAttribute('role', 'dialog');
    categorySidebar.setAttribute('aria-modal', 'true');
    for (const node of document.querySelectorAll('.app-topbar, .workspace, .create-launcher')) node.inert = true;
    document.querySelector('#close-categories').focus();
  }
}
function closeCategories(restoreFocus = true) {
  const wasOpen = document.body.classList.contains('categories-open');
  document.body.classList.remove('categories-open');
  categoryToggle.setAttribute('aria-expanded', 'false');
  document.querySelector('#category-backdrop').hidden = true;
  categorySidebar.removeAttribute('role');
  categorySidebar.removeAttribute('aria-modal');
  for (const node of document.querySelectorAll('.app-topbar, .workspace, .create-launcher')) node.inert = false;
  categoriesOpenedForDrag = false;
  if (wasOpen && restoreFocus && categoryMobile.matches) categoryToggle.focus({ preventScroll: true });
}
categoryToggle.onclick = () => openCategories();
document.querySelector('#close-categories').onclick = () => closeCategories();
document.querySelector('#category-backdrop').onclick = () => closeCategories();
categoryMobile.addEventListener('change', () => closeCategories(false));
document.addEventListener('keydown', event => {
  if (!document.body.classList.contains('categories-open') || document.querySelector('dialog:modal') || dragging) return;
  if (event.key === 'Escape') { event.preventDefault(); closeCategories(); }
  if (event.key === 'Tab') {
    const buttons = [...categorySidebar.querySelectorAll('button, summary')].filter(node => !node.disabled && node.getClientRects().length);
    const first = buttons[0], last = buttons.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
});

function startMove(kind, id) {
  if (moving || quickSaving || quickDirty.size || state.busy.has(id)) {
    showToast('編集の保存が完了してから移動してください'); return false;
  }
  dragging = { kind, id };
  document.body.dataset.dragKind = kind;
  if (kind === 'task') openCategories(true);
  return true;
}
function clearMove() {
  if (categoriesOpenedForDrag) closeCategories(false);
  dragging = null;
  delete document.body.dataset.dragKind;
  document.querySelectorAll('.drop-active, .drag-source').forEach(n => n.classList.remove('drop-active', 'drag-source'));
}
function acceptsMove(target) {
  return dragging && !moving && target && target.dataset.dropKind === (dragging.kind === 'task' ? 'category' : 'folder');
}
function hoverMove(target) {
  document.querySelectorAll('.drop-active').forEach(n => n.classList.remove('drop-active'));
  // Reveal categories when a task is held over a closed folder, without assigning to the folder itself.
  if (dragging?.kind === 'task' && target?.dataset.dropKind === 'folder') target.closest('details')?.setAttribute('open', '');
  if (acceptsMove(target)) target.classList.add('drop-active');
}
function makeDraggable(node, kind, id) {
  node.draggable = true;
  node.dataset.moveKind = kind; node.dataset.moveId = id;
  node.addEventListener('dragstart', event => {
    if (!startMove(kind, id)) { event.preventDefault(); return; }
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('application/x-xangi-tasks', JSON.stringify(dragging));
    node.classList.add('drag-source');
  });
  node.addEventListener('dragend', clearMove);
}
function makeDropTarget(node, kind, id) {
  node.dataset.dropKind = kind; node.dataset.dropId = id;
  node.addEventListener('dragover', event => {
    hoverMove(node);
    if (!acceptsMove(node)) return;
    event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move';
  });
  node.addEventListener('dragleave', event => {
    if (!node.contains(event.relatedTarget)) node.classList.remove('drop-active');
  });
  node.addEventListener('drop', event => {
    if (!acceptsMove(node)) return;
    event.preventDefault(); event.stopPropagation();
    const source = dragging; clearMove(); void applyMove(source, kind, id);
  });
}
async function applyMove(source, kind, id) {
  if (!source || moving || quickSaving || quickDirty.size) return;
  const taskMove = source.kind === 'task' && kind === 'category';
  if (!taskMove && !(source.kind === 'category' && kind === 'folder')) return;
  const item = taskMove ? state.tasks.find(t => t.id === source.id) : state.collections.categories.find(c => c.id === source.id);
  if (!item || (taskMove ? item.categoryId || '' : item.folderId || '') === id) return;
  moving = true;
  if (taskMove) state.busy.add(source.id);
  if (state.detail) renderQuickEdit(state.detail.task);
  let saved = false;
  try {
    await api(`/api/${taskMove ? 'tasks' : 'categories'}/${source.id}`, {
      method: 'PUT', body: JSON.stringify(taskMove ? { categoryId: id } : { folderId: id }),
    });
    saved = true;
    showToast(taskMove ? 'タスクのカテゴリを変更しました' : 'カテゴリを移動しました');
  } catch (error) { showToast(`移動できませんでした: ${error.message}`); }
  finally {
    moving = false;
    if (taskMove) state.busy.delete(source.id);
    // Reload even after failure: a network error may occur after the server saved the change.
    await loadTasks();
    if (saved && taskMove && state.selectedTaskId === source.id) await loadTaskDetail();
    if (state.detail) renderQuickEdit(state.detail.task);
  }
}
function moveHandle(kind, id, name) {
  const handle = element('button', 'move-handle', '⠿');
  handle.type = 'button'; handle.setAttribute('aria-label', `${name}の移動`);
  handle.title = kind === 'task' ? 'ドラッグでカテゴリへ移動。クリックでカテゴリを選択' : 'ドラッグでフォルダへ移動。クリックでフォルダを選択';
  let pointer = null, frame = null, suppressClick = false;
  const targetAt = () => document.elementFromPoint(pointer.x, pointer.y)?.closest('[data-drop-kind]');
  const scroll = () => {
    if (!pointer?.started) return;
    const sidebar = document.elementFromPoint(pointer.x, pointer.y)?.closest('.category-sidebar');
    const box = sidebar?.getBoundingClientRect();
    const top = box ? Math.max(0, box.top) : 0;
    const bottom = box ? Math.min(innerHeight, box.bottom) : innerHeight;
    const dy = pointer.y < top + 36 ? -10 : pointer.y > bottom - 36 ? 10 : 0;
    // Keep an accepted target still under the finger while the user releases it.
    if (dy && !acceptsMove(targetAt())) { if (sidebar && sidebar.scrollHeight > sidebar.clientHeight) sidebar.scrollTop += dy; else window.scrollBy(0, dy); }
    hoverMove(targetAt()); frame = requestAnimationFrame(scroll);
  };
  const finish = (cancelled = false) => {
    if (!pointer) return;
    const current = pointer;
    const target = current.started ? targetAt() : null;
    const source = dragging;
    const valid = current.started && !cancelled && acceptsMove(target);
    pointer = null; cancelAnimationFrame(frame);
    if (handle.hasPointerCapture(current.id)) handle.releasePointerCapture(current.id);
    if (current.started) {
      suppressClick = true;
      clearMove();
      if (valid) void applyMove(source, target.dataset.dropKind, target.dataset.dropId);
    }
    document.removeEventListener('keydown', escape);
  };
  const escape = event => { if (event.key === 'Escape') { event.preventDefault(); finish(true); } };
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !event.isPrimary || moving) return;
    suppressClick = false;
    pointer = { id: event.pointerId, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, started: false };
    handle.setPointerCapture(event.pointerId);
    document.addEventListener('keydown', escape);
  });
  handle.addEventListener('pointermove', event => {
    if (!pointer || pointer.id !== event.pointerId) return;
    pointer.x = event.clientX; pointer.y = event.clientY;
    if (!pointer.started && Math.hypot(pointer.x - pointer.startX, pointer.y - pointer.startY) >= 7) {
      if (!startMove(kind, id)) { finish(true); return; }
      pointer.started = true; handle.classList.add('drag-source'); scroll();
    }
    if (pointer.started) { event.preventDefault(); hoverMove(targetAt()); }
  });
  handle.addEventListener('pointerup', () => finish());
  handle.addEventListener('pointercancel', () => finish(true));
  handle.addEventListener('lostpointercapture', () => finish(true));
  handle.addEventListener('click', async event => {
    event.stopPropagation();
    if (suppressClick && event.detail !== 0) { suppressClick = false; return; }
    if (moving) return;
    if (kind === 'task') { await openTask(id); if (state.selectedTaskId === id) document.querySelector('#quick-category').focus(); }
    else { const category = state.collections.categories.find(c => c.id === id); if (category) { openCollection('categories', category); document.querySelector('#collection-form').folderId.focus(); } }
  });
  return handle;
}


const delegateDialog = document.querySelector('#delegate-dialog');
const delegateForm = document.querySelector('#delegate-form');
const defaultAgentButton = document.querySelector('#save-default-agent');
let delegationRequest = 0;
let submittingDelegation = false;
function delegationError(message) {
  const box = document.querySelector('#delegate-error');
  box.textContent = message; box.hidden = !message;
}
async function openDelegation(id) {
  if (state.busy.has(id)) return;
  if (state.selectedTaskId === id) {
    if (quickSaving) { showToast('保存が完了してから依頼してください'); return; }
    await saveQuickEdit();
    if (quickDirty.size) return;
  }
  const task = state.detail?.task.id === id ? state.detail.task : state.tasks.find(task => task.id === id);
  if (!task) return;
  const request = ++delegationRequest;
  delegateForm.dataset.id = id;
  delegateForm.elements.instructions.value = task.delegationInstructions || '';
  document.querySelector('#delegate-task-title').textContent = task.title;
  delegationError('');
  const select = delegateForm.elements.agentId;
  const submit = delegateForm.querySelector('[type=submit]');
  select.replaceChildren(new Option('読み込み中…', ''));
  delegateForm.elements.projectId.replaceChildren(new Option('読み込み中…', ''));
  delegateForm.elements.projectId.disabled = true;
  select.disabled = submit.disabled = defaultAgentButton.disabled = true;
  document.querySelector('#delegate-agent-hint').textContent = 'エージェントを確認しています…';
  delegateDialog.showModal();
  try {
    const [{ agents }, { projects }, settings] = await Promise.all([api('/api/agents'), api('/api/projects'), api('/api/settings')]);
    if (request !== delegationRequest || !delegateDialog.open) return;
    const projectSelect = delegateForm.elements.projectId;
    projectSelect.replaceChildren(new Option('Projectなし（Webのみ）', ''), ...projects.map(p => new Option(`${p.name}${p.channel ? ` · ${p.channel.platform}` : ''}`, p.id)));
    const selectedProject = task.projectId ?? settings.projectId ?? '';
    if (selectedProject && !projects.some(p => p.id === selectedProject)) {
      const missing = new Option('以前のProject（利用できません）', selectedProject); missing.disabled = true; projectSelect.add(missing);
    }
    projectSelect.value = selectedProject; projectSelect.disabled = false;
    projectSelect.onchange = () => {
      const project = projects.find(p => p.id === projectSelect.value);
      select.disabled = Boolean(projectSelect.value);
      submit.disabled = defaultAgentButton.disabled = submittingDelegation || Boolean(projectSelect.selectedOptions[0]?.disabled) || (!projectSelect.value && Boolean(select.selectedOptions[0]?.disabled));
      document.querySelector('#delegate-project-hint').textContent = project?.channel ? `${project.channel.platform}の設定済みチャンネルに投稿して依頼します。担当はProjectの設定を使います。` : project ? 'Projectの担当設定でWeb会話を作ります。' : '下のエージェントでWeb会話を作ります。';
    };
    select.replaceChildren(new Option('xangiの既定設定', ''), ...agents.map(agent => new Option(`${agent.name}${agent.model ? ` · ${agent.model}` : ''}`, agent.id)));
    const selected = task.agentId || settings.agentId;
    if (selected && !agents.some(agent => agent.id === selected)) {
      const missing = new Option('以前のエージェント（利用できません）', selected); missing.disabled = true; select.add(missing);
    }
    select.value = selected;
    select.disabled = false;
    submit.disabled = defaultAgentButton.disabled = Boolean(select.selectedOptions[0]?.disabled);
    projectSelect.onchange();
    document.querySelector('#delegate-agent-hint').textContent = 'エージェントの指示・モデル・作業場所で実行します。既定設定は他の端末にも適用されます。';
  } catch (error) {
    if (request !== delegationRequest || !delegateDialog.open) return;
    delegationError(`読み込みに失敗しました: ${error.message}。閉じて開き直してください。`);
  }
}
delegateForm.elements.agentId.addEventListener('change', () => {
  delegateForm.querySelector('[type=submit]').disabled = defaultAgentButton.disabled = submittingDelegation;
});
defaultAgentButton.addEventListener('click', async () => {
  defaultAgentButton.disabled = true;
  try {
    await api('/api/settings', { method: 'PUT', body: JSON.stringify({ agentId: delegateForm.elements.projectId.value ? '' : delegateForm.elements.agentId.value, projectId: delegateForm.elements.projectId.value }) });
    showToast('既定の依頼先を保存しました');
  } catch (error) { delegationError(error.message); }
  finally { defaultAgentButton.disabled = submittingDelegation; }
});
function closeDelegation() { if (!submittingDelegation) { delegationRequest++; delegateDialog.close(); } }
document.querySelector('#close-delegate').addEventListener('click', closeDelegation);
delegateDialog.addEventListener('cancel', event => { event.preventDefault(); closeDelegation(); });
delegateForm.addEventListener('submit', async event => {
  event.preventDefault();
  const id = delegateForm.dataset.id;
  if (submittingDelegation || state.busy.has(id) || delegateForm.querySelector('[type=submit]').disabled) return;
  submittingDelegation = true; state.busy.add(id); delegationError('');
  delegateForm.querySelector('[type=submit]').disabled = defaultAgentButton.disabled = true;
  try {
    const accepted = await api(`/api/tasks/${id}/delegate`, { method: 'POST', body: JSON.stringify({ agentId: delegateForm.elements.agentId.value, projectId: delegateForm.elements.projectId.value, instructions: delegateForm.elements.instructions.value }) });
    delegateDialog.close();
    const conversation = conversationUrl(accepted.task, accepted.xangiOrigin);
    if (conversation) { location.assign(conversation.href); return; }
    document.querySelector('[data-filter=open]').click();
    await loadTasks(); await loadTaskDetail();
    showToast('xangiへ依頼しました');
  } catch (error) {
    delegationError(error.message);
    await loadTasks({ quiet: true }); await loadTaskDetail({ quiet: true });
  } finally {
    submittingDelegation = false; state.busy.delete(id);
    delegateForm.querySelector('[type=submit]').disabled = defaultAgentButton.disabled = false;
    render(); renderDetail();
  }
});


const notionPanel = document.querySelector('#notion-panel');
let notionSaving = false;
let notionTaskId = null;
function renderNotion(task) {
  if (notionTaskId !== task.id) {
    notionTaskId = task.id;
    document.querySelector('#notion-page').value = '';
    document.querySelector('#notion-file').value = '';
    document.querySelector('#notion-status').textContent = '';
  }
  const link = document.querySelector('#notion-link');
  link.hidden = !task.notionPageId;
  link.href = /^[a-f0-9-]{32,36}$/i.test(task.notionPageId || '') ? `https://www.notion.so/${task.notionPageId.replaceAll('-', '')}` : '#';
  document.querySelector('#notion-setup').hidden = !!task.notionPageId;
  document.querySelector('#notion-saves').hidden = !task.notionPageId;
  for (const input of notionPanel.querySelectorAll('button,input')) input.disabled = notionSaving;
}
notionPanel.addEventListener('click', async event => {
  const action = event.target.closest('[data-notion]')?.dataset.notion;
  if (!action || notionSaving || !state.detail) return;
  if (action === 'settings') { await openSettings(); return; }
  const task = state.detail.task;
  const id = task.id;
  let path = `/api/tasks/${encodeURIComponent(id)}/notion`;
  let options = { method: action === 'link' ? 'PUT' : 'POST' };
  if (action === 'create') { options.body = '{}'; }
  else if (action === 'link') {
    const value = document.querySelector('#notion-page').value.trim();
    if (!value) { document.querySelector('#notion-page').focus(); return; }
    options.body = JSON.stringify({ page: value });
  } else if (action === 'file') {
    const file = document.querySelector('#notion-file').files[0];
    if (!file || !file.size || file.size > 20 * 1024 * 1024) { showToast('空でない20 MiB以下のファイルを選んでください'); return; }
    path += `/files?name=${encodeURIComponent(file.name)}`;
    options.body = file; options.headers = { 'Content-Type': file.type || 'application/octet-stream' };
  } else return;
  notionSaving = true; renderNotion(task);
  document.querySelector('#notion-status').textContent = 'Notionへ保存しています…';
  try {
    if (quickDirty.size) await saveQuickEdit();
    if (quickDirty.size || quickSaving) throw new Error('タスクの変更を保存してから再操作してください');
    await api(path, options);
    await loadTasks();
    if (state.selectedTaskId === id) {
      state.detail = await api(`/api/tasks/${encodeURIComponent(id)}?history=0`);
      renderDetail();
      document.querySelector('#notion-status').textContent = 'Notionに保存しました';
      document.querySelector('#notion-file').value = '';
    }
    showToast('Notionに保存しました');
  } catch (error) {
    if (state.selectedTaskId === id) document.querySelector('#notion-status').textContent = error.message;
    showToast(error.message);
  } finally { notionSaving = false; if (state.detail) renderNotion(state.detail.task); }
});


const settingsDialog = document.querySelector('#settings-dialog');
const settingsForm = document.querySelector('#settings-form');
let settingsSaving = false;

async function openSettings() {
  if (settingsDialog.open) return;
  const input = document.querySelector('#notion-parent');
  const status = document.querySelector('#settings-status');
  clearImport(); document.querySelector('#transfer-status').textContent = '';
  input.value = ''; status.textContent = '設定を読み込んでいます…';
  input.disabled = true; settingsForm.querySelector('[type=submit]').disabled = true;
  settingsDialog.showModal();
  try {
    const settings = await api('/api/settings');
    input.value = settings.notionParentPageId ? `https://www.notion.so/${settings.notionParentPageId}` : '';
    input.disabled = false; settingsForm.querySelector('[type=submit]').disabled = false;
    status.textContent = '';
  } catch (error) { status.textContent = error.message; }
}
document.querySelector('#open-settings').addEventListener('click', openSettings);
document.querySelector('#close-settings').addEventListener('click', () => { if (!settingsSaving) settingsDialog.close(); });
settingsDialog.addEventListener('cancel', event => { if (settingsSaving) event.preventDefault(); });
settingsForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (settingsSaving || document.querySelector('#notion-parent').disabled) return;
  settingsSaving = true;
  const status = document.querySelector('#settings-status');
  const button = settingsForm.querySelector('[type=submit]'); button.disabled = true;
  document.querySelector('#close-settings').disabled = true;
  status.textContent = '保存しています…';
  try {
    await api('/api/settings/notion', { method: 'PUT', body: JSON.stringify({ parent: document.querySelector('#notion-parent').value.trim() }) });
    settingsDialog.close(); showToast('設定を保存しました');
  } catch (error) { status.textContent = error.message; }
  finally { settingsSaving = false; button.disabled = false; document.querySelector('#close-settings').disabled = false; }
});

let pendingImport = null;
const importConfirm = document.querySelector('#import-confirm');
const transferStatus = document.querySelector('#transfer-status');
function clearImport() { pendingImport = null; importConfirm.hidden = true; }
document.querySelector('#import-file').addEventListener('change', () => { clearImport(); transferStatus.textContent = ''; });
async function transfer(action) {
  if (settingsSaving) return;
  settingsSaving = true;
  const controls = [...settingsForm.querySelectorAll('button,input')];
  const disabled = controls.map(control => control.disabled);
  for (const control of controls) control.disabled = true;
  try { await action(); }
  catch (error) { clearImport(); transferStatus.textContent = error.message; }
  finally { settingsSaving = false; controls.forEach((control, i) => { control.disabled = disabled[i]; }); }
}
document.querySelector('#export-all').addEventListener('click', () => transfer(async () => {
  transferStatus.textContent = 'Exportしています…';
  if (quickDirty.size) await saveQuickEdit();
  if (quickDirty.size || quickSaving) throw new Error('タスクの変更を保存してからExportしてください');
  const backup = await api('/api/export');
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = `xangi-tasks-${Date.now()}.json`;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  transferStatus.textContent = `${backup.tasks.length}件のタスクを含むJSONをダウンロードしました`;
}));
document.querySelector('#import-preview').addEventListener('click', () => transfer(async () => {
  clearImport();
  const file = document.querySelector('#import-file').files[0];
  if (!file || !file.size || file.size > 20 * 1024 * 1024) throw new Error('空でない20 MiB以下のJSONファイルを選んでください');
  if (quickDirty.size || quickSaving) throw new Error('編集中のタスクを保存してからImportしてください');
  let backup;
  try { backup = JSON.parse(await file.text()); } catch { throw new Error('JSONファイルを読み込めません'); }
  const preview = await api('/api/import/preview', { method: 'POST', body: JSON.stringify({ backup }) });
  pendingImport = { backup, token: preview.token };
  transferStatus.textContent = `現在の${preview.currentTasks}件のタスクと全分類・設定を、ファイル内の${preview.tasks}件のタスク・${preview.categories}件のカテゴリ・${preview.folders}件のフォルダで置き換えます。実行中の${preview.running}件は要確認に変わり、自動実行しません。置換前のデータはサーバーに退避します。`;
  importConfirm.hidden = false;
}));
importConfirm.addEventListener('click', () => transfer(async () => {
  if (!pendingImport) return;
  const result = await api('/api/import', { method: 'POST', body: JSON.stringify(pendingImport) });
  clearImport();
  state.selectedTaskId = null; state.detail = null; state.category = ''; state.label = ''; state.filter = 'all';
  quickDirty.clear(); writePreference('tasks-label', '');
  writePreference('tasks-view', state.filter);
  writePreference('tasks-category', state.category);
  transferStatus.textContent = `${result.tasks}件のタスクをImportしました。画面を再読み込みします`;
  const url = new URL(location.href); url.searchParams.delete('task'); location.assign(url.href);
}));
