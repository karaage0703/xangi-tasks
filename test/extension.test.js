import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

const token = 'managed-test-secret-with-32-characters';
async function start(t, dir, extra = {}) {
  const child = spawn('./scripts/xangi-extension', ['serve', '--workspace', dir], {
    env: { ...process.env, XANGI_EXTENSION_AUTH_TOKEN: token, XANGI_EXTENSION_HOST_URL: 'http://127.0.0.1:9', XANGI_TASKS_DATA: join(dir, 'tasks.json'), PORT: '1', ...extra },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let errors = ''; child.stderr.on('data', c => { errors += c; });
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
  const ready = await new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('Readiness timeout: ' + errors)), 5000);
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Early exit ${code}: ${errors}`)); });
    child.stdout.on('data', c => { output += c; if (output.includes('\n')) { clearTimeout(timeout); resolve(JSON.parse(output.split('\n')[0])); } });
  });
  const request = (path, method = 'GET', body) => fetch(ready.baseUrl + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { child, ready, request };
}

test('managed process serves data itself, authenticates UI, and persists across stdin shutdown/restart', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tasks-managed-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const host = createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ version: 'managed-host' })); });
  await new Promise(resolve => host.listen(0, '127.0.0.1', resolve));
  t.after(() => { host.closeAllConnections(); host.close(); });
  const a = await start(t, dir, { XANGI_URL: '', XANGI_EXTENSION_HOST_URL: `http://127.0.0.1:${host.address().port}` });
  assert.equal((await (await a.request('/api/health')).json()).xangi.version, 'managed-host');
  assert.equal((await fetch(a.ready.baseUrl + '/api/tasks', { method: 'POST', body: '{"title":"unauthorized"}' })).status, 401);
  assert.equal(a.ready.workspace, dir); assert.equal(a.ready.id, 'xangi-tasks'); assert.equal(a.ready.event, 'ready');
  assert.notEqual(new URL(a.ready.baseUrl).port, '1');
  for (const path of ['/', '/api/tasks', '/api/export', '/api/auth/login']) assert.equal((await fetch(a.ready.baseUrl + path)).status, 401);
  const html = await (await a.request('/')).text();
  assert.match(html, /<script type="module">/); assert.doesNotMatch(html, /src="app.js"|managed-test-secret/);
  const task = (await (await a.request('/api/tasks', 'POST', { title: 'Persisted task' })).json()).task;
  const exited = once(a.child, 'exit'); a.child.stdin.end(); assert.deepEqual(await exited, [0, null]);
  assert.equal(JSON.parse(await readFile(join(dir, 'tasks.json'), 'utf8'))[0].id, task.id);
  const b = await start(t, dir);
  assert.equal((await (await b.request('/api/tasks')).json()).tasks[0].id, task.id);
  assert.equal((await b.request(`/api/tasks/${task.id}/delete`, 'POST')).status, 200);
  assert.equal((await (await b.request('/api/tasks')).json()).tasks.length, 0);
  const stopped = once(b.child, 'exit'); b.child.kill('SIGTERM'); assert.deepEqual(await stopped, [0, null]);
});

test('entrypoint requires xangi launch context', () => {
  const direct = spawnSync(process.execPath, ['src/server.js'], { encoding: 'utf8' });
  assert.notEqual(direct.status, 0); assert.match(direct.stderr, /Start xangi-tasks from xangi Extensions/);
  const missing = spawnSync('./scripts/xangi-extension', ['serve'], { env: { ...process.env, XANGI_EXTENSION_AUTH_TOKEN: '' }, encoding: 'utf8' });
  assert.notEqual(missing.status, 0); assert.match(missing.stderr, /XANGI_EXTENSION_AUTH_TOKEN is required/);
  assert.doesNotMatch(missing.stdout, /"event":"ready"/);
});
