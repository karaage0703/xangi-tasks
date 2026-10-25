import { taskPhase, phaseFields } from '../public/task-state.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { TaskStore, validateBackup } from '../src/task-store.js';
import { createTaskServer } from '../src/app.js';

async function fixture() {
  const dir=await mkdtemp(join(tmpdir(),'tasks-transfer-'));
  const store=new TaskStore(join(dir,'tasks.json'));await store.init();
  const folder=await store.saveCollection('folders',{name:'Folder'});
  const category=await store.saveCollection('categories',{name:'Category',folderId:folder.id});
  await store.saveCollection('categories',{name:'Empty category'});
  const task=await store.create({title:'Todo',categoryId:category.id,notes:'latest',repeat:{unit:'week',interval:2,daysOfWeek:[1,3]},dueDate:'2026-10-26'});
  const candidate=await store.createInboxItem({title:'Candidate',sourceText:'evidence',sourceUrl:'https://example.com/',type:'waiting'});
  const done=await store.create({title:'Done'});await store.update(done.id,{...phaseFields('closed')});
  const deleted=await store.create({title:'Deleted'});await store.remove(deleted.id);
  return {store,dir,task,candidate,done};
}

test('export/import round trip restores tasks, settings and empty categories without Notion',async()=>{
  const {store,dir,task}=await fixture();
  const backup=await store.backupSnapshot();
  assert.equal(backup.tasks.length,3);
  assert.equal(backup.collections.categories.length,2);
  const queued=store.update(task.id,{notes:'queued'});
  assert.equal((await store.backupSnapshot()).tasks.find(t=>t.id===task.id).notes,'queued');await queued;
  await store.create({title:'new work'});
  const preview=await store.previewImport(backup);assert.equal(preview.currentTasks,4);
  await store.importSnapshot(backup,preview.token);
  const loaded=new TaskStore(store.filePath);await loaded.init();
  assert.deepEqual(loaded.list(),validateBackup(backup).tasks.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)));
  assert.deepEqual(loaded.collectionsList(),backup.collections);
  assert.deepEqual(loaded.settingsGet(),backup.settings);
  const backups=(await readdir(dir)).filter(f=>f.includes('.before-import-'));
  assert.equal(backups.length,1);assert.equal(JSON.parse(await readFile(join(dir,backups[0]),'utf8')).tasks.length,4);
  assert.ok(!(await readdir(dir)).some(f=>f.endsWith('.import.json')));
});

test('malformed, duplicate and dangling imports leave existing data intact',async()=>{
  const {store}=await fixture();const before=await store.backupSnapshot();
  for(const mutate of [
    d=>d.version=99, d=>d.tasks.push(d.tasks[0]),d=>d.tasks[0].status='invalid',
    d=>d.tasks[0].categoryId='missing',d=>d.collections.categories[0].folderId='missing',
    d=>d.tasks[0].labels='bad',d=>d.tasks[0].createdAt=null,d=>d.tasks[0].notes={},
    d=>d.tasks[0].source={url:'javascript:alert(1)'},d=>d.settings.token='secret',
  ]) {
    const invalid=structuredClone(before);mutate(invalid);
    await assert.rejects(store.previewImport(invalid));
  }
  assert.deepEqual((await store.backupSnapshot()).tasks,before.tasks);
});

test('confirmation binds both current state and file contents; active work is protected',async()=>{
  const {store,task}=await fixture();const backup=await store.backupSnapshot();
  let preview=await store.previewImport(backup);
  await store.update(task.id,{notes:'changed'});
  await assert.rejects(store.importSnapshot(backup,preview.token),/確認し直して/);
  preview=await store.previewImport(backup);
  const different=structuredClone(backup);different.tasks[0].title='different';
  await assert.rejects(store.importSnapshot(different,preview.token),/確認し直して/);
  await store.update(task.id,{...phaseFields('running')});
  preview=await store.previewImport(backup);
  await assert.rejects(store.importSnapshot(backup,preview.token),/実行中/);
});

test('imported running work becomes review and crash recovery completes all store files',async()=>{
  const {store,task}=await fixture();await store.update(task.id,{...phaseFields('completing')});
  const exported=await store.backupSnapshot();
  const normalized=validateBackup(exported);
  assert.equal(taskPhase(normalized.tasks.find(t=>t.id===task.id)),'review');
  // Simulate termination after durable journal commit, before sidecars are installed.
  await writeFile(store.filePath+'.import.json',JSON.stringify(normalized));
  await writeFile(store.filePath+'.collections.json','{}');
  const loaded=new TaskStore(store.filePath);await loaded.init();
  assert.deepEqual(loaded.collectionsList(),exported.collections);
  assert.equal(taskPhase(loaded.get(task.id)),'review');
  await loaded.update(task.id,{notes:'after recovery'});
  const again=new TaskStore(store.filePath);await again.init();
  assert.equal(again.get(task.id).notes,'after recovery');
});

test('authenticated export/import works through managed extension above 64KiB',async t=>{
  const {store}=await fixture();
  for(let i=0;i<9;i++)await store.create({title:`Large ${i}`,notes:'x'.repeat(10000)});
  const app=createTaskServer({store,connector:{},publicDir:resolve('public'),auth:{token:'t'.repeat(32)}});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  const direct=`http://127.0.0.1:${app.server.address().port}`;
  const bridge=createTaskServer({store,connector:{health:async()=>({})},publicDir:process.cwd()+'/public',auth:{token:'b'.repeat(32),}}).server;
  await new Promise(r=>bridge.listen(0,'127.0.0.1',r));
  t.after(()=>{bridge.closeAllConnections();bridge.close();app.server.closeAllConnections();app.server.close();});
  const base=`http://127.0.0.1:${bridge.address().port}`;
  const request=(path,body)=>fetch(base+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+'b'.repeat(32),'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  assert.equal((await fetch(direct+'/api/export')).status,401);
  const backup=await (await request('/api/export')).json();
  assert.ok(JSON.stringify(backup).length>65536);
  const preview=await (await request('/api/import/preview',{backup})).json();assert.ok(preview.token);
  assert.equal((await request('/api/import',{backup,token:preview.token})).status,200);
  assert.equal((await request('/api/import',{backup,token:'bad'})).status,400);
  assert.equal((await request('/api/notion/backup',{})).status,404);
});


test('a partial disk failure keeps the committed journal and blocks later writes until recovery',async()=>{
  const {store,dir}=await fixture();const backup=await store.backupSnapshot();
  backup.tasks[0].title='Imported';const preview=await store.previewImport(backup);
  const collections=store.filePath+'.collections.json';
  await rm(collections);await mkdir(collections);
  await assert.rejects(store.importSnapshot(backup,preview.token));
  assert.ok((await readdir(dir)).includes('tasks.json.import.json'));
  await assert.rejects(store.create({title:'Must not bypass incomplete import'}));
  await rm(collections,{recursive:true});
  const recovered=new TaskStore(store.filePath);await recovered.init();
  assert.ok(recovered.list().some(t=>t.title==='Imported'));
  assert.ok(!recovered.list().some(t=>t.title==='Must not bypass incomplete import'));
  assert.deepEqual(recovered.collectionsList(),backup.collections);
});
