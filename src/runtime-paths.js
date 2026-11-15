import { resolve } from 'node:path';

export function taskDataPath({ root, workspace, env = process.env }) {
  if (env.XANGI_TASKS_DATA) return resolve(root, env.XANGI_TASKS_DATA);
  const instance = (env.XANGI_EXTENSION_INSTANCE_ID || 'default').replace(/[^a-zA-Z0-9._-]/g, '-');
  return resolve(workspace, '.xangi-tasks', `instance-${instance}`, 'tasks.json');
}
