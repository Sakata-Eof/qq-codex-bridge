import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { Bridge } from '../src/core/bridge.mjs';
import { Memory } from '../src/core/memory.mjs';
import { memorySkillFile } from '../src/paths.mjs';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
class RPC extends EventEmitter {
  constructor(){super();this.calls=[];this.replies=[];this.threads=0;this.turns=0;}
  async call(method,params){this.calls.push({method,params});if(method==='thread/start')return {thread:{id:'thread-'+(++this.threads)}};if(method==='thread/resume')return {thread:{id:params.threadId}};if(method==='turn/start')return {turn:{id:'turn-'+(++this.turns)}};return {};}
  reply(id,result){this.replies.push({id,result});}
  write(message){this.replies.push(message);}
}
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-bridge-memory-')),rpc=new RPC(),sent=[];
  t.after(()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert(path.basename(root).startsWith('qq-bridge-memory-'));fs.rmSync(root,{recursive:true,force:true});});
  const memory=new Memory(path.join(root,'global.json'),path.join(root,'private.json'));
  const config={ownerOpenId:'A',workspace:root,allowedRoots:[root],allowedGroups:[],memorySkillPath:memorySkillFile};
  const bridge=new Bridge(config,rpc,async(e,text)=>{sent.push({id:e.id,text});},()=>{},path.join(root,'sessions.json'),()=>{},null,memory);
  return {root,rpc,memory,bridge,config,sent,event:(id,text)=>({id,text,user:'A',chat:'A',group:false})};
}
function tool(f,args,extra={}){
  f.rpc.emit('request',{id:f.rpc.replies.length+1,method:'item/tool/call',params:{threadId:'thread-1',turnId:'turn-1',callId:'call-'+f.rpc.replies.length,tool:'qq_memory',arguments:args,...extra}});
  const result=f.rpc.replies.at(-1).result;return {...result,data:JSON.parse(result.contentItems[0].text)};
}
const finish=(f,status='completed')=>f.rpc.emit('notification',{method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status}}});

test('new main threads expose account memory and inject the managed skill without changing the task',async t=>{
  const f=fixture(t),e=f.event('source-a','以后请用简洁的中文回复');await f.bridge.handle(e);
  assert.equal(f.rpc.calls.find(call=>call.method==='thread/start').params.dynamicTools[0].name,'qq_memory');
  const input=f.rpc.calls.find(call=>call.method==='turn/start').params.input;assert(input[0].text.includes(e.text));assert.deepEqual(input[1],{type:'skill',name:'qq-memory-learning',path:memorySkillFile});
  const list=tool(f,{action:'list'});assert.equal(list.success,true);
  const saved=tool(f,{action:'remember',revision:list.data.revision,text:'用户偏好简洁的中文回复。',category:'preference',evidence:'用简洁的中文回复'});
  assert.equal(saved.success,true);assert.equal(saved.data.entry.source.messageId,'source-a');assert.equal(saved.data.entry.source.turnId,'turn-1');assert.equal(saved.data.entry.origin,'automatic');assert.equal(f.sent.length,0);
  finish(f);await tick();await f.bridge.handle(f.event('next','继续'));assert(f.rpc.calls.filter(call=>call.method==='turn/start').at(-1).params.input[0].text.includes('用户偏好简洁的中文回复。'));
});
test('main memory requests are account/thread/turn scoped and do not create QQ approvals',async t=>{
  const a=fixture(t),b=fixture(t);await a.bridge.handle(a.event('a','A 喜欢短回复'));await b.bridge.handle(b.event('b','B 喜欢详细回复'));
  for(const extra of [{threadId:'foreign'},{turnId:'old-turn'},{namespace:'foreign'},{tool:'not_memory'},{callId:''}])assert.equal(tool(a,{action:'list'},extra).success,false);
  const list=tool(a,{action:'list'}),saved=tool(a,{action:'remember',revision:list.data.revision,text:'A 偏好短回复',category:'preference',evidence:'A 喜欢短回复'});assert(saved.success);
  assert.equal(b.memory.snapshot().entries.length,0);assert.equal(a.bridge.questions.size,0);assert.equal(a.sent.length,0);
  finish(a);await tick();assert.equal(tool(a,{action:'list'}).success,false);
});
test('memory tool replay returns the same result and rejects a reused call id with changed arguments',async t=>{
  const f=fixture(t);await f.bridge.handle(f.event('a','偏好短回复'));
  const list=tool(f,{action:'list'}),args={action:'remember',revision:list.data.revision,text:'用户偏好短回复',category:'preference',evidence:'偏好短回复'};
  const first=tool(f,args,{callId:'stable'}),repeat=tool(f,args,{callId:'stable'});assert.deepEqual(repeat,first);assert.equal(f.memory.snapshot().entries.length,1);
  assert.equal(tool(f,{...args,text:'different'},{callId:'stable'}).success,false);assert.equal(f.memory.snapshot().entries.length,1);
});
test('accepted supplements supply their own evidence and source message attribution',async t=>{
  const f=fixture(t);await f.bridge.handle(f.event('original','帮我写一个文档'));await f.bridge.handle(f.event('supplement','以后所有文档用中文'));
  const list=tool(f,{action:'list'}),saved=tool(f,{action:'remember',revision:list.data.revision,text:'用户偏好文档使用中文。',category:'preference',evidence:'所有文档用中文'});
  assert(saved.success);assert.equal(saved.data.entry.source.messageId,'supplement');assert.equal(saved.data.entry.source.threadId,'thread-1');
});
test('automatic settings and manual concurrent edits are checked at every main tool write',async t=>{
  const f=fixture(t);await f.bridge.handle(f.event('a','我偏好 Python'));
  const list=tool(f,{action:'list'});f.memory.add('manual update');
  const args={action:'remember',revision:list.data.revision,text:'用户偏好 Python。',category:'preference',evidence:'偏好 Python'};
  assert.equal(tool(f,args).data.status,409);
  const current=f.memory.snapshot();f.memory.change({action:'configure',revision:current.revision,automatic:{enabled:false,reviewEveryTurns:10}});
  assert.equal(tool(f,{...args,revision:f.memory.snapshot().revision}).success,false);assert.equal(f.memory.snapshot().entries.length,1);
  finish(f);await tick();await f.bridge.handle(f.event('next','下一项'));assert.equal(f.rpc.calls.filter(call=>call.method==='turn/start').at(-1).params.input.some(item=>item.type==='skill'),false);
});
test('legacy threads resume with context intact and use review without retrofitting unavailable tools',async t=>{
  const f=fixture(t),event=f.event('legacy','已有会话');f.bridge.sessions.set(f.bridge.key(event),{cwd:f.root,threadId:'thread-1',active:false,loaded:false,turns:2,recent:[]});
  const recorded=[];f.bridge.memoryReview={record:source=>recorded.push(source),handleRequest:()=>false,flush:async()=>{}};
  await f.bridge.handle(event);assert(f.rpc.calls.some(call=>call.method==='thread/resume'));assert(!f.rpc.calls.some(call=>call.method==='thread/start'));assert.equal(f.rpc.calls.find(call=>call.method==='turn/start').params.input.length,1);
  finish(f);await tick();assert.equal(recorded.length,1);assert.equal(recorded[0].userText,'已有会话');assert.equal(recorded[0].validatedOutcome,false);assert.equal(tool(f,{action:'list'}).success,false);
});
test('review requests are routed once without becoming user approvals or QQ results',async t=>{
  const f=fixture(t);let reviews=0;f.bridge.memoryReview={handleRequest:m=>{if(m.params.threadId!=='review')return false;reviews++;f.rpc.reply(m.id,{success:true,contentItems:[]});return true;}};
  f.rpc.emit('request',{id:9,method:'item/tool/call',params:{threadId:'review',turnId:'review-turn',tool:'qq_memory'}});
  assert.equal(reviews,1);assert.equal(f.rpc.replies.length,1);assert.equal(f.sent.length,0);assert.equal(f.bridge.questions.size,0);
});
test('failed and interrupted tasks are excluded from memory review',async t=>{
  for(const status of ['failed','interrupted']){
    const f=fixture(t),recorded=[];f.bridge.memoryReview={record:source=>recorded.push(source),flush:async()=>{},handleRequest:()=>false};await f.bridge.handle(f.event('a','单次任务'));finish(f,status);await tick();assert.equal(recorded.length,0);
  }
});
