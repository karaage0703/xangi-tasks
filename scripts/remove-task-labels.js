import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// One-time removal for stopped deployments; not a runtime compatibility layer.
export function removeTaskLabels(input) {
  if (!Array.isArray(input) || input.some(task => !task || typeof task !== 'object' || Array.isArray(task))) throw new Error('Expected a task array');
  return input.map(({ labels: _removed, ...task }) => task);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [input, output] = process.argv.slice(2);
  if (input === '--help') console.log('Usage: node scripts/remove-task-labels.js <tasks.json> <new-file.json>\nStop xangi-tasks before replacing its data. Writes a new file only; existing output is never overwritten.');
  else {
    if (!input || !output || resolve(input) === resolve(output)) throw new Error('Specify separate input and new output paths');
    const data = removeTaskLabels(JSON.parse(await readFile(input, 'utf8')));
    await writeFile(output, JSON.stringify(data, null, 2)+'\n', {flag:'wx',mode:0o600});
    console.log(JSON.stringify({tasks:data.length,output}));
  }
}
