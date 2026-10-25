import { taskPhase, phaseFields } from '../public/task-state.js';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { TaskStore } from '../src/task-store.js';

test('creates, updates, and reloads tasks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xangi-tasks-store-'));
  const path = join(directory, 'tasks.json');
  const store = new TaskStore(path);
  await store.init();
  const created = await store.create({ title: 'Ship the smallest slice', description: 'Keep it useful.' });
  await store.update(created.id, { ...phaseFields('running'), xangiSessionId: 'session-1' });

  const reloaded = new TaskStore(path);
  await reloaded.init();
  assert.deepEqual(reloaded.get(created.id), {
    ...created,
    ...phaseFields('running'),
    xangiSessionId: 'session-1',
    updatedAt: reloaded.get(created.id).updatedAt,
  });
});

test('rejects empty and oversized titles', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xangi-tasks-store-'));
  const store = new TaskStore(join(directory, 'tasks.json'));
  await store.init();
  await assert.rejects(() => store.create({ title: '   ' }), /Title is required/);
  await assert.rejects(() => store.create({ title: 'x'.repeat(161) }), /160 characters/);
});

test('creates and reviews a conversation candidate', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xangi-tasks-store-'));
  const path = join(directory, 'tasks.json');
  const store = new TaskStore(path);
  await store.init();
  const candidate = await store.createInboxItem({
    title: '仕様案を確認する',
    type: 'waiting',
    sourceText: '仕様案を送るので、確認をお願いします',
    sourceUrl: 'https://discord.com/channels/1/2/3',
    sourceSpeaker: 'teammate',
    dueRaw: '明日',
  });
  assert.equal(taskPhase(candidate), 'inbox');
  assert.equal(candidate.type, 'waiting');
  assert.equal(candidate.source.text, '仕様案を送るので、確認をお願いします');

  await store.update(candidate.id, { ...phaseFields('idle') });
  const reloaded = new TaskStore(path);
  await reloaded.init();
  assert.equal(taskPhase(reloaded.get(candidate.id)), 'idle');
});

test('validates candidate evidence and type', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xangi-tasks-store-'));
  const store = new TaskStore(join(directory, 'tasks.json'));
  await store.init();
  await assert.rejects(() => store.createInboxItem({ title: 'Missing evidence' }), /Source text is required/);
  await assert.rejects(() => store.createInboxItem({ title: 'Bad type', sourceText: 'text', type: 'idea' }), /Type must be/);
  await assert.rejects(() => store.createInboxItem({ title: 'Bad URL', sourceText: 'text', sourceUrl: 'javascript:alert(1)' }), /Source URL/);
});


test('manual status rechecks live state inside the write queue', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xangi-tasks-store-'));
  const store = new TaskStore(join(directory, 'tasks.json')); await store.init();
  const task = await store.create({ title: 'Queued work' });
  const running = store.update(task.id, { ...phaseFields('running') });
  await assert.rejects(store.setManualStatus(task.id, 'idle'), /手動で変更できません/);
  await running;
  assert.equal(taskPhase(store.get(task.id)), 'running');
});

test('folders and categories survive reload, move independently and preserve recurring task category', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tasks-categories-'));
  const path = join(directory, 'tasks.json');
  const store = new TaskStore(path); await store.init();
  const old = await store.create({ title: 'Unclassified' });
  const folder = await store.saveCollection('folders', { name: 'Work' });
  const category = await store.saveCollection('categories', { name: 'Project', folderId: folder.id });
  const task = await store.create({ title: 'Daily', categoryId: category.id, repeat: { unit: 'day', interval: 1 }, dueDate: '2026-10-22' });
  await assert.rejects(store.removeCollection('categories', category.id), /先にタスク/);
  await assert.rejects(store.removeCollection('folders', folder.id), /先にカテゴリ/);
  const completed = await store.complete(task.id, '2026-10-22');
  assert.equal(completed.nextTask.categoryId, category.id);
  await store.saveCollection('categories', { name: 'Renamed', folderId: '' }, category.id);
  await store.removeCollection('folders', folder.id);
  const reloaded = new TaskStore(path); await reloaded.init();
  assert.equal(reloaded.get(old.id).categoryId, '');
  assert.equal(reloaded.get(task.id).categoryId, category.id);
  assert.deepEqual(reloaded.collectionsList(), { folders: [], categories: [{ id: category.id, name: 'Renamed', folderId: '' }] });
  await assert.rejects(reloaded.create({ title: 'Bad', categoryId: 'missing' }), /カテゴリ/);
  await assert.rejects(reloaded.saveCollection('categories', { name: 'Bad', folderId: 'missing' }), /フォルダ/);
  assert.equal(reloaded.list().length, 3);
});

test('classification changes roll back on write failure and serialize with task assignment', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tasks-category-failure-'));
  const store = new TaskStore(join(directory, 'tasks.json')); await store.init();
  const category = await store.saveCollection('categories', { name: 'Project' });
  const results = await Promise.allSettled([
    store.create({ title: 'Concurrent', categoryId: category.id }),
    store.removeCollection('categories', category.id),
  ]);
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].status, 'rejected');
  const original = store.filePath;
  store.filePath = join(directory, 'missing', 'tasks.json');
  await assert.rejects(store.saveCollection('categories', { name: 'Lost' }));
  assert.equal(store.collectionsList().categories.length, 1);
  store.filePath = original;
});

test('candidate source keys survive concurrent retries, rejection, deletion and restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'candidate-key-'));
  const path = join(directory, 'tasks.json');
  let store = new TaskStore(path); await store.init();
  const input = {title:'Review a request',sourceText:'Please review this request',sourceKey:'mail:one'};
  const [one,two] = await Promise.all([store.createInboxItem(input),store.createInboxItem(input)]);
  assert.equal(one.id,two.id);
  await store.update(one.id,{...phaseFields('dismissed')});
  assert.equal(taskPhase((await store.createInboxItem(input))),'dismissed');
  await store.remove(one.id);
  store = new TaskStore(path); await store.init();
  const retry = await store.createInboxItem({...input,title:'Changed title'});
  assert.equal(retry.id,one.id); assert.ok(retry.deletedAt);
  assert.equal(store.list().length,0);
  assert.notEqual((await store.createInboxItem({...input,sourceKey:'conversation:other'})).id,one.id);
});
