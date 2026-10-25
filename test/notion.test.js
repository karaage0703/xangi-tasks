import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { NotionClient, pageId, MAX_FILE_BYTES } from '../src/notion.js';
import { TaskStore } from '../src/task-store.js';
import { createTaskServer } from '../src/app.js';
const id = 'a'.repeat(32), parent = 'b'.repeat(32), uploadId = 'c'.repeat(32);

test('validates page references and rejects other URL hosts', () => {
  assert.equal(pageId(`https://www.notion.so/title-${id}?pvs=4`), id);
  assert.equal(pageId(`https://app.notion.com/p/${id}`), id);
  assert.equal(pageId(`https://app.notion.com/p/${id}?source=copy_link#section`), id);
  assert.equal(pageId('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), id);
  for (const input of ['javascript:alert(1)', 'https://evil.test/' + id, 'https://app.notion.com.evil.test/p/' + id, 'https://evilnotion.com/p/' + id, '../' + id, '', null]) assert.throws(() => pageId(input));
});

test('Notion client creates, uploads and attaches without forwarding credentials off-origin', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'notion-client-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const keyFile = join(dir, 'key'); await writeFile(keyFile, 'private-test-key');
  const requests = [];
  const client = new NotionClient({ keyFile, fetchImpl: async (url, options) => {
    requests.push({ url, options });
    assert.ok(url.startsWith('https://api.notion.com/v1/'));
    assert.equal(options.redirect, 'error');
    return new Response(JSON.stringify(url.endsWith('/pages') ? { id } : url.endsWith('/file_uploads') ? { id: uploadId } : url.endsWith('/send') ? { status: 'uploaded' } : { results: [{ id: 'block' }] }));
  } });
  assert.equal((await client.createPage(parent, { id: 'task', title: '日本語' })).id, id);
  assert.deepEqual(await client.upload(id, '資料.txt', Buffer.from('hello'), 'text/plain'), { blockId: 'block' });
  assert.equal(requests.length, 4);
  assert.equal(await requests[2].options.body.get('file').text(), 'hello');
  const block = JSON.parse(requests[3].options.body).children[0];
  assert.equal(block.file.file_upload.id, uploadId);
  await assert.rejects(client.upload(id, '../bad', Buffer.from('a')), /ファイル名/);
  await assert.rejects(client.upload(id, 'large', Buffer.alloc(MAX_FILE_BYTES + 1)), /20 MiB/);
  assert.equal(requests.length, 4);
});

test('task Notion API preserves links, saves files, and guards ambiguous page creation', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'notion-app-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new TaskStore(join(dir, 'tasks.json')); await store.init();
  const task = await store.create({ title: 'Test', notes: 'latest notes' });
  const saves = []; let creates = 0;
  const notion = {
    async getPage(value) { return { id: pageId(value), url: `https://www.notion.so/${pageId(value)}` }; },
    async createPage(selectedParent) { assert.equal(selectedParent, parent); creates++; return { id, url: `https://www.notion.so/${id}` }; },
    async upload(page, name, bytes, type) { saves.push({ page, name, bytes, type }); return { blockId: 'block' }; },
  };
  const app = createTaskServer({ store, notion, connector: {}, publicDir: resolve('public'), auth: { token: 't'.repeat(32) } });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  t.after(() => { app.server.closeAllConnections(); app.server.close(); });
  const url = `http://127.0.0.1:${app.server.address().port}/api/tasks/${task.id}/notion`;
  const request = (suffix = '', data = {}, method = 'POST') => fetch(url + suffix, { method, headers: { Authorization: `Bearer ${'t'.repeat(32)}`, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  assert.equal((await request('/backup')).status, 404);
  assert.equal((await request()).status, 400);
  const settingsUrl = new URL('/api/settings/notion', url);
  const saveSettings = value => fetch(settingsUrl, { method: 'PUT', headers: { Authorization: `Bearer ${'t'.repeat(32)}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ parent: value }) });
  assert.equal((await saveSettings('invalid')).status, 400);
  assert.equal((await saveSettings(`https://app.notion.com/p/${parent}`)).status, 200);
  assert.equal(store.settingsGet().notionParentPageId, parent);
  // Saving delegation preferences must not erase the Notion parent.
  await store.saveSettings({ agentId: '', projectId: '' });
  assert.equal(store.settingsGet().notionParentPageId, parent);
  assert.equal((await request()).status, 201);
  assert.equal((await request('', { parent })).status, 200);
  assert.equal(creates, 1);
  assert.equal((await request('/backup')).status, 404);
  const response = await fetch(url + '/files?name=test.txt', { method: 'POST', headers: { Authorization: `Bearer ${'t'.repeat(32)}`, 'Content-Type': 'text/plain' }, body: 'file contents' });
  assert.equal(response.status, 200); assert.equal(saves[0].bytes.toString(), 'file contents');
  const reloaded = new TaskStore(store.filePath); await reloaded.init(); assert.equal(reloaded.get(task.id).notionPageId, id); assert.equal(reloaded.settingsGet().notionParentPageId, parent);
  await store.update(task.id, { notionPageId: null });
  notion.createPage = async () => { creates++; throw new Error('ambiguous network failure'); };
  assert.equal((await request('', { parent })).status, 400);
  assert.equal((await request('', { parent })).status, 400); assert.equal(creates, 2);
  assert.equal((await request('', { page: id }, 'PUT')).status, 200);
  assert.equal(store.get(task.id).notionCreating, false);
  assert.equal((await saveSettings('')).status, 200);
  assert.equal(store.get(task.id).notionPageId, id);
  assert.equal((await request()).status, 200);
});
