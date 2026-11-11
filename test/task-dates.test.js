import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dateFields, dateSummary, dateContext, sortTasks } from '../public/task-dates.js';
import { TaskStore, editableFields, validateBackup } from '../src/task-store.js';
import { migrateTargetDates } from '../scripts/migrate-target-dates.js';
import { XangiConnector } from '../src/xangi-connector.js';

const deadline = { deadlineStatus: 'confirmed', deadlineAt: '2026-11-16', deadlineEvidence: 'Submission email' };
const now = new Date('2026-11-09T02:00:00Z');
const open = { status: 'open' };

test('goals never imply external deadlines', () => {
  for (const dates of [{ targetDate: '2026-11-08' }]) {
    const result = dateSummary({ ...open, ...dates }, now);
    assert.equal(result.deadlineOverdue, false);
    assert.equal(result.deadlineSoon, false);
  }
  assert.equal(dateSummary({ ...open, targetDate: '2026-11-08' }, now).targetPassed, true);
  assert.equal(dateSummary({ ...open, targetDate: '2026-11-09' }, now).targetToday, true);
  assert.equal(dateSummary({ ...open, targetDate: '2026-11-10' }, new Date('2026-11-09T15:00:00Z')).targetToday, true);
});

test('deadline views use Japanese calendar days independently of goals, with closed/inbox excluded', () => {
  const task = { ...open, targetDate: '2030-01-01', ...deadline };
  assert.equal(dateSummary(task, new Date('2026-11-16T07:59:59Z')).deadlineOverdue, false);
  assert.equal(dateSummary(task, new Date('2026-11-16T14:59:59.999Z')).deadlineOverdue, false);
  assert.equal(dateSummary(task, new Date('2026-11-16T15:00:00Z')).deadlineOverdue, true);
  assert.equal(dateSummary(task, new Date('2026-11-08T15:00:00Z')).deadlineSoon, true);
  assert.equal(dateSummary(task, new Date('2026-11-08T14:59:59.999Z')).deadlineSoon, false);
  for (const status of ['closed', 'inbox']) assert.equal(dateSummary({ ...task, status }, new Date('2026-11-17')).deadlineOverdue, false);
});

test('dates validate calendar days, state and evidence; partial edits preserve deadline dates', () => {
  const task = { title: 'Submit', ...dateFields(deadline) };
  assert.equal(editableFields({ targetDate: '2026-11-10' }, task).deadlineAt, '2026-11-16');
  assert.equal(dateFields({ deadlineStatus: 'none' }, task).deadlineAt, '');
  assert.notEqual(dateFields({ deadlineStatus: 'none' }).deadlineStatus, dateFields({}).deadlineStatus);
  for (const bad of [ { targetDate: null }, { targetDate: '2026-02-30' }, { dueDate: 'bad' }, { deadlineAt: '2026-11-16T17:00' }, { deadlineAt: '2026-02-30T17:00+09:00' }, { deadlineAt: '2026-11-16T24:00+09:00' }, { deadlineStatus: 'confirmed' }, { ...deadline, deadlineStatus: 'none' }, { deadlineEvidence: 1 }, { deadlineStatus: 'maybe' } ]) assert.throws(() => dateFields(bad));
});

test('one-time conversion moves old dates into goals and removes obsolete fields without inventing deadlines', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'task-dates-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'tasks.json');
  const store = new TaskStore(file); await store.init();
  const task = await store.create({ title: 'New', targetDate: '2026-11-09', ...deadline });
  const old = { ...task, targetDate: '', dueDate: '2026-11-08', deadlineAt: '', deadlineStatus: 'unknown' };
  await writeFile(file, JSON.stringify([old]));
  await assert.rejects(new TaskStore(file).init(), /migrate-target-dates/);
  const converted = migrateTargetDates([old]);
  assert.equal(converted[0].targetDate, '2026-11-08');
  assert.equal(converted[0].deadlineStatus, 'unknown');
  assert.ok(!Object.hasOwn(converted[0], 'dueDate'));
  assert.equal(old.dueDate, '2026-11-08');
  assert.equal(migrateTargetDates([{ ...old, targetDate: '2026-11-10' }])[0].targetDate, '2026-11-10');
  assert.throws(() => migrateTargetDates([{ dueDate: '2026-02-30' }]));
  await writeFile(file, JSON.stringify(converted));
  const reloaded = new TaskStore(file); await reloaded.init();
  assert.equal(reloaded.get(task.id).targetDate, '2026-11-08');
  const backup = await reloaded.backupSnapshot();
  assert.deepEqual(validateBackup(backup).tasks, converted);
  assert.equal(migrateTargetDates({ ...backup, tasks: [old] }).tasks[0].targetDate, '2026-11-08');
  backup.tasks[0].deadlineAt = 'bad'; backup.tasks[0].deadlineStatus = 'confirmed';
  assert.throws(() => validateBackup(backup));
});

test('new recurrence advances goals, does not invent external deadlines, and goal edits reset anchors', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'task-dates-repeat-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new TaskStore(join(dir, 'tasks.json')); await store.init();
  const task = await store.create({ title: 'Monthly', targetDate: '2026-01-31', ...deadline, repeat: { unit: 'month', interval: 1 } });
  const next = (await store.complete(task.id, '2026-01-31')).nextTask;
  assert.equal(next.targetDate, '2026-02-28'); assert.ok(!Object.hasOwn(next, 'dueDate')); assert.equal(next.deadlineStatus, 'unknown');
  await store.update(next.id, editableFields({ targetDate: '2026-02-20' }, next));
  assert.equal((await store.complete(next.id, '2026-02-20')).nextTask.targetDate, '2026-03-20');
  assert.ok((await store.create({ title: 'No date', repeat: { unit: 'day', interval: 1 } })).targetDate);
});

test('both delegation routes carry date meanings and deadline evidence', async () => {
  for (const method of ['sendTask', 'dispatchTask']) {
    const messages = [];
    const connector = new XangiConnector({ baseUrl: 'http://test', fetchImpl: async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : {};
      if (body.text || body.message) messages.push(body.text || body.message);
      return new Response(JSON.stringify(url.endsWith('/api/sessions') || url.endsWith('/api/prompt') ? { sessionId: 'session' } : {}));
    } });
    if (method === 'dispatchTask') connector.sendAgentMessage = async (_, text) => { messages.push(text); };
    await connector[method]({ id: 'task', title: 'Submit', targetDate: '2026-11-09', ...deadline });
    const text = messages.join('\n');
    assert.match(text, /自主的な予定・提出期限ではない/); assert.match(text, /Submission email/); assert.doesNotMatch(text, /管理日/);
  }
  assert.match(dateContext({ deadlineStatus: 'none' }), /なし（確認済み）/);
  assert.match(dateContext({}), /未確認/);
});

test('sorting uses goal or deadline dates, with missing dates last and deterministic ties', () => {
  const tasks = [
    { id: 'none', targetDate: '', createdAt: '2026-11-10' },
    { id: 'later', targetDate: '2026-11-20', createdAt: '2026-11-01', deadlineStatus: 'confirmed', deadlineAt: '2026-11-20' },
    { id: 'first', targetDate: '2026-11-09', createdAt: '2026-11-02', deadlineStatus: 'confirmed', deadlineAt: '2026-11-20' },
    { id: 'tie', targetDate: '2026-11-09', createdAt: '2026-11-03' },
  ];
  const ids = sort => sortTasks(tasks, sort).map(t => t.id);
  assert.deepEqual(ids('target-asc'), ['tie', 'first', 'later', 'none']);
  assert.deepEqual(ids('target-desc'), ['later', 'tie', 'first', 'none']);
  assert.deepEqual(ids('deadline-asc'), ['first', 'later', 'none', 'tie']);
  assert.deepEqual(ids('deadline-desc'), ['first', 'later', 'none', 'tie']);
  assert.deepEqual(ids('created'), ['none', 'tie', 'first', 'later']);
  assert.deepEqual(ids('created-desc'), ['none', 'tie', 'first', 'later']);
  assert.deepEqual(ids('created-asc'), ['later', 'first', 'tie', 'none']);
  assert.equal(tasks[0].id, 'none');
});

test('both deadline directions keep undated tasks last and creation ties are deterministic', () => {
  const tasks = [
    { id: 'b', createdAt: '2026-11-01' },
    { id: 'a', createdAt: '2026-11-01' },
    { id: 'late', createdAt: '2026-11-02', deadlineStatus: 'confirmed', deadlineAt: '2026-11-20' },
    { id: 'early', createdAt: '2026-11-03', deadlineStatus: 'confirmed', deadlineAt: '2026-11-10' },
  ];
  const ids = sort => sortTasks(tasks, sort).map(t => t.id);
  assert.deepEqual(ids('deadline-asc'), ['early', 'late', 'a', 'b']);
  assert.deepEqual(ids('deadline-desc'), ['late', 'early', 'a', 'b']);
  assert.deepEqual(ids('created-asc'), ['a', 'b', 'late', 'early']);
  assert.deepEqual(ids('created-desc'), ['early', 'late', 'a', 'b']);
});

test('deadlines accept only valid calendar dates and reject all timestamp formats', () => {
  assert.equal(dateFields({ deadlineAt: '2028-02-29' }).deadlineAt, '2028-02-29');
  assert.equal(dateFields({ deadlineAt: '' }).deadlineAt, '');
  assert.match(dateContext(deadline), /実際の締切: 2026-11-16/);
  for (const value of [null, '2026-02-29', '2026-02-30', '2026-1-1', '2026-11-16T08:00:11.621Z', '2026-11-16T23:59:59.999+09:00', '2026-11-16T17:00']) {
    assert.throws(() => dateFields({ deadlineStatus: 'confirmed', deadlineAt: value }));
  }
});

test('storage and Export/Import preserve date-only deadlines; timestamp data is rejected', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'task-calendar-deadline-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'tasks.json');
  const store = new TaskStore(file); await store.init();
  const task = await store.create({ title: 'Leap date', deadlineAt: '2028-02-29' });
  const reloaded = new TaskStore(file); await reloaded.init();
  assert.equal(reloaded.get(task.id).deadlineAt, '2028-02-29');
  const backup = await reloaded.backupSnapshot();
  assert.equal(validateBackup(backup).tasks[0].deadlineAt, '2028-02-29');
  const restored = new TaskStore(join(dir, 'restored.json')); await restored.init();
  const preview = await restored.previewImport(backup);
  await restored.importSnapshot(backup, preview.token);
  assert.equal(restored.get(task.id).deadlineAt, '2028-02-29');
  const timestamp = '2028-02-29T23:59:59.999+09:00';
  await assert.rejects(store.create({ title: 'Timestamp', deadlineAt: timestamp }), /YYYY-MM-DD/);
  backup.tasks[0].deadlineAt = timestamp;
  assert.throws(() => validateBackup(backup));
  await writeFile(file, JSON.stringify(backup.tasks));
  await assert.rejects(new TaskStore(file).init(), /YYYY-MM-DD/);
});


test('today and overdue date flags change at Japan midnight and exclude closed/inbox', () => {
  const task = { ...open, targetDate: '2026-11-11', deadlineAt: '2026-11-11', deadlineStatus: 'confirmed' };
  for (const [instant, today, passed] of [
    ['2026-11-10T14:59:59.999Z', false, false],
    ['2026-11-10T15:00:00Z', true, false],
    ['2026-11-11T14:59:59.999Z', true, false],
    ['2026-11-11T15:00:00Z', false, true],
  ]) {
    const summary = dateSummary(task, new Date(instant));
    assert.equal(summary.targetToday, today);
    assert.equal(summary.deadlineToday, today);
    assert.equal(summary.targetPassed, passed);
    assert.equal(summary.deadlineOverdue, passed);
  }
  for (const status of ['closed', 'inbox']) {
    for (const instant of ['2026-11-11T00:00:00Z', '2026-11-12T00:00:00Z']) {
      const summary = dateSummary({ ...task, status }, new Date(instant));
      for (const flag of ['targetToday', 'targetPassed', 'deadlineToday', 'deadlineOverdue']) assert.equal(summary[flag], false);
    }
  }
  for (const deadlineStatus of ['unknown', 'none']) {
    assert.equal(dateSummary({ ...task, deadlineStatus }, new Date('2026-11-11T00:00:00Z')).deadlineToday, false);
  }
  assert.equal(dateSummary(open, new Date('2026-11-11T00:00:00Z')).deadlineToday, false);
});
