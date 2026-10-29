import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TaskStore,validateBackup} from '../src/task-store.js';
import {removeTaskLabels} from '../scripts/remove-task-labels.js';

test('one-time removal preserves all other data and labels never reappear in persistence or export',async()=>{
 const file=join(await mkdtemp(join(tmpdir(),'remove-labels-')),'tasks.json');
 const store=new TaskStore(file);await store.init();
 const category=await store.saveCollection('categories',{name:'Work'});
 const task=await store.create({title:'Keep',categoryId:category.id,notes:'Keep notes',dueDate:'2030-01-31',repeat:{unit:'month',interval:1}});
 const old=[{...task,labels:['remove']}];
 await writeFile(file,JSON.stringify(old));
 await assert.rejects(new TaskStore(file).init(),/Remove labels/);
 const clean=removeTaskLabels(old);assert.deepEqual(clean,[task]);assert.deepEqual(old[0].labels,['remove']);
 await writeFile(file,JSON.stringify(clean));
 const fresh=new TaskStore(file);await fresh.init();await fresh.update(task.id,{notes:'Edited'});
 const snapshot=await fresh.backupSnapshot();assert.equal(Object.hasOwn(snapshot.tasks[0],'labels'),false);
 const legacy=structuredClone(snapshot);legacy.tasks[0].labels=[];assert.throws(()=>validateBackup(legacy));
 await assert.rejects(fresh.update(task.id,{labels:['again']}));
 assert.equal(Object.hasOwn(JSON.parse(await readFile(file,'utf8'))[0],'labels'),false);
});
