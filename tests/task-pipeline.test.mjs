import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Accounts } from '../src/core/accounts.mjs';
import { Bridge } from '../src/core/bridge.mjs';
import { MessageBatches } from '../src/core/message-batches.mjs';
import { History } from '../src/history/store.mjs';
import { TaskStore } from '../src/history/task-store.mjs';
import { QQ } from '../src/qq/client.mjs';
import { Media } from '../src/media/processor.mjs';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
const event=(id,text='任务',extra={})=>({id,text,user:'owner',chat:'owner',group:false,attachments:[],quoted:[],...extra});
function gate(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
async function until(check){for(let i=0;i<30;i++){if(check())return;await tick();}assert.fail('Expected operation did not start');}
class RPC extends EventEmitter {
  constructor(){super();this.calls=[];this.replies=[];this.thread=0;this.turn=0;}
  async call(method,params){this.calls.push({method,params});if(method==='thread/start')return {thread:{id:'thread-'+(++this.thread)}};if(method==='thread/resume')return {thread:{id:params.threadId}};if(method==='turn/start')return {turn:{id:'turn-'+(++this.turn)}};return {};}
  reply(id,result){this.replies.push({id,result});}write(){}
}
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-task-pipeline-')),user={id:'owner',workspace:root,allowedRoots:[root],allowedGroups:['group']};
  const config={appId:'test',users:[user,{id:'other',workspace:root,allowedRoots:[root]}]},history=new History(config,root),tasks=new TaskStore(history),rpc=new RPC(),sent=[];
  const qq={send:async(e,text)=>{sent.push({id:e.id,text});return {acceptedParts:1,totalParts:1,truncated:false};}};
  const accounts=new Accounts(config,qq,root,()=>{},()=>{},history,tasks);
  const bridge=new Bridge({...config,ownerOpenId:'owner',workspace:root,allowedRoots:[root],allowedGroups:['group']},rpc,qq.send,()=>{},path.join(root,'sessions.json'));
  bridge.onTaskEvent=(e,details)=>accounts.taskEvent(user,e,details);bridge.taskSummary=e=>accounts.taskSummary(user,e);
  t.after(()=>history.close());
  const session=e=>bridge.sessions.get(bridge.key(e));
  const task=e=>tasks.get(e.user,e.taskId);
  const finish=async(e,status='completed',text='模型已完成')=>{const s=session(e);rpc.emit('notification',{method:'item/completed',params:{threadId:s.threadId,item:{type:'agentMessage',phase:'final',text}}});rpc.emit('notification',{method:'turn/completed',params:{threadId:s.threadId,turn:{id:s.turnId,status}}});await s.deliveryPromise;};
  return {root,user,config,history,tasks,rpc,accounts,bridge,sent,session,task,finish};
}

test('real TaskStore pipeline separates model completion from pending and failed QQ delivery',async t=>{
  const f=fixture(t),e=event('task'),delivery=gate();
  f.bridge.send=()=>delivery.promise;
  await f.bridge.handle(e);
  assert.equal(f.task(e).executionStatus,'running');assert.equal(f.accounts.taskTrackingError.size,0);
  const finishing=f.finish(e);await tick();
  assert.equal(f.task(e).executionStatus,'completed');assert.equal(f.task(e).deliveryStatus,'delivering');
  delivery.reject(Object.assign(new Error('private rejected body'),{status:400,definite:true}));await finishing;
  const task=f.task(e);assert.equal(task.executionStatus,'completed');assert.equal(task.deliveryStatus,'failed');
  assert.deepEqual(task.events.map(row=>row.stage),['received','queued','preparing','starting','running','completed','delivering','completed']);
  assert.equal(task.events.at(-1).code,'reply_rejected');assert(!JSON.stringify(task.events).includes('private rejected body'));
  assert.equal(f.rpc.calls.filter(x=>x.method==='turn/start').length,1);assert.equal(f.accounts.taskTrackingError.size,0);
});

test('batch sources share one real task while duplicate receipts, cancelled batches and different chats stay separate',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:Date.UTC(2026,9,16)});
  const f=fixture(t),batches=new MessageBatches({delayMs:20,handle:e=>f.bridge.handle(e),observer:f.bridge.onTaskEvent});
  f.bridge.pendingFor=e=>batches.pendingFor(e);f.bridge.cancelPending=e=>batches.cancel(e);
  t.after(()=>batches.cancelAll());
  const first=event('first'),last=event('last'),a=batches.push(first),b=batches.push(last);
  assert.equal(first.taskId,last.taskId);assert.equal(batches.push({...first}),a);
  const group=event('first','群任务',{chat:'group',group:true}),c=batches.push(group);
  assert.notEqual(group.taskId,first.taskId);
  await f.bridge.handle(event('stop','/stop'));await Promise.all([a,b]);
  assert.equal(f.task(first).executionStatus,'cancelled');assert.equal(f.tasks.list('owner').length,2);
  assert.deepEqual(f.task(first).sourceIds,['first','last']);
  t.mock.timers.tick(20);await c;
  assert.equal(f.task(group).executionStatus,'running');assert.equal(f.rpc.calls.filter(x=>x.method==='turn/start').length,1);
});

test('a successful supplement links its own task to the original recipient and follows final delivery',async t=>{
  const f=fixture(t),original=event('original'),supplement=event('supplement','补充');
  await f.bridge.handle(original);await f.bridge.handle(supplement);
  assert.notEqual(original.taskId,supplement.taskId);assert.equal(f.task(supplement).parentTaskId,original.taskId);
  assert.equal(f.task(supplement).executionStatus,'awaiting_parent');assert.equal(f.session(original).event,original);
  await f.finish(original);
  assert.equal(f.task(supplement).executionStatus,'completed');assert.equal(f.task(supplement).deliveryStatus,'sent');
  assert.deepEqual(f.sent.map(x=>x.id),['original']);
});

test('failed supplement preparation is independent and cannot fail or replace its running parent',async t=>{
  const f=fixture(t),original=event('original'),bad=event('bad','坏附件');await f.bridge.handle(original);
  f.bridge.media={prepare:async()=>{throw new Error('private attachment detail');}};
  await f.bridge.handle(bad);
  assert.equal(f.task(original).executionStatus,'running');assert.equal(f.task(bad).executionStatus,'failed');assert.equal(f.task(bad).parentTaskId,null);
  assert.equal(f.session(original).event,original);assert.equal(f.task(bad).events.at(-1).code,'prepare_failed');
});

test('approval and question controls change only the original task and status replies are not result delivery',async t=>{
  const f=fixture(t),e=event('task');await f.bridge.handle(e);
  f.rpc.emit('request',{id:7,method:'item/commandExecution/requestApproval',params:{threadId:'thread-1',turnId:'turn-1',command:'secret command'}});
  assert.equal(f.task(e).stage,'waiting_approval');assert.equal(f.task(e).deliveryStatus,'pending');
  await f.bridge.handle(event('status','/status'));assert(f.sent.at(-1).text.includes(e.taskId.slice(0,8)));
  await f.bridge.handle(event('approve','/approve 1'));assert.equal(f.task(e).stage,'running');
  f.rpc.emit('request',{id:8,method:'item/tool/requestUserInput',params:{threadId:'thread-1',turnId:'turn-1',questions:[{id:'choice',question:'private question',options:[]}]}});
  assert.equal(f.task(e).stage,'waiting_input');
  await f.bridge.handle(event('answer','/answer 2 yes'));assert.equal(f.task(e).stage,'running');
  assert.equal(f.tasks.list('owner').length,1);assert(!JSON.stringify(f.task(e).events).includes('secret command'));
});

test('cancelled preparation and queued tasks stay cancelled after a late download failure',async t=>{
  const f=fixture(t),download=gate(),first=event('first'),next=event('next');let preparing=false;
  f.bridge.media={prepare:async e=>{if(e===first){preparing=true;await download.promise;}return [{type:'text',text:e.text}];}};
  const a=f.bridge.handle(first);await until(()=>preparing);const b=f.bridge.handle(next);
  await f.bridge.handle(event('stop','/stop'));assert.equal(f.task(first).executionStatus,'cancelled');assert.equal(f.task(next).executionStatus,'cancelled');
  download.reject(new Error('late failure'));await Promise.all([a,b]);
  assert.equal(f.task(first).executionStatus,'cancelled');assert.equal(f.task(next).executionStatus,'cancelled');assert.equal(f.rpc.calls.length,0);
});

test('definite start rejection and ambiguous timeout never retry and have different execution states',async t=>{
  const f=fixture(t),base=f.rpc.call.bind(f.rpc);
  f.rpc.call=async(method,params)=>{if(method==='turn/start'){f.rpc.calls.push({method,params});throw Object.assign(new Error('rejected'),{definite:true});}return base(method,params);};
  const rejected=event('rejected');await f.bridge.handle(rejected);assert.equal(f.task(rejected).executionStatus,'failed');
  f.rpc.call=async(method,params)=>{if(method==='turn/start'){f.rpc.calls.push({method,params});throw new Error('timed out');}return base(method,params);};
  const uncertain=event('uncertain');await f.bridge.handle(uncertain);assert.equal(f.task(uncertain).executionStatus,'unknown');
  assert.equal(f.rpc.calls.filter(x=>x.method==='turn/start').length,2);assert.equal(f.task(uncertain).events.at(-1).code,'start_uncertain');
});

for(const [label,failure,expected] of [
  ['timeout',new Error('private network error'),'unknown'],
  ['partial timeout',Object.assign(new Error('private timeout'),{acceptedParts:1,totalParts:3,uncertain:true}),'partial'],
  ['partial rejection',Object.assign(new Error('private rejection'),{acceptedParts:1,totalParts:3,definite:true}),'partial'],
  ['accepted audit failure',Object.assign(new Error('private database error'),{accepted:true,acceptedParts:1,totalParts:1,auditFailed:true,uncertain:false}),'sent']
])test(`result ${label} preserves completed model state and does not resend`,async t=>{
  const f=fixture(t),e=event('task');let attempts=0;f.bridge.send=async()=>{attempts++;throw failure;};
  await f.bridge.handle(e);await f.finish(e);
  assert.equal(f.task(e).executionStatus,'completed');assert.equal(f.task(e).deliveryStatus,expected);assert.equal(attempts,1);
  const uncertain=label==='timeout'||label==='partial timeout';assert.equal(f.task(e).stage,uncertain?'uncertain':'completed');
  if(uncertain)assert.notEqual(f.task(e).stageLabel,'已完成');
  assert(!JSON.stringify(f.task(e).events).includes('private'));
});

test('a sent error reply does not convert a failed model task into success',async t=>{
  const f=fixture(t),e=event('task');await f.bridge.handle(e);await f.finish(e,'failed','失败信息');
  assert.equal(f.task(e).executionStatus,'failed');assert.equal(f.task(e).deliveryStatus,'sent');assert.equal(f.task(e).stage,'failed');
});

for(const status of ['failed','interrupted'])test(`an uncertain QQ delivery preserves explicit model ${status} stage`,async t=>{
  const f=fixture(t),e=event('task');f.bridge.send=async()=>{throw new Error('network timeout');};
  await f.bridge.handle(e);await f.finish(e,status);
  assert.equal(f.task(e).stage,status);assert.equal(f.task(e).executionStatus,status);assert.equal(f.task(e).deliveryStatus,'unknown');
});

test('an unexpected delivery failure records uncertain overall status without losing completed execution',async t=>{
  const f=fixture(t),e=event('task');f.bridge.deliver=async()=>{throw new Error('unexpected local failure');};
  await f.bridge.handle(e);await f.finish(e);
  assert.equal(f.task(e).stage,'uncertain');assert.equal(f.task(e).executionStatus,'completed');assert.equal(f.task(e).deliveryStatus,'unknown');
});

test('QQ truncation and failed attachments remain partial even when their explanation is successfully delivered',async t=>{
  const f=fixture(t),e=event('task'),file=path.join(f.root,'output.txt');fs.writeFileSync(file,'output');
  f.bridge.media={prepare:async()=>[{type:'text',text:'task'}],sendFile:async()=>{throw Object.assign(new Error('upload rejected'),{definite:true});}};
  await f.bridge.handle(e);await f.finish(e,'completed',`[文件](${file})`);
  assert.equal(f.task(e).executionStatus,'completed');assert.equal(f.task(e).deliveryStatus,'partial');assert.equal(f.task(e).events.at(-1).code,'attachment_failed');
  assert.equal(f.sent.length,2);
  const f2=fixture(t),e2=event('truncated');f2.bridge.send=async()=>({acceptedParts:4,totalParts:8,truncated:true});
  await f2.bridge.handle(e2);await f2.finish(e2);assert.equal(f2.task(e2).deliveryStatus,'partial');assert.equal(f2.task(e2).events.at(-1).code,'reply_truncated');
});

test('a local audio conversion failure is a known attachment failure before any QQ file request',async t=>{
  const f=fixture(t),e=event('task'),file=path.join(f.root,'output.flac'),failure=new Error('private ffmpeg error');fs.writeFileSync(file,'audio');
  let conversions=0,uploads=0;
  const media=new Media({ffmpeg:'unused-stub'}, {sendFile:async()=>{uploads++;}}, {run:async()=>{conversions++;throw failure;}});
  media.prepare=async()=>[{type:'text',text:'task'}];f.bridge.media=media;
  await f.bridge.handle(e);await f.finish(e,'completed',`[音频](${file})`);
  assert.equal(conversions,1);assert.equal(uploads,0);assert.equal(failure.definite,true);assert.equal(failure.uncertain,false);assert.equal(failure.acceptedParts,0);
  assert.equal(f.task(e).stage,'completed');assert.equal(f.task(e).executionStatus,'completed');assert.equal(f.task(e).deliveryStatus,'partial');
  assert.equal(f.task(e).events.at(-1).code,'attachment_failed');assert(!JSON.stringify(f.task(e).events).includes('private ffmpeg error'));
});

test('media file wrapper returns the QQ delivery report and preserves platform uncertainty unchanged',async()=>{
  const report={acceptedParts:1,totalParts:1,truncated:false},failure=Object.assign(new Error('QQ timed out'),{acceptedParts:0,uncertain:true});
  const media=new Media({}, {sendFile:async()=>report});assert.equal(await media.sendFile(event('ok'),'output.txt'),report);
  media.qq.sendFile=async()=>{throw failure;};
  await assert.rejects(media.sendFile(event('uncertain'),'output.txt'),err=>err===failure&&err.uncertain===true&&err.definite===undefined);
});

test('observer failures cannot prevent execution, completion or delivery and diagnostics degrade only that account',async t=>{
  const f=fixture(t),e=event('task'),originalRecord=f.tasks.record.bind(f.tasks);let calls=0;
  f.tasks.record=()=>{calls++;throw new Error('private sqlite error');};
  await f.bridge.handle(e);await f.finish(e);
  assert(calls>=5);assert.equal(f.rpc.calls.filter(x=>x.method==='turn/start').length,1);assert.equal(f.sent.length,1);
  assert.equal(f.accounts.taskTrackingError.get('owner'),true);assert.equal(f.accounts.taskTrackingError.has('other'),false);
  f.tasks.record=originalRecord;f.accounts.taskEvent(f.user,event('new'),{stage:'received'});
  assert.equal(f.accounts.taskTrackingError.get('owner'),true);
});

test('account startup failure records its receipt time and safe failure, without creating control or unauthorized tasks',async t=>{
  const f=fixture(t);f.accounts.get=async()=>{throw new Error('private setup error');};
  const e=event('start-failed');await assert.rejects(f.accounts.handle(e));
  const task=f.task(e);assert.equal(task.executionStatus,'failed');assert.equal(task.events.at(-1).code,'initialization_failed');
  assert.equal(task.createdAt,new Date(e.receivedAt).toISOString());
  await assert.rejects(f.accounts.handle(event('status','/status')));await f.accounts.handle(event('unknown','任务',{user:'unknown'}));
  await f.accounts.handle(event('foreign-group','任务',{group:true,chat:'forbidden'}));
  assert.equal(f.tasks.list('owner').length,1);assert.equal(f.tasks.list('unknown').length,0);
});

test('a late confirmed turn can resolve a lost start response without starting or sending twice',async t=>{
  const f=fixture(t),e=event('task'),base=f.rpc.call.bind(f.rpc);
  f.rpc.call=async(method,params)=>{if(method==='turn/start'){f.rpc.calls.push({method,params});throw new Error('lost response');}return base(method,params);};
  await f.bridge.handle(e);assert.equal(f.task(e).executionStatus,'unknown');
  f.rpc.emit('notification',{method:'turn/started',params:{threadId:'thread-1',turn:{id:'turn-confirmed'}}});
  assert.equal(f.task(e).executionStatus,'running');assert.equal(f.task(e).turnId,'turn-confirmed');
  await f.finish(e);assert.equal(f.task(e).executionStatus,'completed');assert.equal(f.task(e).deliveryStatus,'sent');
  assert.equal(f.rpc.calls.filter(x=>x.method==='turn/start').length,1);assert.equal(f.sent.length,2);
});

test('a delayed known foreign turn notification cannot complete the current task or deliver its result',async t=>{
  const f=fixture(t),first=event('first'),next=event('next');
  await f.bridge.handle(first);await f.finish(first);await f.bridge.handle(next);
  f.rpc.emit('notification',{method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status:'completed'}}});
  assert.equal(f.task(next).executionStatus,'running');assert.equal(f.session(next).active,true);assert.equal(f.sent.length,1);
  await f.finish(next);assert.equal(f.task(next).executionStatus,'completed');assert.equal(f.sent.length,2);
});

test('old turn notifications during a new turn start cannot bind the old turn or overwrite the new result',async t=>{
  const f=fixture(t),first=event('first'),next=event('next'),starting=gate(),base=f.rpc.call.bind(f.rpc);
  await f.bridge.handle(first);await f.finish(first);
  f.rpc.call=async(method,params)=>{if(method==='turn/start'){f.rpc.calls.push({method,params});return starting.promise;}return base(method,params);};
  const pending=f.bridge.handle(next);await until(()=>f.rpc.calls.filter(x=>x.method==='turn/start').length===2);
  f.rpc.emit('notification',{method:'turn/started',params:{threadId:'thread-1',turn:{id:'turn-1'}}});
  f.rpc.emit('notification',{method:'item/completed',params:{threadId:'thread-1',turnId:'turn-1',item:{type:'agentMessage',text:'old result'}}});
  f.rpc.emit('notification',{method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status:'completed'}}});
  assert.equal(f.task(next).executionStatus,'pending');assert.equal(f.task(next).turnId,null);assert.equal(f.sent.length,1);
  starting.resolve({turn:{id:'turn-2'}});await pending;await f.finish(next,'completed','new result');
  assert.equal(f.task(next).turnId,'turn-2');assert.equal(f.task(next).deliveryStatus,'sent');assert.equal(f.sent.at(-1).text,'new result');
});

test('Codex offline marks active execution uncertain and does not rewrite cancelled queued preparation',async t=>{
  const f=fixture(t),original=event('original'),supplement=event('supplement'),download=gate();let preparing=false;
  await f.bridge.handle(original);
  f.bridge.media={prepare:async()=>{preparing=true;await download.promise;return [{type:'text',text:'supplement'}];}};
  const pending=f.bridge.handle(supplement);await until(()=>preparing);
  f.rpc.emit('offline');assert.equal(f.task(original).executionStatus,'unknown');assert.equal(f.task(supplement).executionStatus,'failed');
  download.resolve();await pending;
  assert.equal(f.task(supplement).executionStatus,'failed');assert.equal(f.rpc.calls.filter(x=>x.method==='turn/steer').length,0);
});

test('batch observer exceptions are contained through merge, handler failure and cancellation without retry',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:0});let calls=0,errors=0;
  const batches=new MessageBatches({delayMs:20,observer:()=>{throw new Error('diagnostic failure');},handle:async()=>{calls++;throw new Error('handler failure');},onError:async()=>{errors++;}});
  const a=batches.push(event('a')),b=batches.push(event('b'));t.mock.timers.tick(20);await Promise.all([a,b]);
  assert.equal(calls,1);assert.equal(errors,1);
  const c=batches.push(event('c'));batches.cancelAll();await c;t.mock.timers.tick(40);assert.equal(calls,1);assert.equal(batches.busy(),false);
});

test('real QQ send reports accepted parts and truncation, while timeout metadata preserves partial success',async()=>{
  const qq=new QQ({},()=>{}),e=event('long'),posts=[];
  qq.api=async(endpoint,body)=>{posts.push(body);return {};};
  const report=await qq.send(e,'长内容。'.repeat(3000));assert.equal(report.acceptedParts,4);assert(report.totalParts>4);assert.equal(report.truncated,true);
  const partial=new QQ({},()=>{});let attempts=0;
  partial.api=async()=>{if(++attempts===2)throw new Error('timeout');return {};};
  await assert.rejects(partial.send(event('partial'),'连续内容。'.repeat(500)),err=>err.acceptedParts===1&&err.uncertain===true&&err.totalParts>1);
  assert.equal(attempts,2);
});

test('real QQ errors distinguish rejected replies, accepted audit failure and upload failure before message submission',async t=>{
  const qq=new QQ({},()=>{});let attempts=0;qq.api=async()=>{attempts++;throw Object.assign(new Error('rejected'),{status:400});};
  await assert.rejects(qq.send(event('reject'),'result'),err=>err.acceptedParts===0&&err.uncertain===false);assert.equal(attempts,1);
  const audited=new QQ({},()=>{});audited.api=async()=>({});audited.on('sent',()=>{throw new Error('audit failed');});
  await assert.rejects(audited.send(event('audit'),'result'),err=>err.accepted===true&&err.acceptedParts===1&&err.auditFailed===true&&err.uncertain===false);
  const f=fixture(t),file=path.join(f.root,'output.txt');fs.writeFileSync(file,'content');
  const media=new QQ({},()=>{});media.api=async()=>{throw new Error('upload timeout');};
  await assert.rejects(media.sendFile(event('upload'),file),err=>err.acceptedParts===0&&err.definite===true&&err.uncertain===false);
});

test('say remains a boolean and an accepted audit error cannot cause an automatic resend',async t=>{
  const f=fixture(t);let attempts=0;
  f.bridge.send=async()=>{attempts++;throw Object.assign(new Error('audit'),{accepted:true,acceptedParts:1,totalParts:1,auditFailed:true,uncertain:false});};
  assert.equal(await f.bridge.say(event('control'),'status'),false);assert.equal(attempts,1);assert.equal(f.tasks.list('owner').length,0);
  f.bridge.send=async()=>({acceptedParts:4,totalParts:8,truncated:true});assert.equal(await f.bridge.say(event('long-control'),'details'),true);
});
