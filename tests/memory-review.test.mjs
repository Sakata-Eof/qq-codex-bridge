import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { Memory } from '../src/core/memory.mjs';
import { MEMORY_TOOL_NAME } from '../src/core/memory-learning.mjs';
import { MemoryReview } from '../src/core/memory-review.mjs';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function until(predicate){for(let attempt=0;attempt<30;attempt++){if(predicate())return;await tick();}assert.fail('Expected review RPC did not start');}
class ReviewRPC extends EventEmitter {
  constructor(){super();this.calls=[];this.replies=[];this.threads=0;this.turns=0;}
  async call(method,params){
    this.calls.push({method,params});
    if(method==='config/read')return {config:{mcp_servers:{inherited:{command:'not-started',tool_timeout_sec:''}}}};
    if(method==='thread/start')return {thread:{id:'review-'+(++this.threads)}};
    if(method==='turn/start'){
      const turn={id:'review-turn-'+(++this.turns)};
      this.emit('notification',{method:'turn/started',params:{threadId:params.threadId,turn}});
      return {turn};
    }
    return {};
  }
  reply(id,result){this.replies.push({id,result});}
  write(response){this.replies.push(response);}
}
function fixture(t,options={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-memory-review-')),memory=new Memory(path.join(root,'global.json'),path.join(root,'account','private-memory.json')),rpc=new ReviewRPC(),logs=[];
  memory.change({action:'configure',revision:memory.snapshot().revision,automatic:{enabled:true,reviewEveryTurns:options.interval||2}});
  const f={root,memory,rpc,logs,idle:true};
  f.runner=new MemoryReview({rpc,memory,cwd:root,skillPath:path.join(root,'SKILL.md'),modelParams:()=>({model:'account-model',effort:'low'}),isIdle:()=>f.idle,log:message=>logs.push(message),...(options.timeoutMs?{timeoutMs:options.timeoutMs}:{})});
  f.source=(id='one',userText='我喜欢先给结论，再给步骤。',extra={})=>({messageId:id,threadId:'main-thread',turnId:'main-turn-'+id,chat:'account-chat',group:false,userText,assistantText:'好的。',...extra});
  let requestId=0;
  f.request=(args,extra={})=>{
    const run=f.runner.run;
    const m={id:++requestId,method:'item/tool/call',params:{threadId:run?.threadId,turnId:run?.turnId,callId:'call-'+requestId,tool:MEMORY_TOOL_NAME,namespace:null,arguments:args,...extra}};
    assert.equal(f.runner.handleRequest(m),true);return f.rpc.replies.at(-1)?.result;
  };
  f.complete=(status='completed')=>{const run=f.runner.run;rpc.emit('notification',{method:'turn/completed',params:{threadId:run.threadId,turn:{id:run.turnId,status}}});};
  t.after(()=>{
    f.runner.stop();
    const relative=path.relative(path.resolve(os.tmpdir()),path.resolve(root));assert(relative.startsWith('qq-memory-review-')&&!relative.includes(path.sep));fs.rmSync(root,{recursive:true,force:true});
  });
  return f;
}
async function start(f,{force=false}={}){const promise=f.runner.flush({force});await until(()=>f.runner.run?.turnId);return {promise};}
const remember=(revision,evidence='先给结论，再给步骤')=>({action:'remember',revision,text:'用户偏好先给结论，再给步骤。',category:'preference',evidence});

test('periodic account review waits for the threshold and idle state without replacing the main conversation',async t=>{
  const f=fixture(t);assert.equal(f.runner.record(null),false);f.runner.record(f.source('one'));
  assert.equal(await f.runner.flush(),false);f.runner.record(f.source('two'));f.idle=false;assert.equal(await f.runner.flush(),false);assert.equal(f.rpc.calls.length,0);
  f.idle=true;const {promise}=await start(f),thread=f.rpc.calls.find(call=>call.method==='thread/start').params,turn=f.rpc.calls.find(call=>call.method==='turn/start').params;
  assert.equal(thread.ephemeral,true);assert.equal(thread.sandbox,'read-only');assert.equal(thread.model,'account-model');assert.equal(thread.config.model_reasoning_effort,'low');assert.equal(thread.config['features.shell_tool'],false);assert.equal(thread.config['features.unified_exec'],false);assert.equal(thread.config['features.apps'],false);assert.deepEqual(thread.config.mcp_servers,{inherited:{command:'not-started',enabled:false}});
  assert.equal(turn.effort,'low');assert.equal(turn.input[1].type,'skill');assert.equal(turn.input[1].name,'qq-memory-learning');assert.equal(f.runner.busy,true);assert.equal(await f.runner.flush({force:true}),false);
  f.complete();assert.equal(await promise,true);assert.equal(f.runner.busy,false);assert.equal(f.runner.status().lastAttempt.status,'completed');assert.equal(f.rpc.calls.some(call=>call.method==='thread/resume'),false);
});

test('review tool uses exact account evidence, preserves source metadata and deduplicates server calls',async t=>{
  const f=fixture(t);f.runner.record(f.source('one'));const {promise}=await start(f,{force:true}),run=f.runner.run;
  const loaded=f.request({action:'list'});assert.equal(loaded.success,true);
  const before=f.memory.snapshot();const args=remember(before.revision),saved=f.request(args,{callId:'stable-call'});assert.equal(saved.success,true);
  const entries=f.memory.snapshot().entries;assert.equal(entries.length,1);assert.equal(entries[0].source.messageId,'one');assert.equal(entries[0].source.threadId,'main-thread');assert.equal(entries[0].source.turnId,'main-turn-one');
  const revision=f.memory.snapshot().revision;assert.equal(f.request(args,{callId:'stable-call'}).success,true);assert.equal(f.memory.snapshot().revision,revision);assert.equal(f.memory.snapshot().entries.length,1);
  assert.equal(f.runner.handleRequest({id:100,method:'item/tool/call',params:{threadId:'foreign-thread',turnId:run.turnId,tool:MEMORY_TOOL_NAME,callId:'x',arguments:args}}),false);
  assert.equal(f.request(args,{turnId:'wrong-turn'}).success,false);assert.equal(f.memory.snapshot().revision,revision);
  f.complete();await promise;
});

test('review refuses unsupported tools, unverified assistant claims and absent evidence',async t=>{
  const f=fixture(t);f.runner.record(f.source('one','用户只说你好。',{assistantText:'我已经验证了全部测试成功。'}));const {promise}=await start(f,{force:true});
  assert.equal(f.request({action:'remember',revision:f.memory.snapshot().revision,text:'测试已全部验证成功',category:'lesson',evidence:'验证了全部测试成功'}).success,false);
  assert.equal(f.memory.snapshot().entries.length,0);
  assert.equal(f.request({action:'list'},{tool:'shell'}).success,false);
  const run=f.runner.run;
  assert.equal(f.runner.handleRequest({id:500,method:'item/commandExecution/requestApproval',params:{threadId:run.threadId,turnId:run.turnId}}),true);assert.deepEqual(f.rpc.replies.at(-1).result,{decision:'decline'});
  f.complete();await promise;
});

test('manual edits during a review block stale writes and cannot be rebased or replayed',async t=>{
  const f=fixture(t);f.runner.record(f.source('one'));const {promise}=await start(f,{force:true}),revision=f.memory.snapshot().revision;
  f.memory.add('MANUAL RULE');assert.equal(f.request(remember(revision)).success,false);assert.deepEqual(f.memory.snapshot().entries.map(entry=>entry.text),['MANUAL RULE']);
  assert.equal(f.request({action:'list'}).success,true);assert.equal(f.request(remember(f.memory.snapshot().revision)).success,false);assert.deepEqual(f.memory.snapshot().entries.map(entry=>entry.text),['MANUAL RULE']);
  f.complete('failed');assert.equal(await promise,false);assert.equal(await f.runner.flush({force:true}),false);assert.equal(f.rpc.calls.filter(call=>call.method==='thread/start').length,1);
});

test('turn snapshots remain account-local and no plaintext conversation is persisted in the review ledger',async t=>{
  const a=fixture(t),b=fixture(t);a.runner.record(a.source('one','ACCOUNT_A_ONLY 先给结论，再给步骤'));b.runner.record(b.source('one','ACCOUNT_B_ONLY'));
  const {promise}=await start(a,{force:true}),input=a.rpc.calls.find(call=>call.method==='turn/start').params.input[0].text;
  assert.match(input,/ACCOUNT_A_ONLY/);assert.doesNotMatch(input,/ACCOUNT_B_ONLY/);assert.equal(b.rpc.calls.length,0);
  const ledger=fs.readFileSync(a.runner.file,'utf8');assert.doesNotMatch(ledger,/ACCOUNT_A_ONLY|先给结论|account-chat|main-thread/);
  a.complete();await promise;
  a.runner.stop();a.runner=new MemoryReview({rpc:a.rpc,memory:a.memory,cwd:a.root,skillPath:path.join(a.root,'SKILL.md')});
  assert.equal(a.runner.record(a.source('one','ACCOUNT_A_ONLY 先给结论，再给步骤')),false);assert.equal(await a.runner.flush({force:true}),false);
});

test('disabling automatic memory during a running review prevents writes',async t=>{
  const f=fixture(t);f.runner.record(f.source('one'));const {promise}=await start(f,{force:true});
  f.memory.change({action:'configure',revision:f.memory.snapshot().revision,automatic:{enabled:false,reviewEveryTurns:2}});
  assert.equal(f.request(remember(f.memory.snapshot().revision)).success,false);assert.equal(f.memory.snapshot().entries.length,0);f.complete();await promise;
  assert.equal(f.runner.record(f.source('two')),false);assert.equal(await f.runner.flush({force:true}),false);
});

test('timeout and stop interrupt once, consume the attempt and reject late review writes',async t=>{
  const f=fixture(t,{timeoutMs:15});f.runner.record(f.source('one'));const {promise}=await start(f,{force:true}),run=f.runner.run;
  await delay(25);assert.equal(await promise,false);assert.equal(f.runner.status().lastAttempt.status,'timed_out');assert.equal(f.rpc.calls.filter(call=>call.method==='turn/interrupt').length,1);
  f.runner.stop();f.runner.stop();assert.equal(f.rpc.calls.filter(call=>call.method==='turn/interrupt').length,1);
  const before=f.memory.snapshot().revision;
  const late={id:700,method:'item/tool/call',params:{threadId:run.threadId,turnId:run.turnId,callId:'late',tool:MEMORY_TOOL_NAME,arguments:remember(before)}};
  assert.equal(f.runner.handleRequest(late),true);assert.equal(f.rpc.replies.at(-1).result.success,false);assert.equal(f.memory.snapshot().revision,before);
  const replies=f.rpc.replies.length;assert.equal(f.runner.handleRequest(late),true);assert.equal(f.rpc.replies.length,replies);
  assert.equal(await f.runner.flush({force:true}),false);
});

test('a new completed user turn queued during review is left for the next cadence',async t=>{
  const f=fixture(t);f.runner.record(f.source('one'));const {promise}=await start(f,{force:true});f.runner.record(f.source('two'));
  f.complete();await promise;assert.equal(f.runner.status().pendingTurns,1);assert.equal(await f.runner.flush(),false);
  f.runner.record(f.source('three'));const next=await start(f);f.complete();assert.equal(await next.promise,true);assert.equal(f.rpc.calls.filter(call=>call.method==='thread/start').length,2);
});

test('a stalled review setup times out without waiting for its uncertain RPC response',async t=>{
  const f=fixture(t,{timeoutMs:15}),original=f.rpc.call.bind(f.rpc);let release;
  f.rpc.call=(method,params)=>method==='config/read'?new Promise(resolve=>{release=resolve;}):original(method,params);
  f.runner.record(f.source('one'));const pending=f.runner.flush({force:true});await delay(25);
  assert.equal(await pending,false);assert.equal(f.runner.busy,false);assert.equal(f.runner.status().lastAttempt.status,'timed_out');
  release({config:{}});await tick();assert.equal(f.rpc.calls.some(call=>call.method==='thread/start'),false);assert.equal(await f.runner.flush({force:true}),false);
});

test('corrupted review state disables the worker without exposing stored data or replaying turns',async t=>{
  const f=fixture(t);f.runner.stop();fs.writeFileSync(f.runner.file,'{broken state');
  f.runner=new MemoryReview({rpc:f.rpc,memory:f.memory,cwd:f.root,skillPath:path.join(f.root,'SKILL.md'),log:message=>f.logs.push(message)});
  assert.equal(f.runner.status().unavailable,true);assert.equal(f.runner.record(f.source('one')),false);assert.equal(await f.runner.flush({force:true}),false);assert.equal(f.rpc.calls.length,0);assert(f.logs.every(message=>!message.includes(f.root)));
});
