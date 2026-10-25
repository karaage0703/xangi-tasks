import { access, readFile } from 'node:fs/promises';

const required = ['public/index.html', 'public/styles.css', 'public/app.js', 'public/task-state.js'];
for (const path of required) await access(path);
const html = await readFile('public/index.html', 'utf8');
if (!html.includes('<title>xangi-tasks</title>')) throw new Error('Unexpected page title');
console.log('Static application assets verified.');
