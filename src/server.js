import { NotionClient } from './notion.js';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTaskServer } from './app.js';
import { TaskStore } from './task-store.js';
import { XangiConnector } from './xangi-connector.js';

const rootDir = resolve(fileURLToPath(new URL('..', import.meta.url)));
if (process.argv[2] !== 'serve') throw new Error('Start xangi-tasks from xangi Extensions');
const at = process.argv.indexOf('--workspace');
const workspace = resolve(at >= 0 ? process.argv[at + 1] : process.cwd());
const token = process.env.XANGI_EXTENSION_AUTH_TOKEN;
if (!token || token.length < 32) throw new Error('XANGI_EXTENSION_AUTH_TOKEN is required');
const baseUrl = process.env.XANGI_URL || process.env.XANGI_EXTENSION_HOST_URL;
if (!baseUrl) throw new Error('xangi host URL is required');
const store = new TaskStore(resolve(rootDir, process.env.XANGI_TASKS_DATA || '.data/tasks.json'));
await store.init();

const connector = new XangiConnector({
  baseUrl,
  token: process.env.XANGI_TOKEN || process.env.XANGI_EVEN_TERMINAL_TOKEN || '',
  provider: process.env.XANGI_PROVIDER || 'codex',
});
const app = createTaskServer({
  auth: { token },
  store,
  notion: new NotionClient({ keyFile: process.env.XANGI_TASKS_NOTION_KEY_FILE || undefined }),
  connector,
  publicDir: resolve(rootDir, 'public'),
  pollIntervalMs: Number(process.env.XANGI_TASKS_POLL_MS || 3000),
});
app.startPoller();
app.server.listen(0, '127.0.0.1', () => {
  const baseUrl = `http://127.0.0.1:${app.server.address().port}`;
  console.log(JSON.stringify({ schemaVersion: 2, event: 'ready', id: 'xangi-tasks', workspace, baseUrl }));
});
const stop = () => {
  app.stopPoller();
  app.server.close(() => { process.stdin.pause(); });
  app.server.closeIdleConnections();
};
process.stdin.resume(); process.stdin.on('end', stop);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop);
