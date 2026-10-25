import assert from 'node:assert/strict';
import test from 'node:test';
import { createTaskServer } from '../src/app.js';
import { createAuth } from '../src/auth.js';

const token = 'extension-secret-with-at-least-32-characters';
async function fixture(t) {
  let writes = 0;
  const app = createTaskServer({
    auth: { token }, publicDir: new URL('../public', import.meta.url).pathname,
    store: { list: () => [{ id: 'private-task' }], create: async () => { writes++; return { id: 'new' }; } },
    connector: { health: async () => ({ version: 'test' }) },
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => { app.server.closeAllConnections(); app.server.close(); });
  return { url: `http://127.0.0.1:${app.server.address().port}`, writes: () => writes };
}

test('extension token is required for UI, assets, reads and writes', async t => {
  const { url, writes } = await fixture(t);
  for (const path of ['/', '/app.js', '/api/tasks', '/api/health', '/api/export']) {
    for (const headers of [{}, { Authorization: 'Bearer wrong' }, { Cookie: 'xangi_tasks=anything', 'Tailscale-User-Login': 'owner@example.com' }]) assert.equal((await fetch(url + path, { headers })).status, 401);
  }
  for (const method of ['POST', 'PUT', 'DELETE']) assert.equal((await fetch(url + '/api/tasks', { method, body: '{}' })).status, 401);
  assert.equal(writes(), 0);
  const headers = { Authorization: `Bearer ${token}` };
  const page = await fetch(url + '/', { headers }); assert.equal(page.status, 200);
  const html = await page.text(); assert.doesNotMatch(html, /extension-secret|api\/auth\/login/);
  assert.equal((await fetch(url + '/api/tasks', { headers })).status, 200);
  assert.equal((await fetch(url + '/api/tasks', { method: 'POST', headers, body: '{}' })).status, 201);
  assert.equal(writes(), 1);
});

test('there is no application login or logout API', async t => {
  const { url } = await fixture(t);
  for (const path of ['/api/auth/login', '/api/auth/logout']) {
    const response = await fetch(url + path, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ token }) });
    assert.equal(response.status, 404); assert.equal(response.headers.get('set-cookie'), null);
  }
});

test('missing or malformed extension credentials fail closed', () => {
  for (const token of [undefined, '', 'short']) assert.throws(() => createAuth({ token }), /32 characters/);
});
