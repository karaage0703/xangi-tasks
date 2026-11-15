import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { taskDataPath } from '../src/runtime-paths.js';

test('defaults separate instance data from source and preserve explicit destinations', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tasks-paths-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, 'source'), workspace = join(dir, 'workspace');
  const a = taskDataPath({ root, workspace, env: { XANGI_EXTENSION_INSTANCE_ID: 'a' } });
  const b = taskDataPath({ root, workspace, env: { XANGI_EXTENSION_INSTANCE_ID: 'b' } });
  assert.ok(a.startsWith(workspace + '/'));
  assert.notEqual(a, b);
  assert.equal(taskDataPath({ root, workspace, env: { XANGI_TASKS_DATA: '/custom/tasks.json' } }), '/custom/tasks.json');
});
