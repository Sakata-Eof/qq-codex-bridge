import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {History} from '../src/history/store.mjs';
import {TaskStore} from '../src/history/task-store.mjs';

function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-task-store-'));
  const config={appId:'test',users:[{id:'A'},{id:'B'}]};let now='2026-10-16T10:00:00.000Z';
  const history=new History(config,root),tasks=new TaskStore(history,{clock:()=>now});
  t.after(()=>{history.close();fs.rmSync(root,{recursive:true,force:true});});
  return {root,config,history,tasks,time:value=>{now=value;},event:(id='m1',extra={})=>({id,user:'A',chat:'A',group:false,text:'执行任务',...extra})};
}

test('task tables can be added to an existing history without changing messages or replaying tasks',t=>{
  const f=fixture(t);f.history.record('A',{kind:'inbound',text:'OLD_MESSAGE',messageId:'old',threadId:'thread-old'});
  const messages=f.history.read('A'),sessions=f.history.sessions('A');
  const reopened=new TaskStore(f.history);assert.equal(reopened.recoverPending(),0);assert.deepEqual(reopened.list('A'),[]);
  assert.deepEqual(f.history.read('A'),messages);assert.deepEqual(f.history.sessions('A'),sessions);
  assert.equal(fs.existsSync(path.join(f.root,'history.sqlite')),true);
});

test('source receipts are durable and isolated by account, chat and group',t=>{
  const f=fixture(t),original=f.event('same'),a=f.tasks.ensure('A',original);
  assert.equal(original.taskId,a.id);assert.equal(f.tasks.ensure('A',f.event('same')).id,a.id);
  const other=f.tasks.ensure('B',f.event('same',{user:'B',chat:'B'}));
  const chat=f.tasks.ensure('A',f.event('same',{chat:'other',group:true}));
  const group=f.tasks.ensure('A',f.event('same',{chat:'A',group:true}));
  assert.equal(new Set([a.id,other.id,chat.id,group.id]).size,4);
  assert.equal(new TaskStore(f.history).ensure('A',f.event('same')).id,a.id);
  assert.deepEqual(f.tasks.get('A',a.id).sourceIds,['same']);assert.equal(f.tasks.get('A',a.id).eventCount,1);
  assert.equal(f.tasks.get('B',a.id),null);assert.equal(f.tasks.record('B',a.id,{stage:'running'}),null);
});

test('one batch shares a task and records the earliest receipt only once',t=>{
  const f=fixture(t),first=f.event('first',{receivedAt:'2026-10-16T09:59:59.000Z'}),task=f.tasks.ensure('A',first);
  const second=f.event('second',{taskId:task.id}),combined={...second,text:'第一条\n第二条',sourceEvents:[first,second]};
  const result=f.tasks.ensure('A',combined);
  assert.equal(combined.taskId,task.id);assert.equal(second.taskId,task.id);assert.deepEqual(result.sourceIds,['first','second']);
  assert.equal(result.createdAt,'2026-10-16T09:59:59.000Z');assert.equal(result.eventCount,1);assert.equal(f.tasks.list('A').length,1);
  const unsaved=[f.event('third',{receivedAt:'2026-10-16T09:00:00Z'}),f.event('fourth',{receivedAt:'2026-10-16T08:00:00Z'})];
  const fresh=f.tasks.ensure('A',{...unsaved[1],sourceEvents:unsaved});
  assert.equal(fresh.createdAt,'2026-10-16T08:00:00.000Z');assert.equal(unsaved[0].taskId,unsaved[1].taskId);
});

test('unknown accounts, foreign task ids and mixed-context sources cannot allocate or rebind tasks',t=>{
  const f=fixture(t),a=f.tasks.ensure('A',f.event()),b=f.tasks.ensure('B',f.event('b',{user:'B',chat:'B'}));
  for(const event of [f.event('x',{taskId:b.id}),f.event('x',{taskId:'unknown'}),f.event('x',{taskId:a.id,chat:'group',group:true}),f.event('x',{sourceEvents:[f.event('y',{user:'B'})]})])assert.throws(()=>f.tasks.ensure('A',event),/任务/);
  assert.throws(()=>f.tasks.ensure('foreign',f.event('x',{user:'foreign'})),/未配置/);
  const separate=f.tasks.ensure('A',f.event('different'));
  assert.throws(()=>f.tasks.ensure('A',{...f.event(),sourceEvents:[f.event(),f.event('different',{taskId:separate.id})]}),/不同任务/);
  assert.deepEqual(f.tasks.get('A',a.id).sourceIds,['m1']);assert.equal(f.tasks.list('A').length,2);
});

test('task titles and journal diagnostics are bounded and do not retain raw errors or model responses',t=>{
  const f=fixture(t),task=f.tasks.ensure('A',f.event('m1',{text:'/codex '+ '甲'.repeat(100),raw:{secret:'PRIVATE_TOKEN'}}));
  assert.equal(task.title.length,80);assert.equal(task.title.startsWith('/codex'),false);
  f.tasks.record('A',task.id,{stage:'failed',label:'PRIVATE_ERROR',code:'PRIVATE_TOKEN',raw:{secret:'PRIVATE_MODEL_RESPONSE'}});
  const detail=f.tasks.get('A',task.id);assert.equal(detail.events.at(-1).label,'处理失败');assert.equal(detail.events.at(-1).code,'');
  const payload=JSON.stringify({tasks:f.history.db.prepare('SELECT * FROM tasks').all(),events:f.history.db.prepare('SELECT * FROM task_events').all()});
  for(const secret of ['PRIVATE_TOKEN','PRIVATE_ERROR','PRIVATE_MODEL_RESPONSE'])assert.equal(payload.includes(secret),false);
  assert.throws(()=>f.tasks.record('A',task.id,{stage:'arbitrary'}),/阶段/);
  assert.throws(()=>f.tasks.record('A',task.id,{stage:'running',deliveryStatus:'arbitrary'}),/投递状态/);
});

test('timeline ordering is stable under clock rollback and repeated stage notifications are suppressed',t=>{
  const f=fixture(t),task=f.tasks.ensure('A',f.event());
  f.tasks.record('A',task.id,{stage:'running',threadId:'thread-1',turnId:'turn-1'});
  f.time('2026-10-16T09:00:00Z');f.tasks.record('A',task.id,{stage:'waiting_approval'});
  f.tasks.record('A',task.id,{stage:'waiting_approval'});f.tasks.record('A',task.id,{stage:'running'});
  const detail=f.tasks.get('A',task.id);assert.deepEqual(detail.events.map(event=>event.stage),['received','running','waiting_approval','running']);
  assert.deepEqual(detail.events.map(event=>event.time),[...detail.events.map(event=>event.time)].sort());
  assert.equal(detail.threadId,'thread-1');assert.equal(detail.turnId,'turn-1');
  assert.deepEqual(f.tasks.get('A',task.id,{limit:2}).events.map(event=>event.stage),['waiting_approval','running']);assert.equal(detail.eventCount,4);
});

test('duplicate observations perform no SQLite writes or write transactions while meaningful changes remain recorded',t=>{
  const f=fixture(t),task=f.tasks.ensure('A',f.event()),entry={stage:'running',threadId:'thread-1',turnId:'turn-1',code:'model_changing',label:'执行中'};
  f.tasks.record('A',task.id,entry);const before=f.tasks.get('A',task.id),changes=()=>f.history.db.prepare('SELECT total_changes() AS count').get().count;
  const initialChanges=changes(),transaction=f.history.transaction.bind(f.history);let transactions=0;
  f.history.transaction=fn=>{transactions++;return transaction(fn);};
  f.time('2026-10-16T11:00:00Z');
  for(let i=0;i<100;i++)f.tasks.record('A',task.id,entry);
  assert.equal(changes(),initialChanges);assert.equal(transactions,0);assert.deepEqual(f.tasks.get('A',task.id),before);
  f.tasks.record('A',task.id,{...entry,turnId:'turn-2'});
  assert.ok(changes()>initialChanges);assert.equal(transactions,1);assert.equal(f.tasks.get('A',task.id).turnId,'turn-2');
  const changed=f.tasks.get('A',task.id);f.tasks.record('A',task.id,{...entry,turnId:'turn-2',code:'process_offline'});
  assert.equal(f.tasks.get('A',task.id).eventCount,changed.eventCount+1);
  const diagnosticChanges=changes();f.tasks.record('A',task.id,{...entry,turnId:'turn-2',code:'process_offline'});
  assert.equal(changes(),diagnosticChanges);
});

test('event diagnostic codes expose controlled Chinese labels without accepting arbitrary reasons',t=>{
  const f=fixture(t),task=f.tasks.ensure('A',f.event());
  f.tasks.record('A',task.id,{stage:'uncertain',code:'start_uncertain'});
  const event=f.tasks.get('A',task.id).events.at(-1);assert.equal(event.code,'start_uncertain');assert.equal(event.codeLabel,'启动结果需要确认');
  f.tasks.record('A',task.id,{stage:'uncertain',code:'PRIVATE_ERROR'});
  const unknown=f.tasks.get('A',task.id).events.at(-1);assert.equal(unknown.code,'');assert.equal(unknown.codeLabel,'');
});

test('list filters use the account together with thread and chat scope',t=>{
  const f=fixture(t),a=f.tasks.ensure('A',f.event()),group=f.tasks.ensure('A',f.event('group',{chat:'room',group:true}));
  const b=f.tasks.ensure('B',f.event('b',{user:'B',chat:'room',group:true}));
  for(const [user,task] of [['A',a],['A',group],['B',b]])f.tasks.record(user,task.id,{stage:'running',threadId:'shared-thread'});
  assert.equal(f.tasks.list('A',{thread:'shared-thread'}).length,2);
  assert.deepEqual(f.tasks.list('A',{chat:'room',group:true}).map(task=>task.id),[group.id]);
  assert.deepEqual(f.tasks.list('A',{chat:'room',group:false}),[]);assert.equal(f.tasks.list('A',{limit:1}).length,1);
  assert.equal(f.tasks.list('A',{thread:''}).length,0);assert.equal(f.tasks.list('B').length,1);
});

test('late running or approval notifications never revive a terminal task',t=>{
  const f=fixture(t);
  for(const stage of ['completed','failed','interrupted','cancelled','uncertain']){
    const task=f.tasks.ensure('A',f.event(stage));f.tasks.record('A',task.id,{stage,deliveryStatus:'not_required'});
    const old=f.tasks.get('A',task.id);
    for(const late of ['received','running','waiting_approval','supplemented'])f.tasks.record('A',task.id,{stage:late});
    f.tasks.record('A',task.id,{stage:'failed'});
    assert.deepEqual(f.tasks.get('A',task.id),old);
  }
});

test('execution completion is independent of pending, partial, rejected or uncertain delivery',t=>{
  const f=fixture(t);
  for(const deliveryStatus of ['sent','partial','failed','unknown']){
    const task=f.tasks.ensure('A',f.event(deliveryStatus));f.tasks.record('A',task.id,{stage:'completed',executionStatus:'completed',deliveryStatus:'pending'});
    f.tasks.record('A',task.id,{stage:'delivering'});
    const result=f.tasks.record('A',task.id,{stage:'completed',executionStatus:'completed',deliveryStatus});
    assert.equal(result.executionStatus,'completed');assert.equal(result.deliveryStatus,deliveryStatus);
    assert.deepEqual(f.tasks.get('A',task.id).events.map(event=>event.stage),['received','completed','delivering','completed']);
  }
});

test('only a confirmed matching thread and turn notification can resolve unknown execution',t=>{
  const f=fixture(t),task=f.tasks.ensure('A',f.event());
  f.tasks.record('A',task.id,{stage:'uncertain',code:'start_uncertain',threadId:'thread-1',deliveryStatus:'unknown'});
  for(const entry of [{threadId:'thread-1',turnId:'turn-1'},{confirmed:true,threadId:'foreign',turnId:'turn-1'},{confirmed:true,threadId:'thread-1'}]){
    f.tasks.record('A',task.id,{stage:'running',...entry});assert.equal(f.tasks.get('A',task.id).executionStatus,'unknown');
  }
  f.tasks.record('A',task.id,{stage:'running',confirmed:true,threadId:'thread-1',turnId:'turn-1',deliveryStatus:'pending'});
  assert.equal(f.tasks.get('A',task.id).executionStatus,'running');
  f.tasks.record('A',task.id,{stage:'uncertain',code:'process_offline',deliveryStatus:'unknown'});
  f.tasks.record('A',task.id,{stage:'completed',confirmed:true,threadId:'thread-1',turnId:'older-turn',deliveryStatus:'sent'});
  assert.equal(f.tasks.get('A',task.id).executionStatus,'unknown');
  f.tasks.record('A',task.id,{stage:'completed',confirmed:true,threadId:'thread-1',turnId:'turn-1',deliveryStatus:'sent'});
  const completed=f.tasks.get('A',task.id);assert.equal(completed.executionStatus,'completed');assert.equal(completed.deliveryStatus,'sent');
  f.tasks.record('A',task.id,{stage:'running',confirmed:true,threadId:'thread-1',turnId:'turn-1'});
  assert.deepEqual(f.tasks.get('A',task.id),completed);
  const beforeStart=f.tasks.ensure('A',f.event('before-start'));f.tasks.record('A',beforeStart.id,{stage:'uncertain'});
  f.tasks.record('A',beforeStart.id,{stage:'running',confirmed:true,threadId:'thread-1',turnId:'turn-1'});
  assert.equal(f.tasks.get('A',beforeStart.id).executionStatus,'unknown');
});

test('restart marks unresolved execution or delivery uncertain without changing settled tasks or messages',t=>{
  const f=fixture(t),running=f.tasks.ensure('A',f.event('running')),queued=f.tasks.ensure('A',f.event('queued')),completed=f.tasks.ensure('A',f.event('completed')),sent=f.tasks.ensure('B',f.event('sent',{user:'B',chat:'B'}));
  f.tasks.record('A',running.id,{stage:'running'});f.tasks.record('A',queued.id,{stage:'queued'});
  f.tasks.record('A',completed.id,{stage:'completed',deliveryStatus:'pending'});f.tasks.record('B',sent.id,{stage:'completed',deliveryStatus:'sent'});
  f.history.record('A',{kind:'inbound',messageId:'untouched',text:'ORIGINAL'});const messages=f.history.read('A');
  const reopened=new TaskStore(f.history);assert.equal(reopened.recoverPending(),3);assert.equal(reopened.recoverPending(),0);
  assert.equal(reopened.get('A',running.id).executionStatus,'unknown');assert.equal(reopened.get('A',queued.id).deliveryStatus,'unknown');
  const recovered=reopened.get('A',completed.id);assert.equal(recovered.stage,'uncertain');assert.equal(recovered.executionStatus,'completed');assert.equal(recovered.events.at(-1).code,'service_restart');
  assert.equal(reopened.get('B',sent.id).stage,'completed');assert.equal(reopened.get('B',sent.id).deliveryStatus,'sent');assert.deepEqual(f.history.read('A'),messages);
  assert.equal(reopened.ensure('A',f.event('running')).id,running.id);assert.equal(reopened.list('A').length,3);
});

test('restart recovery only visits configured accounts',t=>{
  const f=fixture(t),a=f.tasks.ensure('A',f.event()),b=f.tasks.ensure('B',f.event('b',{user:'B',chat:'B'}));
  f.config.users=[{id:'A'}];const reopened=new TaskStore(f.history);assert.equal(reopened.recoverPending(),1);
  assert.equal(reopened.get('A',a.id).stage,'uncertain');assert.equal(reopened.get('B',b.id).stage,'received');
});

test('newly paired accounts are recognized without recreating the task store',t=>{
  const f=fixture(t);f.config.users.push({id:'C'});
  const task=f.tasks.ensure('C',f.event('new-account',{user:'C',chat:'C'}));
  assert.equal(task.user,'C');assert.equal(f.tasks.recoverPending(),1);
  assert.equal(f.tasks.get('C',task.id).stage,'uncertain');
});

test('accepted supplements follow parent execution and subsequent delivery updates',t=>{
  const f=fixture(t),parent=f.tasks.ensure('A',f.event('parent')),child=f.tasks.ensure('A',f.event('child'));
  f.tasks.record('A',parent.id,{stage:'running',threadId:'thread-1',turnId:'turn-1'});
  const linked=f.tasks.record('A',child.id,{stage:'supplemented',parentTaskId:parent.id});
  assert.equal(linked.parentTaskId,parent.id);assert.equal(linked.executionStatus,'awaiting_parent');assert.equal(linked.threadId,'thread-1');
  f.tasks.record('A',parent.id,{stage:'completed',deliveryStatus:'pending'});assert.equal(f.tasks.get('A',child.id).executionStatus,'completed');
  f.tasks.record('A',parent.id,{stage:'delivering'});assert.equal(f.tasks.get('A',child.id).stage,'delivering');
  f.tasks.record('A',parent.id,{stage:'completed',deliveryStatus:'partial',code:'reply_partial'});
  const result=f.tasks.get('A',child.id);assert.equal(result.deliveryStatus,'partial');assert.equal(result.stage,'completed');
  assert.equal(result.sourceIds[0],'child');assert.equal(result.threadId,'thread-1');assert.equal(result.turnId,'turn-1');
});

test('accepted supplements preserve uncertain parent delivery without losing completed execution',t=>{
  const f=fixture(t),parent=f.tasks.ensure('A',f.event('parent')),child=f.tasks.ensure('A',f.event('child'));
  f.tasks.record('A',parent.id,{stage:'running'});
  f.tasks.record('A',child.id,{stage:'supplemented',parentTaskId:parent.id});
  f.tasks.record('A',parent.id,{stage:'delivering',executionStatus:'completed',deliveryStatus:'delivering'});
  assert.equal(f.tasks.get('A',child.id).stage,'delivering');
  f.tasks.record('A',parent.id,{stage:'uncertain',executionStatus:'completed',deliveryStatus:'unknown',code:'reply_uncertain'});
  const result=f.tasks.get('A',child.id);
  assert.equal(result.stage,'uncertain');assert.equal(result.executionStatus,'completed');assert.equal(result.deliveryStatus,'unknown');
});

test('parent completion does not complete a supplement still preparing or already failed',t=>{
  const f=fixture(t),parent=f.tasks.ensure('A',f.event('parent')),preparing=f.tasks.ensure('A',f.event('preparing')),failed=f.tasks.ensure('A',f.event('failed'));
  f.tasks.record('A',preparing.id,{stage:'preparing',parentTaskId:parent.id});
  f.tasks.record('A',failed.id,{stage:'failed',parentTaskId:parent.id,code:'prepare_failed'});
  f.tasks.record('A',parent.id,{stage:'completed',deliveryStatus:'sent'});
  assert.equal(f.tasks.get('A',preparing.id).stage,'preparing');assert.equal(f.tasks.get('A',failed.id).stage,'failed');
  f.tasks.record('A',preparing.id,{stage:'supplemented',parentTaskId:parent.id});assert.equal(f.tasks.get('A',preparing.id).deliveryStatus,'sent');
});

test('parent failure propagates to accepted supplements but later supplement failure stops following',t=>{
  const f=fixture(t),parent=f.tasks.ensure('A',f.event('parent')),accepted=f.tasks.ensure('A',f.event('accepted')),rejected=f.tasks.ensure('A',f.event('rejected'));
  for(const task of [accepted,rejected])f.tasks.record('A',task.id,{stage:'supplemented',parentTaskId:parent.id});
  f.tasks.record('A',rejected.id,{stage:'failed',code:'supplement_rejected',deliveryStatus:'not_required'});
  f.tasks.record('A',parent.id,{stage:'failed',code:'model_failed',deliveryStatus:'pending'});
  f.tasks.record('A',parent.id,{stage:'failed',deliveryStatus:'sent'});
  assert.equal(f.tasks.get('A',accepted.id).executionStatus,'failed');assert.equal(f.tasks.get('A',accepted.id).deliveryStatus,'sent');
  assert.equal(f.tasks.get('A',rejected.id).deliveryStatus,'not_required');assert.equal(f.tasks.get('A',rejected.id).events.at(-1).code,'supplement_rejected');
});

test('supplement parent links reject cross-account, cross-chat, self and cyclic associations',t=>{
  const f=fixture(t),parent=f.tasks.ensure('A',f.event('parent')),child=f.tasks.ensure('A',f.event('child')),foreign=f.tasks.ensure('B',f.event('b',{user:'B',chat:'B'})),group=f.tasks.ensure('A',f.event('group',{chat:'room',group:true}));
  for(const parentTaskId of [foreign.id,group.id,child.id,'missing'])assert.throws(()=>f.tasks.record('A',child.id,{stage:'supplemented',parentTaskId}),/父任务/);
  f.tasks.record('A',child.id,{stage:'supplemented',parentTaskId:parent.id});
  assert.throws(()=>f.tasks.record('A',parent.id,{stage:'supplemented',parentTaskId:child.id}),/循环/);
  assert.equal(f.tasks.get('A',parent.id).parentTaskId,null);
});

test('QQ status summary contains only current-chat diagnostic labels and no task prompt',t=>{
  const f=fixture(t),task=f.tasks.ensure('A',f.event('private',{text:'PRIVATE_PROMPT'}));
  f.tasks.record('A',task.id,{stage:'waiting_input'});f.tasks.ensure('B',f.event('foreign',{user:'B',chat:'B',text:'OTHER_ACCOUNT'}));
  const summary=f.tasks.summary('A',{chat:'A',group:false});assert.match(summary,/等待回答/);assert.match(summary,/尚未投递/);
  assert.equal(summary.includes('PRIVATE_PROMPT'),false);assert.equal(summary.includes('OTHER_ACCOUNT'),false);
  assert.match(f.tasks.summary('A',{chat:'other',group:true}),/暂无记录/);
});
