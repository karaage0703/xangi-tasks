import { taskPhase, phaseFields, validateTaskState } from '../public/task-state.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { normalizeRepeat, nextDueDate, todayJst } from './recurrence.js';

const TASK_TYPE_VALUES = new Set(['action', 'waiting', 'hold']);

export function editableFields(input, current = {}) {
  if (Object.hasOwn(input, 'labels')) throw new Error('Unsupported field: labels');
  const title = String(input.title ?? current.title ?? '').trim();
  if (!title || title.length > 160) throw new Error('タイトルは1〜160文字で入力してください');
  const description = String(input.description ?? current.description ?? '');
  if (description.length > 4000) throw new Error('背景・完了条件は4000文字以内です');
  const notes = input.notes ?? current.notes ?? '';
  if (typeof notes !== 'string' || notes.length > 10000) throw new Error('メモは10000文字以内のテキストで入力してください');
  const dueDate = input.dueDate ?? current.dueDate ?? '';
  if (typeof dueDate !== 'string' || (dueDate && (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || !Number.isFinite(Date.parse(dueDate)) || new Date(dueDate).toISOString().slice(0,10) !== dueDate))) throw new Error('期限は有効な日付を指定してください');
  const categoryId = input.categoryId ?? current.categoryId ?? '';
  if (typeof categoryId !== 'string' || categoryId.length > 100) throw new Error('カテゴリが無効です');
  const repeat = normalizeRepeat(input.repeat === undefined ? current.repeat : input.repeat);
  return { title, description, notes, categoryId, dueDate: dueDate || (repeat ? todayJst() : ''), repeat };
}

function clone(value) {
  return structuredClone(value);
}

export function validateBackup(input) {
  const fail = () => { throw new Error('Exportファイルの形式・ID・参照関係が不正です'); };
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  if (!object(input) || input.format !== 'xangi-tasks-backup' || input.version !== 2 ||
      !Array.isArray(input.tasks) || !object(input.collections) || !object(input.settings)) fail();
  const result = clone(input);
  const ids = items => {
    if (!Array.isArray(items)) fail();
    const seen = new Set();
    for (const item of items) {
      if (!object(item) || typeof item.id !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(item.id) || seen.has(item.id)) fail();
      seen.add(item.id);
    }
    return seen;
  };
  const folders = ids(result.collections.folders), categories = ids(result.collections.categories);
  ids(result.tasks);
  for (const item of [...result.collections.folders, ...result.collections.categories]) {
    if (typeof item.name !== 'string' || !item.name.trim() || item.name.length > 80) fail();
  }
  for (const category of result.collections.categories) if (category.folderId && !folders.has(category.folderId)) fail();
  for (const task of result.tasks) {
    try { validateTaskState(task); } catch { fail(); }
    if (task.deletedAt || Object.hasOwn(task, 'labels')) fail();
    for (const key of ['title', 'description', 'notes', 'result', 'error', 'agentId', 'projectId', 'conversationAgentId', 'conversationProjectId', 'delegationInstructions', 'titleSyncError', 'dueRaw', 'repeatAnchor']) {
      if (task[key] !== undefined && typeof task[key] !== 'string') fail();
    }
    for (const key of ['createdAt', 'updatedAt']) if (typeof task[key] !== 'string' || !Number.isFinite(Date.parse(task[key]))) fail();
    if (task.categoryId && !categories.has(task.categoryId)) fail();
    if (task.type !== undefined && !TASK_TYPE_VALUES.has(task.type)) fail();
    if (task.source !== undefined) {
      if (!object(task.source) || Object.values(task.source).some(v => typeof v !== 'string')) fail();
      if (task.source.url && !/^https?:\/\//i.test(task.source.url)) fail();
    }
    if (task.xangiSessionId != null && (typeof task.xangiSessionId !== 'string' || task.xangiSessionId.length > 200)) fail();
    if (task.notionPageId && (typeof task.notionPageId !== 'string' || !/^[a-f0-9]{32}$/i.test(task.notionPageId))) fail();
    for (const key of ['conversationMode', 'notionCreating']) if (task[key] !== undefined && typeof task[key] !== 'boolean') fail();
    Object.assign(task, editableFields(task));
    // Restore data, never restart an old agent run or auto-complete a task.
    if (['delegating', 'running', 'completing'].includes(taskPhase(task))) {
      Object.assign(task, phaseFields('review')); task.error = 'Importした実行中タスクです。会話の結果を確認してください';
      delete task.completionOriginPhase;
    }
  }
  const settings = result.settings;
  for (const key of Object.keys(settings)) if (!['agentId', 'projectId', 'notionParentPageId'].includes(key)) fail();
  for (const key of ['agentId', 'projectId']) if (typeof settings[key] !== 'string' || settings[key].length > 200) fail();
  if (settings.notionParentPageId !== undefined && (typeof settings.notionParentPageId !== 'string' || !/^(?:[a-f0-9]{32})?$/.test(settings.notionParentPageId))) fail();
  return { format: result.format, version: 2, tasks: result.tasks, collections: result.collections, settings };
}

export class TaskStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.tasks = [];
    this.collections = { folders: [], categories: [] };
    this.settings = { agentId: '', projectId: '' };
    this.writeQueue = Promise.resolve();
    this.importPending = false;
  }

  async init() {
    await mkdir(dirname(this.filePath), { recursive: true });
    let pending;
    try { pending = JSON.parse(await readFile(`${this.filePath}.import.json`, 'utf8')); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    if (pending) {
      this.#useSnapshot(validateBackup(pending)); this.importPending = true;
      await this.#finishImport();
    }
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8'));
      if (!Array.isArray(parsed)) throw new Error('Task data must be an array');
      this.tasks = parsed.map(task => {
        if (Object.hasOwn(task, 'labels')) throw new Error('Remove labels from stored data before starting');
        return validateTaskState(task);
      });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      await this.#persist();
    }
    try {
      const settings = JSON.parse(await readFile(`${this.filePath}.settings.json`, 'utf8'));
      if (typeof settings.agentId !== 'string' || settings.agentId.length > 200) throw new Error('Invalid agent settings');
      if (settings.projectId !== undefined && (typeof settings.projectId !== 'string' || settings.projectId.length > 200)) throw new Error('Invalid project settings');
      if (settings.notionParentPageId !== undefined && (typeof settings.notionParentPageId !== 'string' || !/^(?:[a-f0-9]{32})?$/.test(settings.notionParentPageId))) throw new Error('Invalid Notion settings');
      this.settings = { agentId: settings.agentId, projectId: settings.projectId || '', ...(settings.notionParentPageId !== undefined ? { notionParentPageId: settings.notionParentPageId } : {}) };
    } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    try {
      const data = JSON.parse(await readFile(`${this.filePath}.collections.json`, 'utf8'));
      if (!Array.isArray(data.folders) || !Array.isArray(data.categories)) throw new Error('Invalid collections data');
      this.collections = data;
    } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }

  settingsGet() { return clone(this.settings); }

  async saveSettings(patch) {
    const operation = this.writeQueue.then(async () => {
      await this.#finishImport();
      const next = { ...this.settings };
      for (const key of ['agentId', 'projectId', 'notionParentPageId']) if (patch[key] !== undefined) next[key] = patch[key];
      if (typeof next.agentId !== 'string' || next.agentId.length > 200) throw new Error('エージェントの指定が不正です');
      if (typeof next.projectId !== 'string' || next.projectId.length > 200) throw new Error('Projectの指定が不正です');
      if (next.notionParentPageId !== undefined && (typeof next.notionParentPageId !== 'string' || !/^(?:[a-f0-9]{32})?$/.test(next.notionParentPageId))) throw new Error('Notionの親ページ指定が不正です');
      const file = `${this.filePath}.settings.json`;
      await writeFile(`${file}.tmp`, JSON.stringify(next) + '\n', { mode: 0o600 });
      await rename(`${file}.tmp`, file);
      this.settings = next;
      return clone(next);
    });
    this.writeQueue = operation.catch(() => {});
    return operation;
  }

  async backupSnapshot() {
    await this.writeQueue;
    return { format: 'xangi-tasks-backup', version: 2, savedAt: new Date().toISOString(),
      tasks: this.list(), collections: this.collectionsList(), settings: this.settingsGet() };
  }

  #useSnapshot(snapshot) {
    this.tasks = snapshot.tasks; this.collections = snapshot.collections; this.settings = snapshot.settings;
  }

  #importToken(snapshot) {
    return createHash('sha256').update(JSON.stringify([snapshot, this.tasks, this.collections, this.settings])).digest('hex');
  }

  async previewImport(input) {
    await this.writeQueue;
    const snapshot = validateBackup(input);
    return { token: this.#importToken(snapshot), tasks: snapshot.tasks.length,
      categories: snapshot.collections.categories.length, folders: snapshot.collections.folders.length,
      currentTasks: this.list().length, running: input.tasks.filter(t => ['delegating', 'running', 'completing'].includes(taskPhase(t))).length };
  }

  async importSnapshot(input, token) {
    const snapshot = validateBackup(input);
    const operation = this.writeQueue.then(async () => {
      await this.#finishImport();
      if (!token || token !== this.#importToken(snapshot)) throw new Error('確認後にデータが変更されました。Importを確認し直してください');
      if (this.tasks.some(t => !t.deletedAt && ['delegating', 'running', 'completing'].includes(taskPhase(t)))) throw new Error('実行中のタスクがあるためImportできません');
      const backupFile = `${this.filePath}.before-import-${randomUUID()}.json`;
      await writeFile(backupFile, JSON.stringify({ format: 'xangi-tasks-backup', version: 2, savedAt: new Date().toISOString(), tasks: this.list(), collections: this.collections, settings: this.settings }), { mode: 0o600, flag: 'wx' });
      const journal = `${this.filePath}.import.json`;
      await writeFile(`${journal}.tmp`, JSON.stringify(snapshot), { mode: 0o600 });
      // One atomic commit point; startup completes all three files after a crash.
      await rename(`${journal}.tmp`, journal);
      this.#useSnapshot(snapshot); this.importPending = true;
      await this.#finishImport();
      return { tasks: this.tasks.length, categories: this.collections.categories.length, folders: this.collections.folders.length };
    });
    this.writeQueue = operation.catch(() => {});
    return operation;
  }

  async #finishImport() {
    if (!this.importPending) return;
    for (const [file, value] of [[this.filePath, this.tasks], [`${this.filePath}.collections.json`, this.collections], [`${this.filePath}.settings.json`, this.settings]]) {
      await writeFile(`${file}.import-tmp`, JSON.stringify(value) + '\n', { mode: 0o600 });
      await rename(`${file}.import-tmp`, file);
    }
    await rm(`${this.filePath}.import.json`);
    this.importPending = false;
  }

  collectionsList() { return clone(this.collections); }

  validateCategory(id) {
    if (id && !this.collections.categories.some(item => item.id === id)) throw new Error('カテゴリが見つかりません');
  }

  async saveCollection(kind, input, id = null) {
    if (!['folders', 'categories'].includes(kind)) throw new Error('分類の種類が無効です');
    let result;
    await this.#mutate(() => {
      const current = id ? this.collections[kind].find(item => item.id === id) : null;
      if (id && !current) throw new Error('分類が見つかりません');
      const name = input.name ?? current?.name;
      if (typeof name !== 'string' || !name.trim() || name.trim().length > 80) throw new Error('名前は1〜80文字です');
      const folderId = input.folderId ?? current?.folderId ?? '';
      if (kind === 'categories' && typeof folderId !== 'string') throw new Error('フォルダが無効です');
      if (kind === 'categories' && folderId && !this.collections.folders.some(item => item.id === folderId)) throw new Error('フォルダが見つかりません');
      if (this.collections[kind].some(item => item.id !== id && item.name === name.trim() && (kind === 'folders' || item.folderId === folderId))) throw new Error('同じ場所に同名の分類があります');
      result = { id: id || randomUUID(), name: name.trim(), ...(kind === 'categories' ? { folderId } : {}) };
      if (current) Object.assign(current, result);
      else this.collections[kind].push(result);
    }, true);
    return clone(result);
  }

  async removeCollection(kind, id) {
    if (!['folders', 'categories'].includes(kind)) throw new Error('分類の種類が無効です');
    await this.#mutate(() => {
      if (!this.collections[kind].some(item => item.id === id)) throw new Error('分類が見つかりません');
      if (kind === 'folders' && this.collections.categories.some(item => item.folderId === id)) throw new Error('先にカテゴリを別のフォルダへ移してください');
      if (kind === 'categories' && this.tasks.some(task => !task.deletedAt && task.categoryId === id)) throw new Error('先にタスクを別のカテゴリへ移してください');
      this.collections[kind] = this.collections[kind].filter(item => item.id !== id);
    }, true);
  }

  list() {
    return clone(this.tasks.filter((task) => !task.deletedAt).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  }

  get(id) {
    const task = this.tasks.find((candidate) => candidate.id === id && !candidate.deletedAt);
    return task ? clone(task) : null;
  }

  async create({ title, description = '', notes = '', dueDate = '', repeat = null, categoryId = '' }) {
    const normalizedTitle = String(title || '').trim();
    if (!normalizedTitle) throw new Error('Title is required');
    if (normalizedTitle.length > 160) throw new Error('Title must be 160 characters or fewer');
    const now = new Date().toISOString();
    const task = {
      id: randomUUID(),
      title: normalizedTitle,
      description: String(description || '').trim().slice(0, 4000),
      ...editableFields({ title, description, notes, dueDate, repeat, categoryId }),
      ...phaseFields('idle'),
      xangiSessionId: null,
      result: '',
      error: '',
      createdAt: now,
      updatedAt: now,
    };
    await this.#mutate((tasks) => { this.validateCategory(categoryId); tasks.push(task); });
    return clone(task);
  }

  async createInboxItem({
    title,
    description = '',
    type = 'action',
    sourceText,
    sourceUrl = '',
    sourceSpeaker = '',
    sourceKey = '',
    dueRaw = '',
    categoryId = '',
  }) {
    if (typeof sourceKey !== 'string' || sourceKey.length > 300) throw new Error('Invalid source key');
    const normalizedTitle = String(title || '').trim();
    const normalizedSourceText = String(sourceText || '').trim();
    const normalizedType = String(type || '').trim().toLowerCase();
    if (!normalizedTitle) throw new Error('Title is required');
    if (normalizedTitle.length > 160) throw new Error('Title must be 160 characters or fewer');
    if (!normalizedSourceText) throw new Error('Source text is required');
    if (normalizedSourceText.length > 4000) throw new Error('Source text must be 4000 characters or fewer');
    if (!TASK_TYPE_VALUES.has(normalizedType)) throw new Error('Type must be action, waiting, or hold');
    const normalizedSourceUrl = String(sourceUrl || '').trim();
    if (normalizedSourceUrl && !/^https?:\/\//i.test(normalizedSourceUrl)) {
      throw new Error('Source URL must use http or https');
    }
    if (normalizedSourceUrl.length > 2000) throw new Error('Source URL must be 2000 characters or fewer');
    const now = new Date().toISOString();
    const task = {
      id: randomUUID(),
      title: normalizedTitle,
      categoryId,
      description: String(description || '').trim().slice(0, 4000),
      ...phaseFields('inbox'),
      type: normalizedType,
      source: {
        ...(sourceKey ? {key: sourceKey} : {}),
        text: normalizedSourceText,
        url: normalizedSourceUrl,
        speaker: String(sourceSpeaker || '').trim().slice(0, 120),
      },
      dueRaw: String(dueRaw || '').trim().slice(0, 160),
      xangiSessionId: null,
      result: '',
      error: '',
      createdAt: now,
      updatedAt: now,
    };
    let result = task;
    await this.#mutate((tasks) => {
      // Check inside the write queue, including rejected and soft-deleted records.
      const existing = sourceKey && tasks.find(item => item.source?.key === sourceKey);
      if (existing) result = existing;
      else { this.validateCategory(categoryId); tasks.push(task); }
    });
    return clone(result);
  }

  async complete(id, today = todayJst()) {
    let result;
    await this.#mutate((tasks) => {
      const task = tasks.find(t => t.id === id && !t.deletedAt);
      if (!task) throw new Error('Task not found');
      if (!['idle', 'working', 'review', 'completing', 'closed'].includes(taskPhase(task))) throw new Error('この状態では完了にできません');
      const now = new Date().toISOString();
      let nextTask = null;
      if (taskPhase(task) !== 'closed' && task.completionOriginPhase !== 'closed' && !task.nextTaskId && task.repeat) {
        const anchor = task.repeatAnchor || task.dueDate || today;
        nextTask = {
          id: randomUUID(), title: task.title, description: task.description,
          categoryId: task.categoryId || '', repeat: clone(task.repeat), repeatAnchor: anchor,
          dueDate: nextDueDate(task.repeat, anchor, task.dueDate || today, today),
          seriesId: task.seriesId || task.id, previousTaskId: task.id,
          ...phaseFields('idle'), xangiSessionId: null, result: '', error: '',
          createdAt: now, updatedAt: now,
        };
        tasks.push(nextTask);
        task.nextTaskId = nextTask.id;
      }
      delete task.completionOriginPhase;
      Object.assign(task, phaseFields('closed')); task.completedAt ||= now; task.updatedAt = now;
      result = { task: clone(task), nextTask: nextTask ? clone(nextTask) : null };
    });
    return result;
  }

  async transition(id, action) {
    let result;
    await this.#mutate(tasks => {
      const task = tasks.find(item => item.id === id && !item.deletedAt);
      if (!task) throw new Error('Task not found');
      if (action === 'dismiss') {
        if (task.status !== 'inbox') throw new Error('Only Inbox items can be dismissed');
        Object.assign(task, phaseFields('dismissed'));
        task.completedAt = new Date().toISOString();
      } else {
        if (!['inbox', 'closed'].includes(task.status)) throw new Error('Only Inbox or Closed items can be opened');
        Object.assign(task, phaseFields('idle'));
        delete task.completedAt;
        delete task.completionOriginPhase;
      }
      task.updatedAt = new Date().toISOString();
      result = clone(task);
    });
    return result;
  }

  async setManualStatus(id, status) {
    let result;
    await this.#mutate((tasks) => {
      const task = tasks.find(t => t.id === id && !t.deletedAt);
      if (!task) throw new Error('Task not found');
      if (task.status !== 'open' || !['idle', 'working', 'review', 'failed'].includes(taskPhase(task)) || !['idle', 'working'].includes(status)) {
        throw new Error('この状態では手動で変更できません');
      }
      Object.assign(task, phaseFields(status));
      delete task.completedAt;
      delete task.completionOriginPhase;
      task.updatedAt = new Date().toISOString();
      result = clone(task);
    });
    return result;
  }

  async remove(id) {
    await this.#mutate((tasks) => {
      const task = tasks.find((candidate) => candidate.id === id && !candidate.deletedAt);
      if (!task) throw new Error('Task not found');
      if (['delegating', 'running', 'completing'].includes(taskPhase(task))) {
        throw new Error('実行中のタスクは削除できません。終了後に削除してください。');
      }
      task.deletedAt = new Date().toISOString();
      task.updatedAt = task.deletedAt;
    });
  }

  async update(id, updates, expectedPhases = null) {
    if (Object.hasOwn(updates, 'labels')) throw new Error('Unsupported field: labels');
    let updated;
    await this.#mutate((tasks) => {
      const task = tasks.find((candidate) => candidate.id === id && !candidate.deletedAt);
      if (!task) throw new Error('Task not found');
      if (expectedPhases && !expectedPhases.includes(taskPhase(task))) { updated = clone(task); return; }
      if ('categoryId' in updates) this.validateCategory(updates.categoryId);
      validateTaskState({ ...task, ...updates });
      if (('dueDate' in updates && updates.dueDate !== task.dueDate) || ('repeat' in updates && JSON.stringify(updates.repeat) !== JSON.stringify(task.repeat))) delete task.repeatAnchor;
      Object.assign(task, updates, { updatedAt: new Date().toISOString() });
      updated = clone(task);
    });
    return updated;
  }

  async #mutate(mutator, collectionsOnly = false) {
    const operation = this.writeQueue.then(async () => {
      await this.#finishImport();
      const before = clone(this.tasks);
      const beforeCollections = clone(this.collections);
      try { mutator(this.tasks); await this.#persist(collectionsOnly); }
      catch (error) { this.tasks = before; this.collections = beforeCollections; throw error; }
    });
    this.writeQueue = operation.catch(() => {});
    return operation;
  }

  async #persist(collectionsOnly = false) {
    const file = collectionsOnly ? `${this.filePath}.collections.json` : this.filePath;
    const temporaryPath = `${file}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(collectionsOnly ? this.collections : this.tasks, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, file);
  }
}
