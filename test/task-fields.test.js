import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TaskStore,validateBackup} from '../src/task-store.js';

test('tasks persist and export without labels; unsupported labels are rejected',async()=>{
 const file=join(await mkdtemp(join(tmpdir(),'remove-labels-')),'tasks.json');
 const store=new TaskStore(file);await store.init();
 const category=await store.saveCollection('categories',{name:'Work'});
 const task=await store.create({title:'Keep',categoryId:category.id,notes:'Keep notes',targetDate:'2030-01-31',repeat:{unit:'month',interval:1}});
 await writeFile(file,JSON.stringify([{...task,labels:['unsupported']}]));
 await assert.rejects(new TaskStore(file).init(),/Unsupported field: labels/);
 await writeFile(file,JSON.stringify([task]));
 const fresh=new TaskStore(file);await fresh.init();await fresh.update(task.id,{notes:'Edited'});
 const snapshot=await fresh.backupSnapshot();assert.equal(Object.hasOwn(snapshot.tasks[0],'labels'),false);
 const invalid=structuredClone(snapshot);invalid.tasks[0].labels=[];assert.throws(()=>validateBackup(invalid));
 await assert.rejects(fresh.update(task.id,{labels:['again']}));
 assert.equal(Object.hasOwn(JSON.parse(await readFile(file,'utf8'))[0],'labels'),false);
});
