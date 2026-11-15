import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('update fails before preparing dependencies unless persistent storage is verified', () => {
  const env = { ...process.env, XANGI_TASKS_DATA: '' };
  let result = spawnSync('./scripts/prepare-update', [], { env, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /absolute persistent/);
  const dir = mkdtempSync(join(process.cwd(), '.update-fixture-'));
  try {
    const file = join(dir, 'data.json');
    writeFileSync(file, JSON.stringify({ dataDir: dir }));
    result = spawnSync('./scripts/prepare-update', [], { env: { ...env, XANGI_TASKS_DATA: file }, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /outside the updated source/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
