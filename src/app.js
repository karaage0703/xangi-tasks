import { taskPhase, phaseFields } from '../public/task-state.js';
import { renderExtensionHtml } from './extension.js';
import { MAX_FILE_BYTES, pageId } from './notion.js';
import { createAuth } from './auth.js';
import { editableFields } from './task-store.js';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function json(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

async function readJson(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('Request body is too large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('Invalid JSON');
  }
}

export function createTaskServer({ store, connector, publicDir, pollIntervalMs = 3000, auth, notion }) {
  const authenticate = createAuth(auth || {});
  let pollTimer;
  let syncing = false;
  const completions = new Map();
  const delegations = new Set();
  const notionBusy = new Set();
  let importing = false;
  let mutations = 0;

  function completeTask(id) {
    if (completions.has(id)) return completions.get(id);
    const operation = (async () => {
      const task = store.get(id);
      if (!task) throw new Error('Task not found');
      if (!['idle', 'working', 'running', 'review', 'completing', 'closed'].includes(taskPhase(task))) {
        throw new Error('この状態では完了にできません');
      }
      // Persist intent before calling xangi, so restart cannot lose an accepted request.
      await store.update(id, { ...phaseFields('completing'), completionOriginPhase: task.completionOriginPhase || taskPhase(task), error: '' });
      try {
        if (task.xangiSessionId && !task.conversationMode) await connector.completeSession(task.xangiSessionId);
        return await store.complete(id);
      } catch (error) {
        if (error.status === 409) return { task: store.get(id), nextTask: null, completionPending: true };
        await store.update(id, {
          ...phaseFields(taskPhase(task)),
          error: error.message,
        });
        throw error;
      }
    })().finally(() => completions.delete(id));
    completions.set(id, operation);
    return operation;
  }

  async function syncTask(task) {
    if (delegations.has(task.id)) return task;
    if (taskPhase(task) === 'completing') return (await completeTask(task.id)).task;
    if (!task.xangiSessionId || !['delegating', 'running'].includes(taskPhase(task))) return task;
    try {
      const progress = task.conversationMode && connector.readTaskSession ? await connector.readTaskSession(task.xangiSessionId) : await connector.readSession(task.xangiSessionId, task.agentId);
      if (progress.error) {
        return store.update(task.id, { ...phaseFields('failed'), error: progress.error }, ['delegating', 'running']);
      }
      if (progress.state === 'idle' && (task.conversationMode || progress.result)) {
        return store.update(task.id, { ...phaseFields('review'), result: task.conversationMode ? '' : progress.result, error: '' }, ['delegating', 'running']);
      }
      return store.update(task.id, { ...phaseFields('running') }, ['delegating', 'running']);
    } catch (error) {
      return store.update(task.id, { error: error.message }, ['delegating', 'running']);
    }
  }

  async function syncRunningTasks() {
    if (syncing || importing) return;
    syncing = true;
    try {
      const running = store.list().filter((task) => ['delegating', 'running', 'completing'].includes(taskPhase(task)));
      for (const task of running) {
        try { await syncTask(task); }
        catch (error) { console.error('[xangi-tasks] Task synchronization failed:', task.id, error.message); }
      }
    } finally {
      syncing = false;
    }
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://xangi-tasks.local');
    if (req.method === 'POST' && /^\/api\/tasks\/[^/]+\/delete$/.test(url.pathname)) {
      url.pathname = url.pathname.slice(0, -7); req.method = 'DELETE';
    }
    const mutation = ['POST', 'PUT', 'DELETE'].includes(req.method);
    if (mutation) mutations++;
    try {
      if (!await authenticate(req, res, url.pathname)) return;
      if (mutation && importing) throw new Error('Import中です。完了後に操作してください');
      if (req.method === 'GET' && url.pathname === '/api/health') {
        try {
          const info = await connector.health();
          json(res, 200, { ok: true, xangi: { connected: true, version: info.version || 'xangi' } });
        } catch (error) {
          json(res, 200, { ok: true, xangi: { connected: false, error: error.message } });
        }
        return;
      }

      if (url.pathname === '/api/export' && req.method === 'GET') {
        const snapshot = await store.backupSnapshot();
        json(res, 200, snapshot); return;
      }
      if (['/api/import/preview', '/api/import'].includes(url.pathname) && req.method === 'POST') {
        const input = await readJson(req, 21 * 1024 * 1024);
        if (url.pathname.endsWith('/preview')) {
          json(res, 200, await store.previewImport(input.backup)); return;
        }
        if (mutations !== 1 || syncing || delegations.size || completions.size || notionBusy.size) throw new Error('他の処理が実行中です。終了後にImportしてください');
        importing = true;
        try { json(res, 200, await store.importSnapshot(input.backup, input.token)); }
        finally { importing = false; }
        return;
      }

      if (url.pathname === '/api/settings/notion' && req.method === 'PUT') {
        const input = await readJson(req);
        if (typeof input.parent !== 'string') throw new Error('親ページのURLを入力してください');
        const parent = input.parent.trim() ? pageId(input.parent) : '';
        if (parent) {
          if (!notion) throw new Error('Notion連携が利用できません');
          await notion.getPage(parent);
        }
        json(res, 200, await store.saveSettings({ notionParentPageId: parent })); return;
      }

      if (url.pathname === '/api/settings' && req.method === 'GET') {
        json(res, 200, store.settingsGet()); return;
      }
      if (url.pathname === '/api/settings' && req.method === 'PUT') {
        const input = await readJson(req);
        const agentId = input.agentId === undefined ? store.settingsGet().agentId : input.agentId;
        const projectId = input.projectId === undefined ? store.settingsGet().projectId : input.projectId;
        if (typeof agentId !== 'string' || agentId.length > 200) throw new Error('エージェントの指定が不正です');
        if (agentId && !(await connector.listAgents()).some(agent => agent.id === agentId)) throw new Error('選択したエージェントが見つかりません。選び直してください');
        if (typeof projectId !== 'string' || projectId.length > 200) throw new Error('Projectの指定が不正です');
        if (projectId && !(await connector.listProjects()).some(p => p.id === projectId)) throw new Error('Projectが見つかりません');
        json(res, 200, await store.saveSettings({ agentId, projectId })); return;
      }

      if (req.method === 'GET' && url.pathname === '/api/projects') { json(res, 200, { projects: await connector.listProjects() }); return; }

      if (req.method === 'GET' && url.pathname === '/api/agents') {
        json(res, 200, { agents: await connector.listAgents() });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/collections') {
        json(res, 200, store.collectionsList()); return;
      }
      const collectionMatch = url.pathname.match(/^\/api\/(folders|categories)(?:\/([^/]+))?$/);
      if (collectionMatch) {
        const [, kind, id] = collectionMatch;
        if (req.method === 'POST' && !id || req.method === 'PUT' && id) {
          json(res, id ? 200 : 201, { item: await store.saveCollection(kind, await readJson(req), id) }); return;
        }
        if (req.method === 'DELETE' && id) {
          await store.removeCollection(kind, id); json(res, 200, { ok: true }); return;
        }
      }

      if (req.method === 'GET' && url.pathname === '/api/tasks') {
        json(res, 200, { tasks: store.list() });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/tasks') {
        const input = await readJson(req);
        if (Object.hasOwn(input, 'labels')) throw new Error('Unsupported field: labels');
        const task = await store.create(input);
        json(res, 201, { task });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/inbox/capabilities') {
        json(res, 200, { sourceKeys: true, statusModel: 2 });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/inbox') {
        json(res, 200, { tasks: store.list().filter(task => task.status === 'inbox') }); return;
      }

      if (req.method === 'POST' && url.pathname === '/api/inbox') {
        const input = await readJson(req);
        if (Object.hasOwn(input, 'labels')) throw new Error('Unsupported field: labels');
        const task = await store.createInboxItem(input);
        json(res, 201, { task });
        return;
      }

      const notionMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/notion(?:\/(files))?$/);
      if (notionMatch && ['POST', 'PUT'].includes(req.method)) {
        const [, id, action] = notionMatch;
        const task = store.get(id);
        if (!task) throw new Error('Task not found');
        if (!notion) throw new Error('Notion連携が利用できません');
        if (notionBusy.has(id)) throw new Error('Notionへの保存中です');
        notionBusy.add(id);
        try {
          if (!action) {
            const input = await readJson(req);
            if (req.method === 'PUT') {
              const page = await notion.getPage(input.page);
              json(res, 200, { task: await store.update(id, { notionPageId: page.id, notionPageUrl: page.url, notionCreating: false }) });
            } else if (task.notionPageId) json(res, 200, { task });
            else {
              const savedParent = store.settingsGet().notionParentPageId;
              if (!savedParent) throw new Error('設定画面でNotionの親ページを指定してください');
              const parent = pageId(savedParent);
              if (task.notionCreating) throw new Error('前回のページ作成結果が未確認です。Notionを確認し、作成済みページをリンクしてください');
              // Do not create another page after an ambiguous failure or process restart.
              await notion.getPage(parent);
              await store.update(id, { notionCreating: true });
              let page;
              try { page = await notion.createPage(parent, task); }
              catch (error) {
                if (error.definiteFailure) await store.update(id, { notionCreating: false });
                throw error;
              }
              json(res, 201, { task: await store.update(id, { notionPageId: page.id, notionPageUrl: page.url, notionCreating: false }) });
            }
          } else {
            if (req.method !== 'POST') throw new Error('POSTを指定してください');
            if (!task.notionPageId) throw new Error('先にNotionページを作成またはリンクしてください');
            const name = url.searchParams.get('name');
            const type = String(req.headers['content-type'] || 'application/octet-stream');
            const chunks = []; let size = 0;
            for await (const chunk of req) {
              size += chunk.length;
              if (size > MAX_FILE_BYTES) throw new Error('ファイルは20 MiB以下にしてください');
              chunks.push(chunk);
            }
            const bytes = Buffer.concat(chunks);
            const result = await notion.upload(task.notionPageId, name, bytes, type);
            const updated = await store.update(id, { notionLastSavedAt: new Date().toISOString() });
            json(res, 200, { ...result, task: updated });
          }
        } finally { notionBusy.delete(id); }
        return;
      }

      const detailMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
      if (req.method === 'PUT' && detailMatch) {
        const task = store.get(detailMatch[1]);
        if (!task) throw new Error('Task not found');
        const input = await readJson(req);
        const fields = editableFields(input, task);
        store.validateCategory(fields.categoryId);
        const rename = task.xangiSessionId && Object.hasOwn(input, 'title');
        if (rename) await connector.renameSession(task.xangiSessionId, fields.title);
        json(res, 200, { task: await store.update(task.id, { ...fields, ...(rename ? { titleSyncError: '' } : {}) }) });
        return;
      }
      if (req.method === 'DELETE' && detailMatch) {
        await store.remove(detailMatch[1]);
        json(res, 200, { ok: true });
        return;
      }
      if (req.method === 'GET' && detailMatch) {
        const task = store.get(detailMatch[1]);
        if (!task) {
          json(res, 404, { error: 'Task not found' });
          return;
        }
        let history = [];
        let historyError = '';
        if (task.xangiSessionId && url.searchParams.get('history') !== '0') {
          try {
            history = await connector.readHistory(task.xangiSessionId, 50, task.conversationMode ? 'native' : task.agentId);
          } catch (error) {
            historyError = error.message;
          }
        }
        json(res, 200, { task, history, historyError, xangiOrigin: connector.baseUrl ? new URL(connector.baseUrl).origin : null });
        return;
      }

      const messageMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/messages$/);
      if (req.method === 'POST' && messageMatch) {
        const id = messageMatch[1];
        const task = store.get(id);
        if (!task) {
          json(res, 404, { error: 'Task not found' });
          return;
        }
        if (!task.xangiSessionId) throw new Error('Delegate the task before sending a message');
        if (task.conversationMode) throw new Error('追加の相談はxangiの会話、またはタスクの再依頼から行ってください');
        if (!['idle', 'working', 'review', 'failed'].includes(taskPhase(task))) {
          throw new Error('Wait for xangi to finish before sending another message');
        }
        const body = await readJson(req);
        const text = String(body.text || '').trim();
        if (!text) throw new Error('Message is required');
        if (text.length > 4000) throw new Error('Message must be 4000 characters or fewer');
        const sending = await store.update(id, { ...phaseFields('running'), error: '' }, ['idle', 'working', 'review', 'failed']);
        if (taskPhase(sending) !== 'running') throw new Error('完了処理中のため補足を送れません');
        try {
          await connector.sendMessage(task.xangiSessionId, text, task.agentId);
          json(res, 202, { task: store.get(id) });
        } catch (error) {
          await store.update(id, { ...phaseFields('review'), error: error.message }, ['running']);
          throw error;
        }
        return;
      }

      const actionMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/(open|dismiss|delegate|sync|close|execution\/start|execution\/reset)$/);
      if (req.method === 'POST' && actionMatch) {
        const [, id, action] = actionMatch;
        const task = store.get(id);
        if (!task) {
          json(res, 404, { error: 'Task not found' });
          return;
        }
        if (action === 'open' || action === 'dismiss') {
          json(res, 200, { task: await store.transition(id, action) });
          return;
        }
        if (action === 'execution/start' || action === 'execution/reset') {
          json(res, 200, { task: await store.setManualStatus(id, action === 'execution/start' ? 'working' : 'idle') });
          return;
        }
        if (action === 'delegate') {
          if (delegations.has(id)) throw new Error('このタスクは送信中です');
          delegations.add(id);
          try {
            if (!['idle', 'working', 'review', 'failed', 'closed'].includes(taskPhase(task))) throw new Error('この状態では依頼できません');
            const body = await readJson(req);
            const instructions = body.instructions ?? '';
            const projectId = body.projectId ?? store.settingsGet().projectId;
            if (typeof projectId !== 'string' || projectId.length > 200) throw new Error('Projectの指定が不正です');
            if (projectId && !(await connector.listProjects()).some(p => p.id === projectId)) throw new Error('Projectが見つかりません');
            const agentId = projectId ? '' : body.agentId ?? store.settingsGet().agentId;
            if (typeof agentId !== 'string' || agentId.length > 200) throw new Error('エージェントの指定が不正です');
            if (agentId && !(await connector.listAgents()).some(agent => agent.id === agentId)) throw new Error('選択したエージェントが見つかりません。選び直してください');
            if (typeof instructions !== 'string' || instructions.length > 4000) throw new Error('追加指示は4000文字以内のテキストで入力してください');
            const delegatedTask = await store.update(id, { ...phaseFields('delegating'), xangiSessionId: null, result: '', error: '', delegationInstructions: instructions.trim(), agentId, projectId });
            let accepted = false;
            const accept = async ({ sessionId, titleError }) => {
              const saved = await store.update(id, { ...phaseFields('running'), xangiSessionId: sessionId, conversationMode: Boolean(connector.dispatchTask), conversationAgentId: agentId, conversationProjectId: projectId, titleSyncError: titleError || '' }, ['delegating']);
              // The saved session is sufficient to navigate. Keep the send lock until
              // execution responds so polling cannot mistake startup for completion.
              accepted = true;
              json(res, 202, { task: saved, xangiOrigin: connector.baseUrl ? new URL(connector.baseUrl).origin : null });
            };
            try {
              const sent = connector.dispatchTask
                ? await connector.dispatchTask({ ...delegatedTask, xangiSessionId: task.xangiSessionId, conversationAgentId: task.conversationAgentId ?? task.agentId }, accept)
                : await connector.sendTask(delegatedTask);
              if (!accepted) await accept(sent);
            } catch (error) {
              // An interrupted connection after acceptance is not evidence that the
              // request failed. Retain the conversation for manual confirmation;
              // never resend automatically or overwrite an agent's done state.
              const rejected = [400, 401, 403, 404, 409, 422].includes(error.status);
              await store.update(id, {
                ...phaseFields(accepted && !rejected ? 'review' : 'failed'),
                error: accepted && !rejected ? `依頼の結果を確認できませんでした。再依頼する前に会話を確認してください: ${error.message}` : error.message,
                ...(!accepted ? { xangiSessionId: error.sessionId || task.xangiSessionId || null, ...(error.sessionId ? { conversationMode: Boolean(connector.dispatchTask), conversationAgentId: agentId, conversationProjectId: projectId } : { agentId: task.agentId, projectId: task.projectId }) } : {}),
              }, ['delegating', 'running']);
              if (!accepted) throw error;
            }
            return;
          } finally { delegations.delete(id); }
        }
        if (action === 'sync') {
          json(res, 200, { task: await syncTask(task) });
          return;
        }
        const result = await completeTask(id);
        json(res, result.completionPending ? 202 : 200, result);
        return;
      }

      if (req.method !== 'GET') {
        json(res, 404, { error: 'Not found' });
        return;
      }

      if (['/', '/index.html'].includes(url.pathname)) {
        res.writeHead(200, { 'Content-Type': MIME_TYPES['.html'], 'Cache-Control': 'no-store' });
        res.end(await renderExtensionHtml(publicDir)); return;
      }
      const requested = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const safeRelative = normalize(requested).replace(/^(\.\.(\/|\\|$))+/, '');
      const filePath = join(publicDir, safeRelative);
      if (!filePath.startsWith(publicDir)) {
        res.writeHead(403).end();
        return;
      }
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) throw Object.assign(new Error('Not found'), { code: 'ENOENT' });
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[extname(filePath)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      createReadStream(filePath).pipe(res);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        json(res, 404, { error: 'Not found' });
        return;
      }
      json(res, error.message === 'Task not found' ? 404 : 400, { error: error.message || 'Request failed' });
    } finally { if (mutation) mutations--; }
  });

  return {
    server,
    syncRunningTasks,
    startPoller() {
      if (pollTimer) return;
      void syncRunningTasks();
      pollTimer = setInterval(() => void syncRunningTasks(), pollIntervalMs);
      pollTimer.unref();
    },
    stopPoller() {
      clearInterval(pollTimer);
      pollTimer = undefined;
    },
  };
}
