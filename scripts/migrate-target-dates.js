import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { validDate } from '../public/task-dates.js';

// One-time conversion, kept outside the application so it only handles two date concepts.
export function migrateTargetDates(input) {
  const result = structuredClone(input);
  const tasks = Array.isArray(result) ? result : result?.format === 'xangi-tasks-backup' ? result.tasks : null;
  if (!Array.isArray(tasks)) throw new Error('タスク配列またはExportファイルを指定してください');
  for (const task of tasks) {
    if (!task || typeof task !== 'object' || Array.isArray(task)) throw new Error('タスクの形式が不正です');
    const goal = task.targetDate || task.dueDate || '';
    if (goal !== '' && !validDate(goal)) throw new Error('旧日付または目標日が不正です');
    task.targetDate = goal;
    delete task.dueDate;
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , source, destination] = process.argv;
  if (!source || !destination) throw new Error('Usage: node scripts/migrate-target-dates.js <source.json> <new.json>');
  const data = migrateTargetDates(JSON.parse(await readFile(source, 'utf8')));
  await writeFile(destination, JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log('旧日付を目標日へ変換しました。元ファイルは変更していません。');
}
