import assert from 'node:assert/strict';
import test from 'node:test';
import { XangiConnector } from '../src/xangi-connector.js';

test('delegates a task with bearer auth and reads the result', async () => {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url, init });
    if (url.endsWith('/api/prompt')) return new Response(JSON.stringify({ sessionId: 'web-123' }), { status: 202 });
    if (url.includes('/history?')) {
      return new Response(
        JSON.stringify({ history: [{ role: 'user', text: 'First request' }, { role: 'assistant', text: 'Finished.' }] }),
        { status: 200 }
      );
    }
    return new Response(
      JSON.stringify({ state: 'idle', messages: [{ id: 1, type: 'result', success: true, text: 'Finished.' }] }),
      { status: 200 }
    );
  };
  const connector = new XangiConnector({ baseUrl: 'http://xangi.test/', token: 'secret', fetchImpl });
  const sent = await connector.sendTask({ id: 'task-1', title: 'Test task', description: 'Do the work', notes: 'Personal draft not for the agent' });
  const progress = await connector.readSession(sent.sessionId);
  await connector.sendMessage(sent.sessionId, 'Add one detail');
  const history = await connector.readHistory(sent.sessionId);

  assert.equal(sent.sessionId, 'web-123');
  const renamed = requests.find(r => r.init.method === 'PATCH');
  assert.equal(renamed.url, 'http://xangi.test/api/sessions/web-123');
  assert.deepEqual(JSON.parse(renamed.init.body), { title: 'Test task' });
  assert.deepEqual(progress, { state: 'idle', result: 'Finished.', error: '' });
  assert.deepEqual(history, [
    { role: 'user', text: 'First request' },
    { role: 'assistant', text: 'Finished.' },
  ]);
  assert.equal(requests[0].init.headers.get('Authorization'), 'Bearer secret');
  const payload = JSON.parse(requests[0].init.body);
  assert.match(payload.text, /Task ID: task-1/);
  assert.match(payload.text, /^Test task/);
  assert.doesNotMatch(payload.text, /Personal draft not for the agent/);
  const followUpPayload = JSON.parse(requests.find(r => r.url.endsWith('/api/prompt') && JSON.parse(r.init.body).sessionId).init.body);
  assert.deepEqual(followUpPayload, { text: 'Add one detail', provider: 'codex', sessionId: 'web-123' });
});

test('surfaces xangi errors', async () => {
  const connector = new XangiConnector({
    baseUrl: 'http://xangi.test',
    fetchImpl: async () => new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
  });
  await assert.rejects(() => connector.health(), /Unauthorized/);
});

test('closes the exact session without force and checks confirmation', async () => {
  const connector = new XangiConnector({ baseUrl: 'http://xangi.test', token: 'secret', fetchImpl: async (url, init) => {
    assert.equal(url, 'http://xangi.test/api/sessions/web%2F123/close');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.get('Authorization'), 'Bearer secret');
    assert.deepEqual(JSON.parse(init.body), { force: false });
    return new Response(JSON.stringify({ ok: true, lifecycle: 'closed' }));
  } });
  await connector.completeSession('web/123');
  connector.fetchImpl = async () => new Response(JSON.stringify({ ok: true }));
  await assert.rejects(() => connector.completeSession('web/123'), /did not confirm/);
  connector.fetchImpl = async () => new Response(JSON.stringify({ error: 'busy' }), { status: 409 });
  await assert.rejects(() => connector.completeSession('web/123'), /busy/);
});

test('title failure retains the created session to avoid duplicate delegation', async () => {
  const connector=new XangiConnector({baseUrl:'http://xangi.test',fetchImpl:async(url)=>url.endsWith('/api/prompt')?new Response('{"sessionId":"keep"}'):new Response('{"error":"offline"}',{status:503})});
  const sent=await connector.sendTask({id:'t',title:'Task'});
  assert.equal(sent.sessionId,'keep');
  assert.match(sent.titleError,/offline/);
});

test('includes optional delegation instructions alongside the task context', async () => {
  const prompts = [];
  const connector = new XangiConnector({ baseUrl: 'http://xangi.test', fetchImpl: async (url, init) => {
    if (url.endsWith('/api/prompt')) prompts.push(JSON.parse(init.body).text);
    return new Response(JSON.stringify({ sessionId: 'test' }));
  } });
  await connector.sendTask({ id: 't', title: '調査', description: '完了条件', delegationInstructions: '送信しない' });
  assert.match(prompts[0], /Description:\n完了条件/);
  assert.match(prompts[0], /今回の追加指示:\n送信しない/);
  await connector.sendTask({ id: 't', title: '調査' });
  assert.doesNotMatch(prompts[1], /今回の追加指示/);
});

test('preserves close HTTP status so only busy conflicts can be deferred', async () => {
  for (const status of [409, 401, 500]) {
    const connector = new XangiConnector({ baseUrl: 'http://xangi.test', fetchImpl: async (_url, init) => {
      assert.deepEqual(JSON.parse(init.body), { force: false });
      return new Response(JSON.stringify({ error: 'close failed' }), { status });
    } });
    await assert.rejects(() => connector.completeSession('session'), error => error.status === status);
  }
});

test('registered agent creates a native session and preserves it for follow-ups', async () => {
  const requests = [];
  const connector = new XangiConnector({ baseUrl: 'http://xangi.test', fetchImpl: async (url, init = {}) => {
    requests.push({ url, body: init.body && JSON.parse(init.body) });
    if (url.endsWith('/api/agents')) return Response.json({ agents: [{ id: 'local', name: 'Local', backend: 'local-llm', model: 'test', prompt: 'private' }] });
    if (url.endsWith('/api/sessions')) return Response.json({ sessionId: 'native' });
    if (url.endsWith('/api/chat')) return new Response('event: done\ndata: {"response":"完了"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
    return Response.json({});
  }});
  assert.deepEqual(await connector.listAgents(), [{ id: 'local', name: 'Local', backend: 'local-llm', model: 'test' }]);
  const sent = await connector.sendTask({ id: 'task', title: '仕事', agentId: 'local', delegationInstructions: '確認して' });
  assert.equal(sent.sessionId, 'native');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await connector.readSession('native', 'local')).result, '完了');
  await connector.sendMessage('native', '補足', 'local');
  assert.deepEqual(requests.find(r => r.url.endsWith('/api/sessions')).body, { agentId: 'local' });
  assert.match(requests.find(r => r.url.endsWith('/api/chat')).body.message, /確認して/);
  assert.deepEqual(requests.filter(r => r.url.endsWith('/api/chat')).at(-1).body, { appSessionId: 'native', message: '補足' });
  assert.equal(requests.some(r => r.url.endsWith('/api/prompt')), false);
});

test('registered session recovers persisted results after connector restart', async () => {
  let active = true;
  const connector = new XangiConnector({ baseUrl: 'http://xangi.test', fetchImpl: async url => {
    assert.match(url, /\/api\/sessions\/native\?limit=/);
    return Response.json({ isActive: active, messages: [{ role: 'user', content: '仕事' }, { role: 'assistant', content: '保存済み結果' }] });
  }});
  assert.equal((await connector.readSession('native', 'local')).result, '');
  active = false;
  assert.equal((await connector.readSession('native', 'local')).result, '保存済み結果');
  assert.equal((await connector.readHistory('native', 50, 'local')).at(-1).text, '保存済み結果');
});

test('missing agents never create or send a session; failed sends retain session id', async () => {
  const requests = [];
  let agents = [];
  const connector = new XangiConnector({ baseUrl: 'http://xangi.test', fetchImpl: async url => {
    requests.push(url);
    if (url.endsWith('/api/agents')) return Response.json({ agents });
    if (url.endsWith('/api/sessions')) return Response.json({ sessionId: 'keep-native' });
    return Response.json({ error: 'offline' }, { status: 503 });
  }});
  await assert.rejects(connector.sendTask({ id: 'task', title: '仕事', agentId: 'gone' }), /見つかりません/);
  assert.equal(requests.length, 1);
  agents = [{ id: 'gone', name: 'Agent' }];
  await assert.rejects(connector.sendTask({ id: 'task', title: '仕事', agentId: 'gone' }), error => error.sessionId === 'keep-native');
});

test('stream errors and missing completion are surfaced to task polling', async () => {
  for (const stream of ['event: error\ndata: {"error":"実行失敗"}\n\n', 'event: comment\ndata: {}\n\n']) {
    const connector = new XangiConnector({ baseUrl: 'http://xangi.test', fetchImpl: async () => new Response(stream) });
    await connector.sendAgentMessage('session', '仕事');
    await new Promise(resolve => setImmediate(resolve));
    assert.ok((await connector.readSession('session', 'agent')).error);
  }
});

test('follow-up clears previous result while the request is still being accepted', async () => {
  let release;
  const connector = new XangiConnector({ baseUrl: 'http://xangi.test', fetchImpl: () => new Promise(resolve => { release = resolve; }) });
  connector.turns.set('native', { state: 'idle', result: 'old result', error: '' });
  const sending = connector.sendMessage('native', 'new input', 'agent');
  assert.deepEqual(await connector.readSession('native', 'agent'), { state: 'running', result: '', error: '' });
  release(new Response('event: done\ndata: {"response":"new result"}\n\n'));
  await sending;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await connector.readSession('native', 'agent')).result, 'new result');
});

test('task dispatch reuses open conversations and creates a new one after close', async () => {
  const requests = []; let closed = false;
  const connector = new XangiConnector({ baseUrl: 'http://xangi.test', fetchImpl: async (url, init = {}) => {
    requests.push({ url, body: init.body && JSON.parse(init.body) });
    if (url.includes('?limit=')) return Response.json({ lifecycle: closed ? 'closed' : 'open', platform: 'web', isActive: false });
    if (url.endsWith('/api/sessions')) return Response.json({ sessionId: 'new' });
    if (url.endsWith('/api/chat')) return new Response('event: done\ndata: {"response":"done"}\n\n');
    return Response.json({});
  }});
  const task = { id: 'task', title: 'Request', xangiSessionId: 'old', agentId: 'local' };
  assert.equal((await connector.dispatchTask(task)).sessionId, 'old');
  assert.equal(requests.some(r => r.url.endsWith('/api/sessions')), false);
  closed = true;
  assert.equal((await connector.dispatchTask(task)).sessionId, 'new');
  assert.deepEqual(requests.find(r => r.url.endsWith('/api/sessions')).body, { agentId: 'local' });
});

for (const platform of ['discord', 'slack']) test(`project dispatch uses ${platform} continuation once`, async () => {
  const requests = [];
  const connector = new XangiConnector({ baseUrl: 'http://xangi.test', fetchImpl: async (url, init = {}) => {
    requests.push({ url, body: init.body && JSON.parse(init.body) });
    if (url.endsWith('/api/projects')) return Response.json({ projects: [{ id: 'p', name: 'Project', channel: { platform, channelId: 'channel' } }] });
    if (url.endsWith('/api/sessions')) return Response.json({ sessionId: 'thread' });
    if (url.includes('?limit=')) return Response.json({ lifecycle: 'open', platform, isActive: false });
    return Response.json({ ok: true });
  }});
  const task = { id: 't', title: 'Request', projectId: 'p' };
  assert.equal((await connector.dispatchTask(task)).sessionId, 'thread');
  assert.equal(requests.filter(r => r.url.endsWith(`/${platform}-continue`)).length, 1);
  assert.equal(requests.some(r => r.url.endsWith('/api/chat')), false);
  await connector.dispatchTask({ ...task, xangiSessionId: 'thread', conversationProjectId: 'p' });
  assert.equal(requests.filter(r => r.url.endsWith('/api/sessions')).length, 1);
  assert.equal(requests.filter(r => r.url.endsWith(`/${platform}-continue`)).length, 2);
});

test('task dispatch rejects busy conversations and target changes without sending', async () => {
  let active = true;
  const connector = new XangiConnector({ baseUrl: 'http://xangi.test', fetchImpl: async (url, init = {}) => {
    assert.equal(init.method || 'GET', 'GET');
    assert.match(url, /\?limit=1$/);
    return Response.json({ lifecycle: 'open', platform: 'web', isActive: active });
  }});
  const task = { id: 't', title: 'Task', xangiSessionId: 'existing', agentId: 'new', conversationAgentId: 'old' };
  await assert.rejects(connector.dispatchTask(task), /処理中/);
  active = false;
  await assert.rejects(connector.dispatchTask(task), /先に現在の会話を閉じて/);
});

test('task polling reports stream failure and failed dispatch retains created conversation', async () => {
  const connector = new XangiConnector({ baseUrl: 'http://xangi.test', fetchImpl: async url => {
    if (url.endsWith('/api/sessions')) return Response.json({ sessionId: 'keep' });
    return Response.json({ error: 'offline' }, { status: 503 });
  }});
  await assert.rejects(connector.dispatchTask({ id: 't', title: 'Task' }), error => error.sessionId === 'keep');
  connector.fetchImpl = async () => new Response('event: error\ndata: {"error":"execution failed"}\n\n');
  await connector.sendAgentMessage('keep', 'Request');
  await new Promise(resolve => setImmediate(resolve));
  assert.match((await connector.readTaskSession('keep')).error, /execution failed/);
});

for (const platform of ['discord', 'slack']) test(`persists ${platform} session before sending and does not use the short request timeout`, async () => {
  let saved = false;
  const connector = new XangiConnector({ baseUrl: 'http://xangi.test', timeoutMs: 10, fetchImpl: async (url, init = {}) => {
    if (url.endsWith('/api/projects')) return Response.json({ projects: [{ id: 'p', channel: { platform } }] });
    if (url.endsWith('/api/sessions')) return Response.json({ sessionId: 'thread' });
    assert.ok(saved, 'session must be durably saved before sending');
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.ok(!init.signal?.aborted, 'AI execution must outlive the ordinary API timeout');
    return Response.json({ ok: true });
  }});
  await connector.dispatchTask({ id: 't', title: 'Request', projectId: 'p' }, async ({ sessionId }) => {
    assert.equal(sessionId, 'thread');
    await new Promise(resolve => setTimeout(resolve, 5));
    saved = true;
  });
});

test('does not send when saving the conversation fails', async () => {
  const connector = new XangiConnector({ baseUrl: 'http://xangi.test', fetchImpl: async url => {
    assert.ok(url.endsWith('/api/sessions'), 'must not start execution after persistence failed');
    return Response.json({ sessionId: 'retained' });
  }});
  await assert.rejects(connector.dispatchTask({ id: 't', title: 'Task' }, async () => { throw new Error('disk full'); }), error => {
    assert.equal(error.sessionId, 'retained');
    assert.equal(error.message, 'disk full');
    return true;
  });
});
