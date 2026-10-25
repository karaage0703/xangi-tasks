import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

// Standalone fake xangi used by browser E2E checks.

const sessions = new Map();
function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://fake-xangi.local');
  if (url.pathname === '/api/info') {
    json(res, 200, { version: 'fake-xangi-e2e' });
    return;
  }
  if (url.pathname === '/api/prompt' && req.method === 'POST') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const sessionId = body.sessionId || randomUUID();
    const session = sessions.get(sessionId) || { state: 'idle', messages: [], history: [], nextId: 1 };
    session.state = 'busy';
    session.history.push({ role: 'user', text: body.text });
    sessions.set(sessionId, session);
    setTimeout(() => {
      const reply = body.sessionId
        ? `Fake xangi continued the same session: ${body.text}`
        : 'Fake xangi completed the task end to end.';
      session.state = 'idle';
      session.messages.push({ id: session.nextId++, type: 'result', success: true, text: reply });
      session.history.push({ role: 'assistant', text: reply });
    }, 800);
    json(res, 202, { ok: true, sessionId });
    return;
  }
  if (url.pathname === '/api/messages') {
    const session = sessions.get(url.searchParams.get('sessionId')) || { state: 'idle', messages: [] };
    json(res, 200, { ...session, sessionId: url.searchParams.get('sessionId') });
    return;
  }
  const renameMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (renameMatch && req.method === 'PATCH') {
    const session = sessions.get(decodeURIComponent(renameMatch[1]));
    if (!session) return json(res, 404, { error: 'session not found' });
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    session.title = JSON.parse(Buffer.concat(chunks).toString()).title;
    return json(res, 200, { ok: true });
  }
  const closeMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/close$/);
  if (closeMatch && req.method === 'POST') {
    const session = sessions.get(decodeURIComponent(closeMatch[1]));
    if (!session) return json(res, 404, { error: 'session not found' });
    if (session.state === 'busy') return json(res, 409, { error: 'Session is busy' });
    session.lifecycle = 'closed';
    return json(res, 200, { ok: true, lifecycle: 'closed' });
  }
  const historyMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/history$/);
  if (historyMatch) {
    const session = sessions.get(decodeURIComponent(historyMatch[1]));
    json(res, 200, { history: session?.history || [] });
    return;
  }
  json(res, 404, { error: 'Not found' });
});

server.listen(Number(process.env.FAKE_XANGI_PORT || 4188), '127.0.0.1', () => {
  console.log(`[fake-xangi] Listening on http://127.0.0.1:${process.env.FAKE_XANGI_PORT || 4188}`);
});
