import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Bridge } from '../src/core/bridge.mjs';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
async function until(predicate,label){for(let i=0;i<20;i++){if(predicate())return;await tick();}assert.fail(label);}

class InputRPC extends EventEmitter {
  constructor(){super();this.calls=[];this.replies=[];this.threads=0;this.turns=0;}
  async call(method,params){
    this.calls.push({method,params});
    if(method==='thread/start')return {thread:{id:'thread-'+(++this.threads)}};
    if(method==='thread/resume')return {thread:{id:params.threadId}};
    if(method==='turn/start')return {turn:{id:'turn-'+(++this.turns)}};
    if(method==='turn/steer')return {turnId:params.expectedTurnId};
    return {};
  }
  reply(id,result){this.replies.push({id,result});}
  write(message){this.replies.push(message);}
}

function fixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-bridge-input-')),rpc=new InputRPC(),sent=[];
  const bridge=new Bridge({ownerOpenId:'owner',workspace:root,allowedRoots:[root],allowedGroups:['group']},rpc,async(e,text)=>sent.push({messageId:e.id,text}),()=>{},path.join(root,'sessions.json'));
  return {root,rpc,bridge,sent,event:(id,text='',extra={})=>({id,text,user:'owner',chat:'owner',group:false,attachments:[],...extra})};
}
const calls=(f,method)=>f.rpc.calls.filter(x=>x.method===method);
const state=(f,e)=>f.bridge.sessions.get(f.bridge.key(e));
function completed(f,e,status='completed'){
  const s=state(f,e);
  f.rpc.emit('notification',{method:'turn/completed',params:{threadId:s.threadId,turn:{id:s.turnId,status}}});
}

test('active supplements steer the same turn in order without replacing its result recipient',{timeout:2000},async()=>{
  const f=fixture(),original=f.event('original','先看图'),results=[];
  f.bridge.onResult=(e,result)=>results.push({messageId:e.id,...result});
  await f.bridge.handle(original);
  await Promise.all([f.bridge.handle(f.event('one','任选一题')),f.bridge.handle(f.event('two','论述四百字'))]);
  assert.equal(calls(f,'turn/start').length,1);
  assert.deepEqual(calls(f,'turn/steer').map(x=>[x.params.threadId,x.params.expectedTurnId,x.params.input[0].text]),[['thread-1','turn-1','任选一题'],['thread-1','turn-1','论述四百字']]);
  assert.equal(state(f,original).event.id,'original');
  completed(f,original);await tick();
  assert.equal(results[0].messageId,'original');
});

test('slow media preparation preserves later text and serializes preparation and submission',{timeout:2000},async()=>{
  const f=fixture(),gate=deferred(),prepared=[];
  f.bridge.media={prepare:async e=>{prepared.push(e.id);if(e.id==='image')await gate.promise;return [{type:'text',text:e.text||'图片附件'}];}};
  const image=f.bridge.handle(f.event('image','',{attachments:[{filename:'image.png'}]}));
  await until(()=>prepared.length===1,'first attachment should begin preparation');
  const text=f.bridge.handle(f.event('text','图片中的第二题'));
  await tick();assert.deepEqual(prepared,['image']);assert.equal(calls(f,'turn/start').length,0);
  gate.resolve();await Promise.all([image,text]);
  assert.deepEqual(prepared,['image','text']);
  assert.equal(calls(f,'turn/start').length,1);
  assert.deepEqual(calls(f,'turn/steer').map(x=>x.params.input[0].text),['图片中的第二题']);
});

test('status and approvals stay immediate while stop cancels a supplement waiting for media preparation',{timeout:2000},async()=>{
  const f=fixture(),original=f.event('original','执行任务'),gate=deferred();let preparing=false;
  await f.bridge.handle(original);
  f.bridge.media={prepare:async e=>{preparing=true;await gate.promise;return [{type:'text',text:e.text}];}};
  const supplement=f.bridge.handle(f.event('supplement','补充图片'));
  await until(()=>preparing,'supplement should begin preparation');
  f.rpc.emit('request',{id:7,method:'item/commandExecution/requestApproval',params:{threadId:'thread-1',turnId:'turn-1',command:'echo test'}});
  await f.bridge.handle(f.event('status','/status'));
  await f.bridge.handle(f.event('stop','/stop'));
  await f.bridge.handle(f.event('approval','/approve 1'));
  assert(f.sent.some(x=>x.messageId==='status'));
  assert.equal(calls(f,'turn/interrupt').length,1);
  assert.equal(f.rpc.replies[0].result.decision,'accept');
  assert.equal(calls(f,'turn/steer').length,0);
  assert.equal(state(f,original).event.id,'original');
  gate.resolve();await supplement;
  assert.equal(calls(f,'turn/steer').length,0);
});

test('a turn completing during media preparation makes the prepared supplement a new turn',{timeout:2000},async()=>{
  const f=fixture(),original=f.event('original','原任务'),gate=deferred();let preparing=false;
  await f.bridge.handle(original);
  f.bridge.media={prepare:async e=>{preparing=true;await gate.promise;return [{type:'text',text:e.text}];}};
  const supplement=f.bridge.handle(f.event('supplement','新补充'));
  await until(()=>preparing,'supplement should begin preparation');
  completed(f,original);await tick();gate.resolve();await supplement;
  assert.equal(calls(f,'turn/steer').length,0);
  assert.deepEqual(calls(f,'turn/start').map(x=>x.params.input[0].text),['原任务','新补充']);
  assert.equal(state(f,original).event.id,'supplement');
});

test('media preparation failure does not submit a supplement or lose the active turn',{timeout:2000},async()=>{
  const f=fixture(),original=f.event('original','原任务');await f.bridge.handle(original);
  f.bridge.media={prepare:async e=>{if(e.id==='bad')throw new Error('attachment download failed');return [{type:'text',text:e.text}];}};
  await f.bridge.handle(f.event('bad','坏附件'));
  assert.equal(calls(f,'turn/steer').length,0);assert.equal(calls(f,'turn/start').length,1);
  assert.equal(state(f,original).active,true);assert.equal(state(f,original).event.id,'original');
  await f.bridge.handle(f.event('good','有效补充'));
  assert.deepEqual(calls(f,'turn/steer').map(x=>x.params.input[0].text),['有效补充']);
  assert(f.sent.some(x=>x.messageId==='bad'&&x.text.includes('attachment download failed')));
});

test('model input validation failure does not steer and later valid text still reaches the active turn',{timeout:2000},async()=>{
  const f=fixture(),original=f.event('original','原任务');await f.bridge.handle(original);
  f.bridge.media={prepare:async e=>e.attachments.length?[{type:'localImage',path:'image.png'}]:[{type:'text',text:e.text}]};
  f.bridge.models={params:()=>({}),validateInput:async input=>{if(input.some(x=>x.type==='localImage'))throw new Error('model only supports text');}};
  await f.bridge.handle(f.event('image','',{attachments:[{filename:'image.png'}]}));
  assert.equal(calls(f,'turn/steer').length,0);assert.equal(state(f,original).active,true);
  await f.bridge.handle(f.event('text','文字补充'));
  assert.deepEqual(calls(f,'turn/steer').map(x=>x.params.input[0].text),['文字补充']);
});

test('different conversations prepare and submit independently without steering into another chat',{timeout:2000},async()=>{
  const f=fixture(),gate=deferred(),prepared=[];
  f.bridge.media={prepare:async e=>{prepared.push(e.id);if(e.id==='private')await gate.promise;return [{type:'text',text:e.text}];}};
  const original=f.event('private','私聊任务'),pending=f.bridge.handle(original);
  await until(()=>prepared.length===1,'private task should begin preparation');
  const group=f.event('group','群聊任务',{group:true,chat:'group'});
  await f.bridge.handle(group);
  assert.equal(calls(f,'turn/start').length,1);assert.equal(state(f,group).event.id,'group');
  gate.resolve();await pending;
  assert.equal(calls(f,'turn/start').length,2);assert.equal(calls(f,'turn/steer').length,0);
  assert.notEqual(state(f,original).threadId,state(f,group).threadId);
});

test('definite steer rejection while the original turn is active never starts a duplicate task',{timeout:2000},async()=>{
  const f=fixture(),original=f.event('original','原任务');await f.bridge.handle(original);
  const base=f.rpc.call.bind(f.rpc);f.rpc.call=async(method,params)=>{if(method!=='turn/steer')return base(method,params);f.rpc.calls.push({method,params});throw Object.assign(new Error('steer rejected'),{definite:true});};
  await f.bridge.handle(f.event('supplement','补充'));
  assert.equal(calls(f,'turn/start').length,1);assert.equal(calls(f,'turn/steer').length,1);
  assert.equal(state(f,original).active,true);assert.equal(state(f,original).event.id,'original');
});

test('definite steer rejection after observed completion starts the supplement exactly once as a new turn',{timeout:2000},async()=>{
  const f=fixture(),original=f.event('original','原任务'),gate=deferred();await f.bridge.handle(original);
  const base=f.rpc.call.bind(f.rpc);f.rpc.call=async(method,params)=>{if(method!=='turn/steer')return base(method,params);f.rpc.calls.push({method,params});return gate.promise;};
  const supplement=f.bridge.handle(f.event('supplement','补充'));
  await until(()=>calls(f,'turn/steer').length===1,'supplement should reach steer before completion');
  completed(f,original);await tick();gate.reject(Object.assign(new Error('expected turn is no longer active'),{definite:true}));
  await supplement;
  assert.deepEqual(calls(f,'turn/start').map(x=>x.params.input[0].text),['原任务','补充']);
  assert.equal(calls(f,'turn/steer').length,1);assert.equal(state(f,original).event.id,'supplement');
});

for(const reason of ['request timed out','connection closed'])test(`ambiguous steer failure (${reason}) never falls back even after turn completion`,{timeout:2000},async()=>{
  const f=fixture(),original=f.event('original','原任务'),gate=deferred();await f.bridge.handle(original);
  const base=f.rpc.call.bind(f.rpc);f.rpc.call=async(method,params)=>{if(method!=='turn/steer')return base(method,params);f.rpc.calls.push({method,params});return gate.promise;};
  const supplement=f.bridge.handle(f.event('supplement','补充'));
  await until(()=>calls(f,'turn/steer').length===1,'supplement should reach steer before completion');
  completed(f,original);await tick();gate.reject(new Error(reason));await supplement;
  assert.equal(calls(f,'turn/start').length,1);assert.equal(calls(f,'turn/steer').length,1);
  assert(f.sent.some(x=>x.messageId==='supplement'&&x.text.includes(reason)));
});

test('a new turn start timeout clears the previous turn id so later input cannot steer the old turn',{timeout:2000},async()=>{
  const f=fixture(),original=f.event('original','第一轮');await f.bridge.handle(original);
  assert.equal(state(f,original).turnId,'turn-1');completed(f,original);await tick();
  const base=f.rpc.call.bind(f.rpc);f.rpc.call=async(method,params)=>{if(method!=='turn/start')return base(method,params);f.rpc.calls.push({method,params});throw new Error('turn/start request timed out');};
  await f.bridge.handle(f.event('second','第二轮'));
  assert(!state(f,original).turnId);
  await f.bridge.handle(f.event('third','第三条输入'));
  assert.equal(calls(f,'turn/start').length,2);assert.equal(calls(f,'turn/steer').length,0);
});

test('stop during thread creation prevents the prepared input from starting a turn afterwards',{timeout:2000},async()=>{
  const f=fixture(),gate=deferred(),base=f.rpc.call.bind(f.rpc);
  f.rpc.call=async(method,params)=>{if(method!=='thread/start')return base(method,params);f.rpc.calls.push({method,params});return gate.promise;};
  const original=f.event('original','正在创建会话的任务'),pending=f.bridge.handle(original);
  await until(()=>calls(f,'thread/start').length===1,'thread creation should begin');
  await f.bridge.handle(f.event('stop','/stop'));
  gate.resolve({thread:{id:'thread-1'}});await pending;
  assert.equal(calls(f,'turn/start').length,0);assert.equal(state(f,original).active,false);
});

test('stop while a rejected supplement waits for old result delivery prevents fallback submission',{timeout:2000},async()=>{
  const f=fixture(),original=f.event('original','原任务'),steer=deferred(),delivery=deferred();await f.bridge.handle(original);
  const base=f.rpc.call.bind(f.rpc);f.rpc.call=async(method,params)=>{if(method!=='turn/steer')return base(method,params);f.rpc.calls.push({method,params});return steer.promise;};
  f.bridge.deliver=()=>delivery.promise;
  const supplement=f.bridge.handle(f.event('supplement','补充'));
  await until(()=>calls(f,'turn/steer').length===1,'supplement should reach steer');
  completed(f,original);steer.reject(Object.assign(new Error('turn already completed'),{definite:true}));await tick();
  await f.bridge.handle(f.event('stop','/stop'));
  delivery.resolve();await supplement;
  assert.equal(calls(f,'turn/start').length,1);assert.equal(calls(f,'turn/steer').length,1);
});

test('initial image preparation failure cancels already queued text instead of starting a task without its image',{timeout:2000},async()=>{
  const f=fixture(),gate=deferred();let preparing=false;
  f.bridge.media={prepare:async e=>{if(e.id==='image'){preparing=true;await gate.promise;throw new Error('image download failed');}return [{type:'text',text:e.text}];}};
  const image=f.bridge.handle(f.event('image','',{attachments:[{filename:'question.png'}]}));
  await until(()=>preparing,'initial image should begin preparation');
  const text=f.bridge.handle(f.event('text','图片中任选一题'));
  await tick();gate.resolve();await Promise.all([image,text]);
  assert.equal(calls(f,'turn/start').length,0);assert.equal(calls(f,'turn/steer').length,0);
  assert(f.sent.some(x=>x.messageId==='text'&&x.text.includes('未提交')));
  await f.bridge.handle(f.event('fresh','新的独立任务'));
  assert.deepEqual(calls(f,'turn/start').map(x=>x.params.input[0].text),['新的独立任务']);
});

test('definite thread creation failure cancels queued followups while allowing a later independent task',{timeout:2000},async()=>{
  const f=fixture(),gate=deferred(),base=f.rpc.call.bind(f.rpc);let rejectFirst=true;
  f.rpc.call=async(method,params)=>{if(method!=='thread/start'||!rejectFirst)return base(method,params);f.rpc.calls.push({method,params});rejectFirst=false;return gate.promise;};
  const original=f.bridge.handle(f.event('original','首任务'));
  await until(()=>calls(f,'thread/start').length===1,'initial thread creation should begin');
  const followup=f.bridge.handle(f.event('followup','补充原任务'));
  await tick();gate.reject(Object.assign(new Error('thread creation denied'),{definite:true}));await Promise.all([original,followup]);
  assert.equal(calls(f,'turn/start').length,0);
  assert(f.sent.some(x=>x.messageId==='followup'&&x.text.includes('未提交')));
  await f.bridge.handle(f.event('fresh','独立新任务'));
  assert.equal(calls(f,'turn/start').length,1);
});

test('failure from media preparation cancelled by stop cannot cancel a newer independent request',{timeout:2000},async()=>{
  const f=fixture(),gate=deferred();let preparing=false;
  f.bridge.media={prepare:async e=>{if(e.id==='cancelled'){preparing=true;await gate.promise;throw new Error('old cancelled download failed');}return [{type:'text',text:e.text}];}};
  const old=f.bridge.handle(f.event('cancelled','旧图片',{attachments:[{filename:'old.png'}]}));
  await until(()=>preparing,'old media should begin preparation');
  await f.bridge.handle(f.event('stop','/stop'));
  const fresh=f.bridge.handle(f.event('fresh','停止后的独立任务'));
  gate.resolve();await Promise.all([old,fresh]);
  assert.deepEqual(calls(f,'turn/start').map(x=>x.params.input[0].text),['停止后的独立任务']);
});

test('failure from thread creation cancelled by stop cannot cancel a newer independent request',{timeout:2000},async()=>{
  const f=fixture(),gate=deferred(),base=f.rpc.call.bind(f.rpc);let first=true;
  f.rpc.call=async(method,params)=>{if(method!=='thread/start'||!first)return base(method,params);first=false;f.rpc.calls.push({method,params});return gate.promise;};
  const old=f.bridge.handle(f.event('cancelled','旧任务'));
  await until(()=>calls(f,'thread/start').length===1,'old thread creation should begin');
  await f.bridge.handle(f.event('stop','/stop'));
  const fresh=f.bridge.handle(f.event('fresh','停止后的独立任务'));
  gate.reject(Object.assign(new Error('old thread creation denied'),{definite:true}));await Promise.all([old,fresh]);
  assert.deepEqual(calls(f,'turn/start').map(x=>x.params.input[0].text),['停止后的独立任务']);
});
