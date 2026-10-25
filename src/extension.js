import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export async function renderExtensionHtml(directory) {
  const publicDir = pathToFileURL(directory + '/');
  const [css, js, clipboard, taskState] = await Promise.all([
    readFile(new URL('styles.css', publicDir), 'utf8'),
    readFile(new URL('app.js', publicDir), 'utf8'),
    readFile(new URL('clipboard.js', publicDir), 'utf8'),
    readFile(new URL('task-state.js', publicDir), 'utf8'),
  ]);
  const html = (await readFile(new URL('index.html', publicDir), 'utf8'))
    .replace('<link rel="stylesheet" href="styles.css" />', () => `<style>${css}</style>`)
    .replace('<script defer src="clipboard.js"></script>', () => `<script>${clipboard}</script>`)
    .replace('<script type="module" src="app.js"></script>', () => `<script type="module">${js.replace("import { taskPhase } from './task-state.js';", taskState.replace(/^export /gm, '')).replace("await api(`/api/tasks/${id}`, { method: 'DELETE' })", "await api(`/api/tasks/${id}/delete`, { method: 'POST' })")}</script>`);
  return html;
}
