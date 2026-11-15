import { build } from 'esbuild';
import { readFile, writeFile, readdir } from 'node:fs/promises';
const result = await build({ entryPoints: ['src/ui/description-editor.js'], outfile: 'public/editor.bundle.js', bundle: true, minify: true, format: 'iife', globalName: 'TasksDescriptionEditor', footer: { js: 'globalThis.TasksDescriptionEditor = TasksDescriptionEditor;' }, target: 'es2022', metafile: true, legalComments: 'inline', define: { 'process.env.NODE_ENV': '"production"' } });
const packages = [...new Set(Object.keys(result.metafile.inputs).map(path => path.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/)?.[1]).filter(Boolean))].sort();
const notices = [];
for (const name of packages) {
  const directory = `node_modules/${name}`;
  const pkg = JSON.parse(await readFile(`${directory}/package.json`, 'utf8'));
  const files = (await readdir(directory)).filter(file => /^(license|copying|notice)(\.|$)/i.test(file));
  if (!files.length) throw new Error(`Missing license text for bundled dependency ${name}`);
  notices.push(`\n=== ${name}@${pkg.version} (${pkg.license || 'see below'}) ===\n`);
  for (const file of files) notices.push(await readFile(`${directory}/${file}`, 'utf8'));
}
await writeFile('public/editor-licenses.txt', notices.join('\n'));
console.log(`Bundled Tiptap and retained license texts for ${packages.length} packages.`);
