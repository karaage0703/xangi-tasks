import { taskPhase, phaseFields } from '../public/task-state.js';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createTaskServer } from '../src/app.js';
import { TaskStore } from '../src/task-store.js';

const publicDir = resolve(fileURLToPath(new URL('../public', import.meta.url)));

async function startTestApp(overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'xangi-tasks-app-'));
  const store = new TaskStore(join(directory, 'tasks.json'));
  await store.init();
  const followUps = [];
  const completions = [];
  const connector = {
    async completeSession(sessionId) { completions.push(sessionId); return { ok: true, lifecycle: 'closed' }; },
    async health() {
      return { version: 'test' };
    },
    async sendTask() {
      return { sessionId: 'web-test-session' };
    },
    async readSession() {
      return { state: 'idle', result: 'The requested work is complete.', error: '' };
    },
    async readHistory() {
      return [
        { role: 'user', text: 'Build one useful slice' },
        { role: 'assistant', text: 'The requested work is complete.' },
      ];
    },
    async sendMessage(sessionId, text) {
      followUps.push({ sessionId, text });
      return { sessionId };
    },
  };
  Object.assign(connector, overrides);
  const app = createTaskServer({ store, connector, publicDir, pollIntervalMs: 1000, auth: { token: 'test-auth-token-with-at-least-32-characters' } });
  await new Promise((resolveListen) => app.server.listen(0, '127.0.0.1', resolveListen));
  const address = app.server.address();
  return {
    app,
    store,
    connector,
    completions,
    followUps,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolveClose) => app.server.close(resolveClose)),
  };
}

async function jsonRequest(baseUrl, path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { Authorization: 'Bearer test-auth-token-with-at-least-32-characters', 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  return { response, body: await response.json() };
}

test('runs the complete task to xangi review flow', async (context) => {
  const testApp = await startTestApp();
  context.after(testApp.close);

  const created = await jsonRequest(testApp.baseUrl, '/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ title: 'Build one useful slice', description: 'Verify it end to end.' }),
  });
  assert.equal(created.response.status, 201);
  const id = created.body.task.id;

  const delegated = await jsonRequest(testApp.baseUrl, `/api/tasks/${id}/delegate`, { method: 'POST', body: '{}' });
  assert.equal(delegated.response.status, 202);
  assert.equal(taskPhase(delegated.body.task), 'running');
  assert.equal(delegated.body.task.xangiSessionId, 'web-test-session');

  const synced = await jsonRequest(testApp.baseUrl, `/api/tasks/${id}/sync`, { method: 'POST', body: '{}' });
  assert.equal(taskPhase(synced.body.task), 'review');
  assert.equal(synced.body.task.result, 'The requested work is complete.');

  const detail = await jsonRequest(testApp.baseUrl, `/api/tasks/${id}`);
  assert.deepEqual(detail.body.history.map((message) => message.role), ['user', 'assistant']);

  const followedUp = await jsonRequest(testApp.baseUrl, `/api/tasks/${id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ text: 'Add the missing detail.' }),
  });
  assert.equal(followedUp.response.status, 202);
  assert.equal(taskPhase(followedUp.body.task), 'running');
  assert.deepEqual(testApp.followUps, [{ sessionId: 'web-test-session', text: 'Add the missing detail.' }]);

  const resynced = await jsonRequest(testApp.baseUrl, `/api/tasks/${id}/sync`, { method: 'POST', body: '{}' });
  assert.equal(taskPhase(resynced.body.task), 'review');

  const completed = await jsonRequest(testApp.baseUrl, `/api/tasks/${id}/close`, { method: 'POST', body: '{}' });
  assert.equal(taskPhase(completed.body.task), 'closed');
  assert.deepEqual(testApp.completions, ['web-test-session']);

  const listed = await jsonRequest(testApp.baseUrl, '/api/tasks');
  assert.equal(taskPhase(listed.body.tasks[0]), 'closed');
});

test('serves the application and reports xangi health', async (context) => {
  const testApp = await startTestApp();
  context.after(testApp.close);
  const page = await fetch(testApp.baseUrl, { headers: { Authorization: 'Bearer test-auth-token-with-at-least-32-characters' } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /xangi-tasks/);
  const health = await jsonRequest(testApp.baseUrl, '/api/health');
  assert.equal(health.body.xangi.connected, true);
});

test('accepts a conversation candidate and requires review before delegation', async (context) => {
  const testApp = await startTestApp();
  context.after(testApp.close);
  const created = await jsonRequest(testApp.baseUrl, '/api/inbox', {
    method: 'POST',
    body: JSON.stringify({
      title: '返信を待つ',
      type: 'waiting',
      sourceText: '明日までに回答します',
      sourceUrl: 'https://discord.com/channels/1/2/3',
      dueRaw: '明日まで',
    }),
  });
  assert.equal(created.response.status, 201);
  assert.equal(taskPhase(created.body.task), 'inbox');
  const id = created.body.task.id;

  const blocked = await jsonRequest(testApp.baseUrl, `/api/tasks/${id}/delegate`, { method: 'POST', body: '{}' });
  assert.equal(blocked.response.status, 400);

  const confirmed = await jsonRequest(testApp.baseUrl, `/api/tasks/${id}/open`, { method: 'POST', body: '{}' });
  assert.equal(taskPhase(confirmed.body.task), 'idle');
});

test('dismisses a conversation candidate without deleting its evidence', async (context) => {
  const testApp = await startTestApp();
  context.after(testApp.close);
  const created = await jsonRequest(testApp.baseUrl, '/api/inbox', {
    method: 'POST',
    body: JSON.stringify({ title: '雑談候補', type: 'hold', sourceText: 'いつかやるかも' }),
  });
  const rejected = await jsonRequest(testApp.baseUrl, `/api/tasks/${created.body.task.id}/dismiss`, { method: 'POST', body: '{}' });
  assert.equal(taskPhase(rejected.body.task), 'dismissed');
  assert.equal(rejected.body.task.source.text, 'いつかやるかも');
});

test('completion failure retains review and can be retried; existing done tasks can synchronize', async (context) => {
  const t = await startTestApp({ completeSession: async () => { throw new Error('Session is busy'); } });
  context.after(t.close);
  const task = await t.store.create({ title: 'Completion retry' });
  await t.store.update(task.id, { ...phaseFields('review'), xangiSessionId: 'session-retry' });
  const path = `/api/tasks/${task.id}/close`;
  const failed = await jsonRequest(t.baseUrl, path, { method: 'POST', body: '{}' });
  assert.equal(failed.response.status, 400);
  assert.match(failed.body.error, /busy/);
  assert.equal(taskPhase(t.store.get(task.id)), 'review');
  let count = 0;
  t.connector.completeSession = async (id) => { assert.equal(id, 'session-retry'); count++; };
  assert.equal(taskPhase((await jsonRequest(t.baseUrl, path, { method: 'POST', body: '{}' })).body.task), 'closed');
  assert.equal(taskPhase((await jsonRequest(t.baseUrl, path, { method: 'POST', body: '{}' })).body.task), 'closed');
  assert.equal(count, 2);
});

test('deletes tasks without closing xangi; rejects running and unknown tasks', async (context) => {
  const t = await startTestApp();
  context.after(t.close);
  const task = await t.store.create({ title: 'Delete only the task' });
  await t.store.update(task.id, { ...phaseFields('running'), xangiSessionId: 'keep-history' });
  const path = `/api/tasks/${task.id}`;
  assert.equal((await jsonRequest(t.baseUrl, path, { method: 'DELETE' })).response.status, 400);
  assert.equal(taskPhase(t.store.get(task.id)), 'running');
  await t.store.update(task.id, { ...phaseFields('review') });
  assert.equal((await jsonRequest(t.baseUrl, path, { method: 'DELETE' })).response.status, 200);
  assert.equal((await jsonRequest(t.baseUrl, path)).response.status, 404);
  assert.equal((await jsonRequest(t.baseUrl, '/api/tasks')).body.tasks.length, 0);
  assert.deepEqual(t.completions, []);
  assert.equal((await jsonRequest(t.baseUrl, path, { method: 'DELETE' })).response.status, 404);
  const reloaded = new TaskStore(t.store.filePath);
  await reloaded.init();
  assert.equal(reloaded.get(task.id), null);
  assert.equal(reloaded.list().length, 0);
});

test('edits metadata, validates dates, preserves lifecycle and synchronizes session title', async (context) => {
  const renamed = [];
  const t = await startTestApp({ renameSession: async (id,title) => renamed.push({id,title}) });
  context.after(t.close);
  const task = await t.store.create({title:'Before'});
  await t.store.update(task.id,{...phaseFields('review'),xangiSessionId:'linked',result:'keep'});
  const path=`/api/tasks/${task.id}`;
  const edited=await jsonRequest(t.baseUrl,path,{method:'PUT',body:JSON.stringify({title:'After',description:'New',labels:['仕事','個人活動','仕事'],dueDate:'2026-10-31',...phaseFields('closed')})});
  assert.equal(edited.response.status,200);
  assert.deepEqual(edited.body.task.labels,['仕事','個人活動']);
  assert.equal(taskPhase(edited.body.task),'review');
  assert.equal(edited.body.task.result,'keep');
  assert.deepEqual(renamed,[{id:'linked',title:'After'}]);
  const reload=new TaskStore(t.store.filePath);await reload.init();
  assert.equal(reload.get(task.id).dueDate,'2026-10-31');
  for (const fields of [{title:''},{dueDate:'2026-02-30'},{labels:'仕事'}]) {
    assert.equal((await jsonRequest(t.baseUrl,path,{method:'PUT',body:JSON.stringify(fields)})).response.status,400);
  }
  t.connector.renameSession=async()=>{throw new Error('offline')};
  assert.equal((await jsonRequest(t.baseUrl,path,{method:'PUT',body:'{"title":"Not saved"}'})).response.status,400);
  assert.equal(t.store.get(task.id).title,'After');
});

test('manual completion creates one next task; failed xangi close creates none', async(context)=>{
  const app=await startTestApp({completeSession:async()=>{throw new Error('close unavailable');}});
  context.after(app.close);
  const repeat={unit:'day',interval:1};
  const a=await app.store.create({title:'Manual',repeat});
  const result=await jsonRequest(app.baseUrl,`/api/tasks/${a.id}/close`,{method:'POST',body:'{}'});
  assert.equal(result.response.status,200);
  assert.equal(taskPhase(result.body.task),'closed'); assert.equal(taskPhase(result.body.nextTask),'idle');
  await jsonRequest(app.baseUrl,`/api/tasks/${a.id}/close`,{method:'POST',body:'{}'});
  assert.equal(app.store.list().length,2);
  const b=await app.store.create({title:'Delegated',repeat});
  await app.store.update(b.id,{...phaseFields('review'),xangiSessionId:'blocked'});
  const failed=await jsonRequest(app.baseUrl,`/api/tasks/${b.id}/close`,{method:'POST',body:'{}'});
  assert.equal(failed.response.status,400); assert.equal(taskPhase(app.store.get(b.id)),'review');
  assert.equal(app.store.list().length,3);
});

test('delegation validates and persists optional instructions without changing description', async context => {
  const sent = [];
  const app = await startTestApp({ async sendTask(task) { sent.push(task); return { sessionId: 'instructions-test' }; } });
  context.after(app.close);
  const task = await app.store.create({ title: '調査', description: '元の完了条件' });
  for (const instructions of [42, 'a'.repeat(4001)]) {
    const rejected = await jsonRequest(app.baseUrl, `/api/tasks/${task.id}/delegate`, { method: 'POST', body: JSON.stringify({ instructions }) });
    assert.equal(rejected.response.status, 400);
    assert.equal(taskPhase(app.store.get(task.id)), 'idle');
  }
  assert.equal(sent.length, 0);
  const accepted = await jsonRequest(app.baseUrl, `/api/tasks/${task.id}/delegate`, { method: 'POST', body: JSON.stringify({ instructions: '  送信せず下書きを作る  ' }) });
  assert.equal(accepted.response.status, 202);
  assert.equal(sent[0].delegationInstructions, '送信せず下書きを作る');
  assert.equal(sent[0].description, '元の完了条件');
  const reloaded = new TaskStore(app.store.filePath);
  await reloaded.init();
  assert.equal(reloaded.get(task.id).delegationInstructions, '送信せず下書きを作る');
});

test('manual start and reset preserve work without calling xangi, including after reload', async context => {
  const noCalls = async () => { assert.fail('manual status changes must not contact xangi'); };
  const app = await startTestApp({ sendTask: noCalls, readSession: noCalls, completeSession: noCalls });
  context.after(app.close);
  const task = await app.store.create({ title: '自分で進める' });
  const action = name => jsonRequest(app.baseUrl, `/api/tasks/${task.id}/${name}`, { method: 'POST', body: '{}' });
  assert.equal(taskPhase((await action('execution/start')).body.task), 'working');
  assert.equal(app.store.get(task.id).xangiSessionId, null);
  assert.equal(taskPhase((await action('execution/reset')).body.task), 'idle');
  await app.store.update(task.id, { ...phaseFields('review'), xangiSessionId: 'existing-session', result: '保存済みの成果', delegationInstructions: '追加指示' });
  assert.equal((await action('execution/reset')).response.status, 200);
  assert.equal((await action('execution/start')).response.status, 200);
  await app.app.syncRunningTasks();
  const reloaded = new TaskStore(app.store.filePath); await reloaded.init();
  const saved = reloaded.get(task.id);
  assert.equal(taskPhase(saved), 'working');
  assert.equal(saved.xangiSessionId, 'existing-session');
  assert.equal(saved.result, '保存済みの成果');
  assert.equal(saved.delegationInstructions, '追加指示');
  for (const status of ['inbox', 'delegating', 'running', 'completing', 'dismissed']) {
    await app.store.update(task.id, { ...phaseFields(status) });
    for (const name of ['execution/start', 'execution/reset']) {
      assert.equal((await action(name)).response.status, 400);
      assert.equal(taskPhase(app.store.get(task.id)), status);
    }
  }
});

test('accepts completion during a reply, persists it and closes only after idle', async (context) => {
  let busy = true;
  const app = await startTestApp({ completeSession: async () => {
    if (busy) throw Object.assign(new Error('Session is busy'), { status: 409 });
  } });
  context.after(app.close);
  const task = await app.store.create({ title: 'Finish after reply', repeat: { unit: 'day', interval: 1 }, dueDate: '2026-10-09' });
  await app.store.update(task.id, { ...phaseFields('running'), xangiSessionId: 'active-session' });
  const path = `/api/tasks/${task.id}/close`;
  const accepted = await jsonRequest(app.baseUrl, path, { method: 'POST' });
  assert.equal(accepted.response.status, 202);
  assert.equal(accepted.body.completionPending, true);
  assert.equal(taskPhase(accepted.body.task), 'completing');
  assert.equal(app.store.list().length, 1);
  assert.equal((await jsonRequest(app.baseUrl, path, { method: 'POST' })).response.status, 202);
  assert.equal((await jsonRequest(app.baseUrl, `/api/tasks/${task.id}`, { method: 'DELETE' })).response.status, 400);
  assert.equal((await jsonRequest(app.baseUrl, `/api/tasks/${task.id}/messages`, { method: 'POST', body: '{"text":"another reply"}' })).response.status, 400);

  // New store and server simulate an extension restart while the response is busy.
  const restored = new TaskStore(app.store.filePath);
  await restored.init();
  assert.equal(taskPhase(restored.get(task.id)), 'completing');
  const resumed = createTaskServer({ store: restored, connector: app.connector, publicDir, pollIntervalMs: 10, auth: { token: 'test-auth-token-with-at-least-32-characters' } });
  context.after(() => resumed.stopPoller());
  busy = false;
  resumed.startPoller();
  const deadline = Date.now() + 2000;
  while (restored.get(task.id).status !== 'closed' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(taskPhase(restored.get(task.id)), 'closed');
  assert.equal(restored.list().length, 2);
  assert.ok(restored.get(task.id).nextTaskId);
});

test('a stale in-flight sync cannot revert pending or completed tasks', async (context) => {
  let release;
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  const app = await startTestApp({ readSession: async () => {
    started();
    return new Promise(resolve => { release = resolve; });
  } });
  context.after(app.close);
  const task = await app.store.create({ title: 'Concurrent sync' });
  await app.store.update(task.id, { ...phaseFields('running'), xangiSessionId: 'session' });
  const sync = jsonRequest(app.baseUrl, `/api/tasks/${task.id}/sync`, { method: 'POST' });
  await entered;
  const done = await jsonRequest(app.baseUrl, `/api/tasks/${task.id}/close`, { method: 'POST' });
  assert.equal(taskPhase(done.body.task), 'closed');
  release({ state: 'idle', result: 'Old result' });
  await sync;
  assert.equal(taskPhase(app.store.get(task.id)), 'closed');
});

test('pending completion retains errors and retries without blocking other tasks', async (context) => {
  const app = await startTestApp({ completeSession: async () => { throw Object.assign(new Error('busy'), { status: 409 }); } });
  context.after(app.close);
  const task = await app.store.create({ title: 'Recover' });
  await app.store.update(task.id, { ...phaseFields('review'), xangiSessionId: 'session' });
  await jsonRequest(app.baseUrl, `/api/tasks/${task.id}/close`, { method: 'POST' });
  app.connector.completeSession = async () => { throw Object.assign(new Error('Unauthorized'), { status: 401 }); };
  const failed = await jsonRequest(app.baseUrl, `/api/tasks/${task.id}/sync`, { method: 'POST' });
  assert.equal(failed.response.status, 400);
  assert.equal(taskPhase(app.store.get(task.id)), 'completing');
  assert.match(app.store.get(task.id).error, /Unauthorized/);
  app.connector.completeSession = async () => ({ ok: true, lifecycle: 'closed' });
  await jsonRequest(app.baseUrl, `/api/tasks/${task.id}/sync`, { method: 'POST' });
  assert.equal(taskPhase(app.store.get(task.id)), 'closed');
});

test('concurrent completion requests close once and generate one successor', async (context) => {
  let release;
  let count = 0;
  const app = await startTestApp({ completeSession: async () => {
    count++;
    await new Promise(resolve => { release = resolve; });
  } });
  context.after(app.close);
  const task = await app.store.create({ title: 'Repeat', repeat: { unit: 'day', interval: 1 } });
  await app.store.update(task.id, { ...phaseFields('review'), xangiSessionId: 'session' });
  const path = `/api/tasks/${task.id}/close`;
  const first = jsonRequest(app.baseUrl, path, { method: 'POST' });
  while (!release) await new Promise(resolve => setTimeout(resolve, 1));
  const second = jsonRequest(app.baseUrl, path, { method: 'POST' });
  await new Promise(resolve => setTimeout(resolve, 20));
  release();
  const results = await Promise.all([first, second]);
  assert.ok(results.every(result => result.body.task.status === 'closed'));
  assert.equal(count, 1);
  assert.equal(app.store.list().length, 2);
});

test('a late follow-up error cannot undo completion', async (context) => {
  let fail;
  const app = await startTestApp({ sendMessage: async () => new Promise((_resolve, reject) => { fail = reject; }) });
  context.after(app.close);
  const task = await app.store.create({ title: 'Late error' });
  await app.store.update(task.id, { ...phaseFields('review'), xangiSessionId: 'session' });
  const message = jsonRequest(app.baseUrl, `/api/tasks/${task.id}/messages`, { method: 'POST', body: '{"text":"follow up"}' });
  while (!fail) await new Promise(resolve => setTimeout(resolve, 1));
  await jsonRequest(app.baseUrl, `/api/tasks/${task.id}/close`, { method: 'POST' });
  fail(new Error('late send failure'));
  assert.equal((await message).response.status, 400);
  assert.equal(taskPhase(app.store.get(task.id)), 'closed');
});


test('done can be reset with one request, preserving history and avoiding duplicate recurrence', async context => {
  const app = await startTestApp(); context.after(app.close);
  const task = await app.store.create({ title: 'Repeat', dueDate: '2030-01-31', repeat: { unit: 'month', interval: 1 } });
  await app.store.update(task.id, { ...phaseFields('review'), result: 'saved result', xangiSessionId: 'saved-session' });
  const action = name => jsonRequest(app.baseUrl, `/api/tasks/${task.id}/${name}`, { method: 'POST' });
  const done = await action('close');
  assert.equal(taskPhase(done.body.task), 'closed');
  const nextId = done.body.nextTask.id;
  const reset = await action('open');
  assert.equal(reset.response.status, 200);
  assert.equal(taskPhase(reset.body.task), 'idle');
  assert.equal(reset.body.task.completedAt, undefined);
  assert.equal(reset.body.task.result, 'saved result');
  assert.equal(reset.body.task.xangiSessionId, 'saved-session');
  const restored = new TaskStore(app.store.filePath); await restored.init();
  assert.equal(taskPhase(restored.get(task.id)), 'idle');
  const again = await action('close');
  assert.equal(again.body.nextTask, null);
  assert.equal(again.body.task.nextTaskId, nextId);
  assert.equal(app.store.list().length, 2);
  await app.store.remove(nextId);
  await action('open'); await action('close');
  assert.equal(app.store.list().length, 1);
});

test('quick metadata updates do not depend on renaming a completed xangi session', async context => {
  let renames = 0;
  const app = await startTestApp({ renameSession: async () => { renames++; throw new Error('offline'); } });
  context.after(app.close);
  const task = await app.store.create({ title: 'Existing', description: 'keep', labels: ['old'] });
  await app.store.update(task.id, { ...phaseFields('closed'), xangiSessionId: 'closed-session', result: 'keep result', titleSyncError: 'prior title warning' });
  const updated = await jsonRequest(app.baseUrl, `/api/tasks/${task.id}`, { method: 'PUT', body: JSON.stringify({ dueDate: '2030-03-20', labels: ['new'] }) });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.body.task.dueDate, '2030-03-20');
  assert.deepEqual(updated.body.task.labels, ['new']);
  assert.equal(updated.body.task.description, 'keep');
  assert.equal(updated.body.task.result, 'keep result');
  assert.equal(taskPhase(updated.body.task), 'closed');
  assert.equal(renames, 0);
  assert.equal(updated.body.task.titleSyncError, 'prior title warning');
  const invalid = await jsonRequest(app.baseUrl, `/api/tasks/${task.id}`, { method: 'PUT', body: JSON.stringify({ labels: ['x'.repeat(41)] }) });
  assert.equal(invalid.response.status, 400);
  assert.deepEqual(app.store.get(task.id).labels, ['new']);
});

test('agent choices validate before mutation and persist through native follow-up routing', async context => {
  const calls = [];
  const app = await startTestApp({
    listAgents: async () => [{ id: 'local', name: 'Local' }],
    sendTask: async task => { calls.push(task.agentId); return { sessionId: 'native' }; },
    sendMessage: async (...args) => { calls.push(args); },
  });
  context.after(app.close);
  const task = await app.store.create({ title: 'Agent test' });
  const choices = await jsonRequest(app.baseUrl, '/api/agents');
  assert.equal(choices.body.agents[0].id, 'local');
  for (const agentId of ['missing', {}, 123]) {
    const rejected = await jsonRequest(app.baseUrl, `/api/tasks/${task.id}/delegate`, { method: 'POST', body: JSON.stringify({ agentId }) });
    assert.equal(rejected.response.status, 400);
    assert.equal(taskPhase(app.store.get(task.id)), 'idle');
  }
  const sent = await jsonRequest(app.baseUrl, `/api/tasks/${task.id}/delegate`, { method: 'POST', body: JSON.stringify({ agentId: 'local' }) });
  assert.equal(sent.body.task.agentId, 'local');
  await app.store.update(task.id, { ...phaseFields('review') });
  await jsonRequest(app.baseUrl, `/api/tasks/${task.id}/messages`, { method: 'POST', body: JSON.stringify({ text: 'Follow up' }) });
  assert.deepEqual(calls, ['local', ['native', 'Follow up', 'local']]);
});

test('agent lookup failures do not change task state', async context => {
  const app = await startTestApp({ listAgents: async () => { throw new Error('offline'); } });
  context.after(app.close);
  const task = await app.store.create({ title: 'lookup failure' });
  const result = await jsonRequest(app.baseUrl, `/api/tasks/${task.id}/delegate`, { method: 'POST', body: JSON.stringify({ agentId: 'agent' }) });
  assert.equal(result.response.status, 400);
  assert.equal(taskPhase(app.store.get(task.id)), 'idle');
});

test('retry does not poll the previous session while creating the new agent session', async context => {
  let release;
  const app = await startTestApp({ listAgents: async () => [{ id: 'local' }], sendTask: () => new Promise(resolve => { release = resolve; }) });
  context.after(app.close);
  const task = await app.store.create({ title: 'retry' });
  await app.store.update(task.id, { ...phaseFields('failed'), xangiSessionId: 'old-session' });
  const request = jsonRequest(app.baseUrl, `/api/tasks/${task.id}/delegate`, { method: 'POST', body: JSON.stringify({ agentId: 'local' }) });
  while (!release) await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.store.get(task.id).xangiSessionId, null);
  await app.app.syncRunningTasks();
  assert.equal(taskPhase(app.store.get(task.id)), 'delegating');
  release({ sessionId: 'new-session' });
  assert.equal((await request).body.task.xangiSessionId, 'new-session');
});

test('resumes an existing conversation from todo and keeps other states protected', async context => {
  const app = await startTestApp();
  context.after(app.close);
  const task = await app.store.create({ title: 'Continue LT title discussion' });
  const post = () => jsonRequest(app.baseUrl, `/api/tasks/${task.id}/messages`, { method: 'POST', body: JSON.stringify({ text: 'この案の続きを考えて' }) });
  assert.equal((await post()).response.status, 400);
  await app.store.update(task.id, { xangiSessionId: 'existing-session', result: 'Earlier suggestion' });
  const reply = await post();
  assert.equal(reply.response.status, 202);
  assert.equal(taskPhase(reply.body.task), 'running');
  assert.deepEqual(app.followUps, [{ sessionId: 'existing-session', text: 'この案の続きを考えて' }]);
  assert.equal(app.store.get(task.id).result, 'Earlier suggestion');
  for (const status of ['running', 'delegating', 'completing', 'closed', 'inbox', 'dismissed']) {
    await app.store.update(task.id, { ...phaseFields(status) });
    assert.equal((await post()).response.status, 400, status);
  }
  assert.equal(app.followUps.length, 1);
});

test('personal notes save independently, survive partial edits, and validate without data loss', async context => {
  const app = await startTestApp();
  context.after(app.close);
  const created = await jsonRequest(app.baseUrl, '/api/tasks', { method: 'POST', body: JSON.stringify({ title: 'Notes', description: 'Goal', notes: 'Initial\nnotes' }) });
  assert.equal(created.response.status, 201);
  const path = `/api/tasks/${created.body.task.id}`;
  const edited = await jsonRequest(app.baseUrl, path, { method: 'PUT', body: JSON.stringify({ notes: 'Progress\nNext idea' }) });
  assert.equal(edited.response.status, 200);
  assert.equal(edited.body.task.description, 'Goal');
  const renamed = await jsonRequest(app.baseUrl, path, { method: 'PUT', body: JSON.stringify({ title: 'Renamed' }) });
  assert.equal(renamed.body.task.notes, 'Progress\nNext idea');
  const reloaded = new TaskStore(app.store.filePath);
  await reloaded.init();
  assert.equal(reloaded.get(created.body.task.id).notes, 'Progress\nNext idea');
  for (const notes of ['x'.repeat(10001), { text: 'invalid' }]) {
    const invalid = await jsonRequest(app.baseUrl, path, { method: 'PUT', body: JSON.stringify({ notes }) });
    assert.equal(invalid.response.status, 400);
    assert.equal(app.store.get(created.body.task.id).notes, 'Progress\nNext idea');
  }
  const cleared = await jsonRequest(app.baseUrl, path, { method: 'PUT', body: JSON.stringify({ notes: '' }) });
  assert.equal(cleared.body.task.notes, '');
  assert.equal(cleared.body.task.description, 'Goal');
});

test('category API creates, assigns, moves, rejects dangling references and deletes empty collections', async context => {
  const app = await startTestApp(); context.after(app.close);
  const folder = (await jsonRequest(app.baseUrl, '/api/folders', { method: 'POST', body: JSON.stringify({ name: 'Work' }) })).body.item;
  const category = (await jsonRequest(app.baseUrl, '/api/categories', { method: 'POST', body: JSON.stringify({ name: 'Project', folderId: folder.id }) })).body.item;
  const task = (await jsonRequest(app.baseUrl, '/api/tasks', { method: 'POST', body: JSON.stringify({ title: 'Test', categoryId: category.id }) })).body.task;
  assert.equal(task.categoryId, category.id);
  assert.equal((await jsonRequest(app.baseUrl, `/api/categories/${category.id}`, { method: 'DELETE' })).response.status, 400);
  assert.equal((await jsonRequest(app.baseUrl, `/api/tasks/${task.id}`, { method: 'PUT', body: JSON.stringify({ categoryId: 'bad' }) })).response.status, 400);
  await jsonRequest(app.baseUrl, `/api/tasks/${task.id}`, { method: 'PUT', body: JSON.stringify({ categoryId: '' }) });
  await jsonRequest(app.baseUrl, `/api/categories/${category.id}`, { method: 'DELETE' });
  await jsonRequest(app.baseUrl, `/api/folders/${folder.id}`, { method: 'DELETE' });
  assert.deepEqual((await jsonRequest(app.baseUrl, '/api/collections')).body, { folders: [], categories: [] });
});


test('task-only lookup skips xangi history even for a linked task', async context => {
  let reads = 0;
  const app = await startTestApp({ readHistory: async () => { reads++; throw new Error('offline'); } });
  context.after(app.close);
  const task = await app.store.create({ title: 'Task reference' });
  await app.store.update(task.id, { xangiSessionId: 'existing-session' });
  const result = await jsonRequest(app.baseUrl, `/api/tasks/${task.id}?history=0`);
  assert.equal(result.response.status, 200);
  assert.equal(result.body.task.id, task.id);
  assert.equal(result.body.historyError, '');
  assert.equal(reads, 0);
});

test('default agent settings persist and are used when delegation omits agentId', async context => {
  const calls = [];
  const app = await startTestApp({ listAgents: async () => [{ id: 'research', name: 'Research' }], sendTask: async task => { calls.push(task.agentId); return { sessionId: 'agent-session' }; } });
  context.after(app.close);
  assert.equal((await jsonRequest(app.baseUrl, '/api/settings')).body.agentId, '');
  for (const agentId of [null, 123, 'missing']) {
    assert.equal((await jsonRequest(app.baseUrl, '/api/settings', { method: 'PUT', body: JSON.stringify({ agentId }) })).response.status, 400);
  }
  assert.equal((await jsonRequest(app.baseUrl, '/api/settings', { method: 'PUT', body: '{"agentId":"research"}' })).response.status, 200);
  const reloaded = new TaskStore(app.store.filePath); await reloaded.init();
  assert.equal(reloaded.settingsGet().agentId, 'research');
  const task = await app.store.create({ title: 'Default routing' });
  assert.equal((await jsonRequest(app.baseUrl, `/api/tasks/${task.id}/delegate`, { method: 'POST', body: '{}' })).response.status, 202);
  assert.deepEqual(calls, ['research']);
  const explicit = await app.store.create({ title: 'Explicit default' });
  await jsonRequest(app.baseUrl, `/api/tasks/${explicit.id}/delegate`, { method: 'POST', body: '{"agentId":""}' });
  assert.deepEqual(calls, ['research', '']);
});

test('concurrent delegation is rejected before agent lookup finishes', async context => {
  let release;
  let announce;
  const started = new Promise(resolve => { announce = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  let sends = 0;
  const app = await startTestApp({ listAgents: async () => { announce(); await waiting; return [{ id: 'agent' }]; }, sendTask: async () => { sends++; return { sessionId: 'once' }; } });
  context.after(app.close);
  const task = await app.store.create({ title: 'Only once' });
  const first = jsonRequest(app.baseUrl, `/api/tasks/${task.id}/delegate`, { method: 'POST', body: '{"agentId":"agent"}' });
  await started;
  try {
    const second = await jsonRequest(app.baseUrl, `/api/tasks/${task.id}/delegate`, { method: 'POST', body: '{"agentId":"agent"}' });
    assert.equal(second.response.status, 400);
  } finally { release(); }
  assert.equal((await first).response.status, 202);
  assert.equal(sends, 1);
});

test('project defaults persist, dispatch uses them and completion leaves conversation open', async context => {
  const calls = [];
  const app = await startTestApp({
    listProjects: async () => [{ id: 'project', name: 'Work' }],
    dispatchTask: async task => { calls.push(task); return { sessionId: 'project-thread' }; },
    readTaskSession: async () => ({ state: 'idle' }),
  }); context.after(app.close);
  for (const projectId of [null, 123, 'missing']) {
    assert.equal((await jsonRequest(app.baseUrl, '/api/settings', { method: 'PUT', body: JSON.stringify({ projectId }) })).response.status, 400);
  }
  await jsonRequest(app.baseUrl, '/api/settings', { method: 'PUT', body: '{"projectId":"project"}' });
  const reloaded = new TaskStore(app.store.filePath); await reloaded.init();
  assert.equal(reloaded.settingsGet().projectId, 'project');
  const task = await app.store.create({ title: 'Project task' });
  const path = `/api/tasks/${task.id}`;
  assert.equal((await jsonRequest(app.baseUrl, path + '/delegate', { method: 'POST', body: '{}' })).response.status, 202);
  assert.equal(calls[0].projectId, 'project');
  await jsonRequest(app.baseUrl, path + '/sync', { method: 'POST', body: '{}' });
  assert.equal(taskPhase(app.store.get(task.id)), 'review');
  await jsonRequest(app.baseUrl, path + '/close', { method: 'POST', body: '{}' });
  assert.equal(taskPhase(app.store.get(task.id)), 'closed');
  assert.deepEqual(app.completions, []);
  app.connector.dispatchTask = async () => { throw new Error('busy'); };
  assert.equal((await jsonRequest(app.baseUrl, path + '/delegate', { method: 'POST', body: '{}' })).response.status, 400);
  assert.equal(app.store.get(task.id).xangiSessionId, 'project-thread');
});

test('acknowledges before execution finishes, prevents duplicates and preserves agent completion', async context => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let sends = 0;
  const app = await startTestApp({
    baseUrl: 'http://localhost:18888',
    dispatchTask: async (task, ready) => {
      await ready({ sessionId: 'slow-thread' });
      sends++;
      await held;
      return { sessionId: 'slow-thread' };
    },
    readTaskSession: async () => ({ state: 'idle' }),
  });
  context.after(app.close);
  const task = await app.store.create({ title: 'Slow work' });
  const path = `/api/tasks/${task.id}`;
  try {
    const { response, body } = await jsonRequest(app.baseUrl, path + '/delegate', { method: 'POST', body: '{}' });
    assert.equal(response.status, 202);
    assert.equal(body.task.xangiSessionId, 'slow-thread');
    assert.equal(body.xangiOrigin, 'http://localhost:18888');
    const reloaded = new TaskStore(app.store.filePath); await reloaded.init();
    assert.equal(reloaded.get(task.id).xangiSessionId, 'slow-thread');
    assert.equal((await jsonRequest(app.baseUrl, path + '/delegate', { method: 'POST', body: '{}' })).response.status, 400);
    await app.app.syncRunningTasks();
    assert.equal(taskPhase(app.store.get(task.id)), 'running');
    assert.equal(taskPhase((await jsonRequest(app.baseUrl, path + '/close', { method: 'POST', body: '{}' })).body.task), 'closed');
  } finally { release(); }
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(taskPhase(app.store.get(task.id)), 'closed');
  assert.equal(sends, 1);
});

for (const [status, expected] of [[409, 'failed'], [503, 'review'], [undefined, 'review']]) {
  test(`records a late ${status || 'network'} error without retrying or losing the conversation`, async context => {
    let release;
    const held = new Promise(resolve => { release = resolve; });
    let sends = 0;
    const app = await startTestApp({ dispatchTask: async (task, ready) => {
      await ready({ sessionId: 'saved-thread' }); sends++;
      await held;
      throw Object.assign(new Error('send failed'), { status });
    }});
    context.after(app.close);
    const task = await app.store.create({ title: 'Work' });
    const reply = await jsonRequest(app.baseUrl, `/api/tasks/${task.id}/delegate`, { method: 'POST', body: '{}' });
    assert.equal(reply.response.status, 202);
    release();
    for (let i = 0; i < 100 && app.store.get(task.id).executionStatus === 'running'; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(taskPhase(app.store.get(task.id)), expected);
    assert.equal(app.store.get(task.id).xangiSessionId, 'saved-thread');
    assert.match(app.store.get(task.id).error, /send failed/);
    assert.equal(sends, 1);
  });
}

test('a late delivery error cannot undo completion', async context => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const app = await startTestApp({ dispatchTask: async (task, ready) => {
    await ready({ sessionId: 'saved-thread' });
    await held;
    throw new Error('connection lost');
  }});
  context.after(app.close);
  const task = await app.store.create({ title: 'Work' });
  const path = `/api/tasks/${task.id}`;
  await jsonRequest(app.baseUrl, path + '/delegate', { method: 'POST', body: '{}' });
  await jsonRequest(app.baseUrl, path + '/close', { method: 'POST', body: '{}' });
  release();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(taskPhase(app.store.get(task.id)), 'closed');
  assert.equal(app.store.get(task.id).error, '');
});

test('API exposes canonical Inbox/Open/Closed and rejects removed operation names', async context => {
  const app=await startTestApp();context.after(app.close);
  const inbox=await jsonRequest(app.baseUrl,'/api/inbox',{method:'POST',body:JSON.stringify({title:'Inbox test',sourceText:'Please handle this'})});
  assert.equal(inbox.body.task.status,'inbox');assert.equal(inbox.body.task.executionStatus,'idle');
  const path='/api/tasks/'+inbox.body.task.id;
  const opened=await jsonRequest(app.baseUrl,path+'/open',{method:'POST'});
  assert.equal(opened.body.task.status,'open');assert.equal(opened.body.task.executionStatus,'idle');
  const started=await jsonRequest(app.baseUrl,path+'/execution/start',{method:'POST'});
  assert.equal(started.body.task.status,'open');assert.equal(started.body.task.executionStatus,'working');
  const closed=await jsonRequest(app.baseUrl,path+'/close',{method:'POST'});
  assert.equal(closed.body.task.status,'closed');assert.equal(closed.body.task.closedReason,'completed');
  for(const operation of ['confirm','complete','reject','start','reset']) assert.equal((await jsonRequest(app.baseUrl,path+'/'+operation,{method:'POST'})).response.status,404);
  assert.equal((await jsonRequest(app.baseUrl,'/api/candidates',{method:'POST',body:'{}'})).response.status,404);
  assert.equal((await jsonRequest(app.baseUrl,'/api/inbox')).body.tasks.length,0);
});
