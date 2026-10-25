import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from '../src/task-store.js';
import { phaseFields, validateTaskState } from '../public/task-state.js';
import { convertTaskData } from '../scripts/convert-task-state.js';

test('canonical state separates lifecycle from execution and rejects inconsistent data', () => {
  for (const phase of ['inbox','idle','working','delegating','running','review','completing','failed','closed','dismissed']) {
    const fields = phaseFields(phase); validateTaskState(fields);
    assert.ok(['inbox','open','closed'].includes(fields.status));
  }
  for (const state of [{ status:'todo' }, {status:'open',executionStatus:'idle',closedReason:'completed'}, {status:'closed',executionStatus:'running',closedReason:'completed'}]) assert.throws(()=>validateTaskState(state));
});

test('Inbox, execution, close, dismiss and reopen survive persistence without old status names', async () => {
  const file=join(await mkdtemp(join(tmpdir(),'task-state-')),'tasks.json');const store=new TaskStore(file);await store.init();
  const item=await store.createInboxItem({title:'Review source',sourceText:'A concrete request',sourceKey:'unique-source'});
  assert.deepEqual([item.status,item.executionStatus,item.closedReason],['inbox','idle',null]);
  await store.transition(item.id,'open');await store.setManualStatus(item.id,'working');
  assert.deepEqual([store.get(item.id).status,store.get(item.id).executionStatus],['open','working']);
  await store.complete(item.id);assert.equal(store.get(item.id).status,'closed');
  await store.transition(item.id,'open');assert.equal(store.get(item.id).executionStatus,'idle');
  const discarded=await store.createInboxItem({title:'Not needed',sourceText:'Resolved request',sourceKey:'discarded'});
  await store.transition(discarded.id,'dismiss');
  const reload=new TaskStore(file);await reload.init();
  assert.equal(reload.get(discarded.id).closedReason,'dismissed');
  assert.equal(reload.get(discarded.id).status,'closed');
  const retry=await reload.createInboxItem({title:'Retry',sourceText:'Resolved request',sourceKey:'discarded'});
  assert.equal(retry.id,discarded.id);assert.equal(retry.closedReason,'dismissed');
  await reload.transition(discarded.id,'open');assert.equal(reload.get(discarded.id).closedReason,null);
  assert.ok(JSON.parse(await readFile(file,'utf8')).every(task=>['inbox','open','closed'].includes(task.status)));
});

test('conversion preserves every record and metadata; startup rejects unconverted data without writing', async () => {
  const states=['candidate','todo','delegating','running','completing','review','done','failed','rejected'];
  const input=states.map((status,i)=>({id:String(i),status,title:'Keep',source:{key:'source-'+i},...(i===8?{deletedAt:'2026-01-01T00:00:00Z'}:{})}));
  input[4].completionOriginStatus='done';
  const snapshot=structuredClone(input),converted=convertTaskData(input);
  assert.deepEqual(input,snapshot);assert.equal(converted.length,input.length);
  for(let i=0;i<input.length;i++){assert.equal(converted[i].id,input[i].id);assert.deepEqual(converted[i].source,input[i].source);validateTaskState(converted[i]);}
  assert.equal(converted[4].completionOriginPhase,'closed');assert.equal(converted[8].deletedAt,input[8].deletedAt);
  assert.equal(convertTaskData({format:'xangi-tasks-backup',version:1,tasks:input,settings:{agentId:''}}).version,2);
  assert.throws(()=>convertTaskData([{id:'bad',status:'unknown'}]));
  const file=join(await mkdtemp(join(tmpdir(),'old-state-')),'tasks.json');const original=JSON.stringify(input);await writeFile(file,original);
  await assert.rejects(new TaskStore(file).init(),/convert old task data/);assert.equal(await readFile(file,'utf8'),original);
});
