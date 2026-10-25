import { taskPhase, phaseFields } from '../public/task-state.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nextDueDate, normalizeRepeat } from '../src/recurrence.js';
import { TaskStore, editableFields } from '../src/task-store.js';
const rule = (unit, interval=1, daysOfWeek=[]) => ({unit, interval, daysOfWeek});
test('calendar recurrence handles weekends, custom weeks, month ends and leap years', () => {
  assert.equal(nextDueDate(rule('weekdays'), '2026-10-09','2026-10-09','2026-10-09'), '2026-10-12');
  assert.equal(nextDueDate(rule('week',2,[1,3]), '2026-10-05','2026-10-07','2026-10-07'), '2026-10-19');
  assert.equal(nextDueDate(rule('week',2,[1,3]), '2026-10-05','2026-10-19','2026-10-19'), '2026-10-21');
  assert.equal(nextDueDate(rule('month'), '2026-01-31','2026-01-31','2026-01-31'), '2026-02-28');
  assert.equal(nextDueDate(rule('month'), '2026-01-31','2026-02-28','2026-02-28'), '2026-03-31');
  assert.equal(nextDueDate(rule('year'), '2024-02-29','2027-02-28','2027-02-28'), '2028-02-29');
  assert.equal(nextDueDate(rule('day',3), '2026-10-01','2026-10-01','2026-10-09'), '2026-10-10');
  assert.equal(nextDueDate(rule('day'), '2026-10-12','2026-10-12','2026-10-07'), '2026-10-13');
});
test('invalid recurrence rejected and disabling recurrence is explicit', () => {
  for (const bad of [false, [], {}, rule('hour'), rule('day',0), rule('day',1.5), rule('day',1000), rule('week',1,[7])]) assert.throws(()=>normalizeRepeat(bad));
  assert.equal(editableFields({repeat:null},{title:'Task',repeat:rule('day')}).repeat,null);
});
test('completion atomically persists one fresh occurrence even on concurrent repeat requests and reload', async()=>{
  const file=join(await mkdtemp(join(tmpdir(),'tasks-repeat-')),'tasks.json');
  const store=new TaskStore(file); await store.init();
  const t=await store.create({title:'Monthly',description:'Context',notes:'This occurrence only',labels:['仕事'],dueDate:'2026-01-31',repeat:rule('month')});
  await store.update(t.id,{...phaseFields('review'),result:'old result',xangiSessionId:'old-session'});
  await Promise.all([store.complete(t.id,'2026-01-31'),store.complete(t.id,'2026-01-31')]);
  const reload=new TaskStore(file); await reload.init();
  assert.equal(reload.list().length,2);
  const next=reload.get(reload.get(t.id).nextTaskId);
  assert.equal(reload.get(t.id).notes,'This occurrence only'); assert.equal(next.notes || '', '');
  assert.equal(next.dueDate,'2026-02-28'); assert.equal(taskPhase(next),'idle');
  assert.equal(next.xangiSessionId,null); assert.equal(next.result,''); assert.deepEqual(next.labels,['仕事']);
  const third=(await reload.complete(next.id,'2026-02-28')).nextTask;
  assert.equal(third.dueDate,'2026-03-31');
  await reload.remove(third.id);
  await reload.complete(next.id,'2026-02-28');
  assert.equal(reload.list().length,2); // Deleted next occurrence must not be recreated.
});
test('changing the schedule resets anchor; disabling it stops future occurrences',async()=>{
  const store=new TaskStore(join(await mkdtemp(join(tmpdir(),'tasks-repeat-')),'tasks.json')); await store.init();
  const t=await store.create({title:'Edit',dueDate:'2026-01-31',repeat:rule('month')});
  const next=(await store.complete(t.id,'2026-01-31')).nextTask;
  await store.update(next.id,editableFields({dueDate:'2026-02-20'},next));
  const third=(await store.complete(next.id,'2026-02-20')).nextTask;
  assert.equal(third.dueDate,'2026-03-20');
  await store.update(third.id,editableFields({repeat:null},third));
  assert.equal((await store.complete(third.id,'2026-03-20')).nextTask,null);
});
test('failed persistence rolls completion back and retry creates exactly one successor',async()=>{
  const file=join(await mkdtemp(join(tmpdir(),'tasks-repeat-')),'tasks.json');
  const store=new TaskStore(file); await store.init();
  const task=await store.create({title:'Retry',dueDate:'2026-10-07',repeat:rule('day')});
  store.filePath=join(file,'missing','tasks.json');
  await assert.rejects(()=>store.complete(task.id,'2026-10-07'));
  assert.equal(taskPhase(store.get(task.id)),'idle'); assert.equal(store.list().length,1);
  store.filePath=file;
  await store.complete(task.id,'2026-10-07');
  assert.equal(store.list().length,2);
});
