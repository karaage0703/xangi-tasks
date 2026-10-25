import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { phaseFields, validateTaskState } from '../public/task-state.js';

const phases = { candidate: 'inbox', todo: 'idle', delegating: 'delegating', running: 'running', completing: 'completing', review: 'review', done: 'closed', failed: 'failed', rejected: 'dismissed' };
export function convertTaskData(input) {
  const data = structuredClone(input);
  const tasks = Array.isArray(data) ? data : data?.format === 'xangi-tasks-backup' && data.version === 1 && Array.isArray(data.tasks) ? data.tasks : null;
  if (!tasks) throw new Error('Expected a task array or version 1 export');
  const ids = new Set();
  for (const task of tasks) {
    if (!task || typeof task.id !== 'string' || ids.has(task.id)) throw new Error('Invalid or duplicate task ID');
    ids.add(task.id);
    if (!Object.hasOwn(phases, task.status)) throw new Error('Unknown source task state');
    Object.assign(task, phaseFields(phases[task.status]));
    if (task.completionOriginStatus) {
      if (!Object.hasOwn(phases, task.completionOriginStatus)) throw new Error('Unknown completion origin');
      task.completionOriginPhase = phases[task.completionOriginStatus];
      delete task.completionOriginStatus;
    }
    validateTaskState(task);
  }
  if (!Array.isArray(data)) data.version = 2;
  return data;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output || input === '--help') {
    console.log('Usage: node scripts/convert-task-state.js <old-tasks-or-export.json> <new-file.json>\nWrites a new file only. Stop xangi-tasks and back up its data before replacing the data file.');
    if (input !== '--help') process.exitCode = 1;
  } else {
    if (resolve(input) === resolve(output)) throw new Error('Output must be a new file');
    const data = convertTaskData(JSON.parse(await readFile(input, 'utf8')));
    await writeFile(output, JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify({ output, tasks: (Array.isArray(data) ? data : data.tasks).length }));
  }
}
