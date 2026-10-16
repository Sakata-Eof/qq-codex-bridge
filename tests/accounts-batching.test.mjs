import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Accounts } from '../src/core/accounts.mjs';
import { Bridge } from '../src/core/bridge.mjs';
import { History, UNASSIGNED } from '../src/history/store.mjs';
import { MessageBatches } from '../src/core/message-batches.mjs';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
const event=(id,text='',extra={})=>({id,text,user:'owner',chat:'owner',group:false,attachments:[],quoted:[],...extra});
class RPC extends EventEmitter {
  constructor(){super();this.calls=[];this.thread=0;this.turn=0;}
  async call(method,params){this.calls.push({method,params});if(method==='thread/start')return {thread:{id:'thread-'+(++this.thread)}};if(method==='turn/start')return {turn:{id:'turn-'+(++this.turn)}};if(method==='turn/steer')return {turnId:params.expectedTurnId};return {};}
  reply(){}write(){}stop(){}
}
function fixture(t){
  t.mock.timers.enable({apis:['setTimeout','Date'],now:Date.UTC(2026,9,15)});
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-account-batches-')),user={id:'owner',workspace:root,allowedRoots:[root],allowedGroups:[]};
  const config={appId:'test',users:[user]},history=new History(config,root),rpc=new RPC(),sent=[],prepared=[],seen=[];
  const qq={send:async(e,text)=>sent.push({messageId:e.id,text})};
  const media={prepare:async e=>{prepared.push(e);return [{type:'text',text:e.text},...e.attachments.map(a=>({type:'localImage',path:a.filename}))];}};
  const bridge=new Bridge({...config,ownerOpenId:user.id,workspace:root,allowedRoots:[root],allowedGroups:[]},rpc,qq.send,()=>{},path.join(root,'sessions.json'),()=>{},media);
  const batches=new MessageBatches({delayMs:30,maxWaitMs:100,handle:e=>bridge.handle(e)});
  bridge.pendingFor=e=>batches.pendingFor(e);bridge.cancelPending=e=>batches.cancel(e);
  bridge.persistSeen=values=>seen.push([...values.keys()]);
  // Supply the instance wiring normally created by Accounts.get, without starting a process.
  bridge.onSession=(e,s)=>{for(const source of e.sourceEvents||[e]){source.historyThreadId=s.threadId;history.bindMessage(user.id,source.id,s.threadId,e.text||e.attachments?.[0]?.filename||'多模态对话');}};
  bridge.onResult=(e,result)=>history.record(user.id,{kind:result.status==='failed'?'error':'result',messageId:e.id,...result});
  const accounts=new Accounts(config,qq,root,()=>{},()=>{},history),instance={rpc,bridge,user,batches};
  accounts.instances.set(user.id,instance);accounts.get=async()=>instance;
  t.after(()=>{batches.cancelAll();history.close();});
  return {accounts,bridge,batches,rpc,history,sent,prepared,seen};
}
const calls=(f,method)=>f.rpc.calls.filter(x=>x.method===method);
const inbound=f=>f.history.read('owner').filter(x=>x.kind==='inbound');
function complete(f,e){const s=f.bridge.sessions.get(f.bridge.key(e));f.rpc.emit('notification',{method:'turn/completed',params:{threadId:s.threadId,turn:{id:s.turnId,status:'completed'}}});}

test('Accounts merges image and text while retaining each inbound source, seen id and thread binding',{timeout:2000},async t=>{
  const f=fixture(t),image=event('image','',{attachments:[{filename:'question.png',content_type:'image/png'}]}),text=event('text','任选一题四百字');
  const a=f.accounts.handle(image),b=f.accounts.handle(text);await tick();
  assert.equal(f.accounts.busy(),true);assert.equal(f.batches.pendingFor(image),2);assert.equal(calls(f,'turn/start').length,0);
  t.mock.timers.tick(30);await Promise.all([a,b]);
  assert.equal(calls(f,'turn/start').length,1);assert.equal(f.prepared.length,1);
  assert.equal(f.prepared[0].text,'任选一题四百字');assert.deepEqual(f.prepared[0].attachments,image.attachments);
  assert.deepEqual(f.prepared[0].sourceEvents.map(x=>x.id),['image','text']);
  assert(f.seen.at(-1).includes('image'));assert(f.seen.at(-1).includes('text'));
  assert.deepEqual(inbound(f).map(x=>[x.messageId,x.threadId,x.text]),[['image','thread-1',''],['text','thread-1','任选一题四百字']]);
  await f.accounts.handle({...image});await f.accounts.handle({...text});t.mock.timers.tick(100);await tick();
  assert.equal(calls(f,'turn/start').length,1);assert.equal(inbound(f).length,2);
});

test('Accounts status bypasses a pending batch and stop cancels every source without later replay',{timeout:2000},async t=>{
  const f=fixture(t),image=event('image','',{attachments:[{filename:'question.png'}]}),text=event('text','后续说明');
  const a=f.accounts.handle(image),b=f.accounts.handle(text);await tick();
  await f.accounts.handle(event('status','/status'));
  assert(f.sent.some(x=>x.messageId==='status'&&x.text.includes('合并连续消息')));assert.equal(f.batches.pendingFor(image),2);
  await f.accounts.handle(event('stop','/stop'));await Promise.all([a,b]);
  assert.equal(f.batches.pendingFor(image),0);assert.equal(f.accounts.busy(),false);
  assert(f.bridge.seen.has('image'));assert(f.bridge.seen.has('text'));
  await f.accounts.handle({...image});await f.accounts.handle({...text});t.mock.timers.tick(100);await tick();
  assert.equal(calls(f,'turn/start').length,0);assert.equal(f.prepared.length,0);
  assert(inbound(f).filter(x=>['image','text'].includes(x.messageId)).every(x=>x.threadId===UNASSIGNED));
});

test('Accounts sends a later merged batch into the active turn and binds all new sources to it',{timeout:2000},async t=>{
  const f=fixture(t),original=event('original','原任务'),first=f.accounts.handle(original);await tick();t.mock.timers.tick(30);await first;
  const image=event('image','',{attachments:[{filename:'extra.png'}]}),text=event('text','请考虑这张图'),a=f.accounts.handle(image),b=f.accounts.handle(text);await tick();
  assert.equal(f.accounts.busy(),true);t.mock.timers.tick(30);await Promise.all([a,b]);
  assert.equal(calls(f,'turn/start').length,1);assert.equal(calls(f,'turn/steer').length,1);
  const steer=calls(f,'turn/steer')[0];assert.equal(steer.params.expectedTurnId,'turn-1');assert.equal(steer.params.input[0].text,'请考虑这张图');assert.equal(steer.params.input[1].path,'extra.png');
  assert.equal(f.bridge.sessions.get(f.bridge.key(original)).event.id,'original');
  assert.deepEqual(inbound(f).map(x=>[x.messageId,x.threadId]),[['original','thread-1'],['image','thread-1'],['text','thread-1']]);
});

test('all sources move to the actual new thread when a merged batch triggers rotation',{timeout:2000},async t=>{
  const f=fixture(t);f.bridge.config.rotationTurns=1;
  const original=event('original','旧会话'),first=f.accounts.handle(original);await tick();t.mock.timers.tick(30);await first;complete(f,original);await tick();
  const image=event('image','',{attachments:[{filename:'new.png'}]}),text=event('text','新会话任务'),a=f.accounts.handle(image),b=f.accounts.handle(text);await tick();
  assert(inbound(f).filter(x=>['image','text'].includes(x.messageId)).every(x=>x.threadId==='thread-1'));
  t.mock.timers.tick(30);await Promise.all([a,b]);
  assert.equal(calls(f,'turn/start').length,2);
  assert.deepEqual(inbound(f).map(x=>[x.messageId,x.threadId]),[['original','thread-1'],['image','thread-2'],['text','thread-2']]);
});

test('unauthorized senders never enter a batch or another account history',{timeout:2000},async t=>{
  const f=fixture(t);await f.accounts.handle(event('foreign','不应执行',{user:'foreign',chat:'foreign'}));
  t.mock.timers.tick(100);await tick();
  assert.equal(f.accounts.busy(),false);assert.equal(f.prepared.length,0);assert.equal(f.history.read('owner').length,0);assert.equal(calls(f,'turn/start').length,0);
});

test('initial preparation failure cancels later unflushed messages and explicitly reports that they were not submitted',{timeout:2000},async t=>{
  const f=fixture(t);let release,preparing=false;const gate=new Promise(resolve=>{release=resolve;});
  f.bridge.media.prepare=async()=>{preparing=true;await gate;throw new Error('image download failed');};
  const image=event('image','',{attachments:[{filename:'question.png'}]}),a=f.accounts.handle(image);await tick();t.mock.timers.tick(30);await tick();
  assert.equal(preparing,true);
  const text=event('text','接着解答第二题'),b=f.accounts.handle(text);await tick();assert.equal(f.batches.pendingFor(text),1);
  release();await Promise.all([a,b]);
  assert.equal(f.batches.pendingFor(text),0);assert.equal(f.bridge.seen.has('text'),true);assert.equal(calls(f,'turn/start').length,0);
  assert(f.sent.some(x=>x.text.includes('未提交')));
});
