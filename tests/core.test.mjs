import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Bridge } from '../src/core/bridge.mjs';
import { parseMessage } from '../src/qq/events.mjs';
import { within } from '../src/shared/path-security.mjs';
import { Media } from '../src/media/processor.mjs';
import { safeMediaURL } from '../src/qq/media-url.mjs';
import { Accounts } from '../src/core/accounts.mjs';
import { Memory } from '../src/core/memory.mjs';
import { History, UNASSIGNED } from '../src/history/store.mjs';
import { QQ } from '../src/qq/client.mjs';
import { Models } from '../src/core/models.mjs';
import { menu, requestButtons } from '../src/qq/controls.mjs';
import { COMMANDS, PANEL_REMARK, syncCommands, syncQuickMenu } from '../src/qq/commands.mjs';
class MockRPC extends EventEmitter {
  constructor(){super();this.calls=[];this.replies=[];this.count=0;}
  async call(method,params){this.calls.push({method,params});return method.startsWith('thread/')?{thread:{id:'thread-'+(++this.count)}}:method==='turn/start'?{turn:{id:'turn-'+this.count}}:method==='turn/steer'?{turnId:params.expectedTurnId}:{};}
  reply(id,result){this.replies.push({id,result});}write(m){this.replies.push(m);}
}
function fixture(owner='A'){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-codex-test-')),rpc=new MockRPC(),sent=[];
  const config={ownerOpenId:owner,workspace:root,allowedRoots:[root],allowedGroups:[]};
  const bridge=new Bridge(config,rpc,async(e,text)=>sent.push({user:e.user,text}),()=>{},path.join(root,'sessions.json'));
  return {root,rpc,sent,bridge,config,event:(text,id=Math.random().toString())=>({text,id,user:owner,chat:owner,group:false,attachments:[]})};
}
async function modelFixture(owner='A'){
  const f=fixture(owner),base=f.rpc.call.bind(f.rpc);f.rpc.call=async(method,params)=>method==='config/read'?{config:{model:'base',model_reasoning_effort:'high'}}:method==='model/list'?{data:[{model:'base',displayName:'Base',supportedReasoningEfforts:[{reasoningEffort:'high'}],defaultReasoningEffort:'high',inputModalities:['text','image']},{model:'fast',displayName:'Fast',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'medium'}],defaultReasoningEffort:'medium',inputModalities:['text']},{model:'hidden',hidden:true,supportedReasoningEfforts:[]}],nextCursor:null}:base(method,params);
  f.user={id:owner,workspace:f.root};f.saved=[];f.models=new Models(f.rpc,f.user,()=>f.saved.push(structuredClone(f.user)),()=>[...f.bridge.sessions.values()].some(s=>s.active||s.busy||s.delivering));await f.models.init();f.bridge.models=f.models;return f;
}
test('model preferences are validated, durable and isolated per account',async()=>{
  const a=await modelFixture(),b=await modelFixture('B');assert.equal((await a.models.list()).length,2);await a.bridge.handle(a.event('/model fast low'));assert.deepEqual(a.models.current(),{model:'fast',effort:'low',inherited:false});assert.equal(b.models.current().model,'base');const restored=new Models(a.rpc,JSON.parse(JSON.stringify(a.saved.at(-1))),()=>{});await restored.init();assert.equal(restored.current().model,'fast');await assert.rejects(a.models.change('bad'),/列表/);await assert.rejects(a.models.change('fast','ultra'),/支持/);assert.equal(a.models.current().effort,'low');await a.models.change('default');assert.equal(a.user.model,undefined);assert.equal(a.models.current().model,'base');
});
test('model changes wait for idle and preserve the thread while overriding the next turn',async()=>{
  const f=await modelFixture();await f.bridge.handle(f.event('第一轮'));await assert.rejects(f.models.change('fast'),/执行/);f.rpc.emit('notification',{method:'turn/completed',params:{threadId:'thread-1',turn:{status:'completed'}}});await new Promise(r=>setImmediate(r));await f.bridge.handle(f.event('/model fast low'));await f.bridge.handle(f.event('第二轮'));const turns=f.rpc.calls.filter(x=>x.method==='turn/start');assert.equal(turns[0].params.model,'base');assert.equal(turns[1].params.model,'fast');assert.equal(turns[1].params.effort,'low');assert.equal(turns[1].params.threadId,turns[0].params.threadId);assert.equal(f.rpc.calls.filter(x=>x.method==='thread/start').length,1);const fresh=new Bridge(f.config,new MockRPC(),async()=>{},()=>{},path.join(f.root,'sessions.json'));assert.equal([...fresh.sessions.values()][0].model,'fast');
});
test('model changes block concurrent turns during persistence and reject image-incompatible choices',async()=>{
  const f=await modelFixture();f.models.catalog=null;let release;const base=f.rpc.call;f.rpc.call=(method,params)=>method==='model/list'?new Promise(r=>{release=r;}):base(method,params);const pending=f.models.change('fast','low');await f.bridge.handle(f.event('竞态任务'));assert.equal(f.rpc.calls.filter(x=>x.method==='turn/start').length,0);release({data:[{model:'fast',displayName:'Fast',supportedReasoningEfforts:[{reasoningEffort:'low'}],defaultReasoningEffort:'low',inputModalities:['text']}],nextCursor:null});await pending;await assert.rejects(f.models.validateInput([{type:'localImage',path:'x.png'}]),/仅支持文字/);
});
test('failed model persistence restores the previous account settings',async()=>{
  const f=await modelFixture();f.models.persist=()=>{throw new Error('disk failed');};await assert.rejects(f.models.change('fast','low'),/disk failed/);assert.equal(f.user.model,undefined);assert.equal(f.models.current().model,'base');assert.equal(f.models.changing,false);
});
test('separate users: same RPC request id and approval number never cross',async()=>{
  const a=fixture('A'),b=fixture('B');await Promise.all([a.bridge.handle(a.event('记住 A 的秘密')),b.bridge.handle(b.event('记住 B 的秘密'))]);
  for(const f of [a,b])f.rpc.emit('request',{id:42,method:'item/commandExecution/requestApproval',params:{threadId:'thread-1',turnId:'turn-1',command:'echo OK'}});
  await a.bridge.handle({...a.event('/approve 1'),user:'B'});assert.equal(a.rpc.replies.length,0);assert.equal(b.rpc.replies.length,0);
  await a.bridge.handle(a.event('/approve 1'));assert.equal(a.rpc.replies[0].result.decision,'accept');assert.equal(b.rpc.replies.length,0);
  a.rpc.emit('notification',{method:'item/completed',params:{threadId:'thread-1',item:{type:'agentMessage',text:'ONLY_A',phase:'final_answer'}}});
  a.rpc.emit('notification',{method:'turn/completed',params:{threadId:'thread-1',turn:{status:'completed'}}});
  assert(a.sent.some(x=>x.text==='ONLY_A'&&x.user==='A'));assert(!b.sent.some(x=>x.text.includes('ONLY_A')));
});
test('same message delivered twice only starts one task',async()=>{const f=fixture();await Promise.all([f.bridge.handle(f.event('执行','same')),f.bridge.handle(f.event('执行','same'))]);assert.equal(f.rpc.calls.filter(x=>x.method==='turn/start').length,1);});
test('active task accepts additional input while status and stop remain available',async()=>{const f=fixture();await f.bridge.handle(f.event('执行'));await f.bridge.handle(f.event('另一个'));await f.bridge.handle(f.event('/status'));await f.bridge.handle(f.event('/stop'));assert.equal(f.rpc.calls.filter(x=>x.method==='turn/start').length,1);assert.equal(f.rpc.calls.filter(x=>x.method==='turn/steer').length,1);assert(f.rpc.calls.some(x=>x.method==='turn/interrupt'));});
test('failed task stays associated with its original message after supplements and status commands',async()=>{
  const f=fixture(),original=f.event('看图','original'),results=[],delivered=[];
  f.bridge.onResult=(e,result)=>results.push({messageId:e.id,...result});
  f.bridge.send=async(e,text)=>delivered.push({messageId:e.id,text});
  await f.bridge.handle(original);
  await f.bridge.handle(f.event('在图片上','supplement'));
  await f.bridge.handle(f.event('/status','status'));
  f.rpc.emit('notification',{method:'turn/completed',params:{threadId:'thread-1',turn:{status:'failed',error:{message:'workspace routing discovery failed'}}}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(results.map(x=>[x.messageId,x.status,x.text]),[['original','failed','workspace routing discovery failed']]);
  assert.deepEqual(delivered.filter(x=>x.text==='workspace routing discovery failed'),[{messageId:'original',text:'workspace routing discovery failed'}]);
  const s=f.bridge.sessions.get(f.bridge.key(original));assert.equal(s.active,false);assert.equal(s.busy,false);assert.equal(s.delivering,false);
  await f.bridge.handle(f.event('下一轮','next'));
  assert.equal(f.rpc.calls.filter(x=>x.method==='turn/start').length,2);
});
test('group approval cannot resolve private conversation',async()=>{const f=fixture();f.config.allowedGroups=['group'];await f.bridge.handle(f.event('执行'));f.rpc.emit('request',{id:2,method:'item/fileChange/requestApproval',params:{threadId:'thread-1'}});await f.bridge.handle({...f.event('/approve 1'),group:true,chat:'group'});assert.equal(f.rpc.replies.length,0);});
test('unauthorized account is silent and allocates no session',async()=>{const f=fixture();await f.bridge.handle({...f.event('执行'),user:'stranger'});assert.equal(f.rpc.calls.length,0);assert.equal(f.bridge.sessions.size,0);assert.equal(f.sent.length,0);});
test('restart retains each session but discards outstanding approvals',async()=>{const f=fixture();await f.bridge.handle(f.event('执行'));const fresh=new Bridge(f.config,new MockRPC(),async()=>{},()=>{},path.join(f.root,'sessions.json'));assert.equal([...fresh.sessions.values()][0].threadId,'thread-1');assert.equal(fresh.questions.size,0);assert.match([...fresh.sessions.values()][0].status,/待核实/);});
test('project reassignment does not resume previous directory session',async()=>{const f=fixture();await f.bridge.handle(f.event('执行'));const other=fs.mkdtempSync(path.join(os.tmpdir(),'qq-other-'));const fresh=new Bridge({...f.config,workspace:other,allowedRoots:[other]},new MockRPC(),async()=>{},()=>{},path.join(f.root,'sessions.json'));assert.equal(fresh.sessions.size,0);});
test('root matching blocks traversal and sibling prefix',()=>{const f=fixture();fs.mkdirSync(path.join(f.root,'sub'));assert(within(f.root,path.join(f.root,'sub')));assert(!within(f.root,path.dirname(f.root)));});
test('attachment URL guard blocks local and disguised hosts, accepts QQ NT CDN and upgrades HTTP',()=>{for(const url of ['ftp://a.qq.com/x','https://127.0.0.1/x','https://qq.com.evil.test/x','https://user:secret@qpic.cn/x','https://qqbot.ugcimg.cn.evil.test/x','https://other.ugcimg.cn/x'])assert.throws(()=>safeMediaURL(url));assert.equal(safeMediaURL('http://qqbot.ugcimg.cn/voice.wav'),'https://qqbot.ugcimg.cn/voice.wav');assert.equal(safeMediaURL('//a.qpic.cn/image'),'https://a.qpic.cn/image');assert.equal(safeMediaURL('http://gchat.qpic.cn/x'),'https://gchat.qpic.cn/x');assert.equal(safeMediaURL('https://multimedia.nt.qq.com.cn/download'),'https://multimedia.nt.qq.com.cn/download');});
test('multi-modal event keeps each sender and attachments',()=>{const e=parseMessage('C2C_MESSAGE_CREATE',{id:'1',author:{user_openid:'A'},content:'看图',attachments:[{content_type:'image/png',url:'https://a.qpic.cn/x'}],msg_elements:[{author:{user_openid:'B'},content:'other private content'},{author:{user_openid:'A'},content:'mine'}]});assert.equal(e.user,'A');assert.equal(e.attachments.length,1);assert.equal(e.quoted.length,1);});
test('QQ built-in voice transcript becomes model input without download',async()=>{const f=fixture();const m=new Media({},{});m.download=()=>{throw new Error('must not download');};const input=await m.prepare({...f.event(''),attachments:[{content_type:'voice',asr_refer_text:'帮我创建文件'}]},f.root);assert.match(input[0].text,/帮我创建文件/);});
test('pairing codes are consumed once and allocate distinct account directories',async()=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-pair-')),config={appId:'123',users:[],usersRoot:root,pairingCodes:[{label:'A',pin:'one',expires:Date.now()+60000},{label:'B',pin:'two',expires:Date.now()+60000}]};const m=new Accounts(config,{send:async()=>{}},root,()=>{},()=>{});await m.handle({user:'A',chat:'A',group:false,text:'/pair one'});await m.handle({user:'B',chat:'B',group:false,text:'/pair two'});assert.equal(config.users.length,2);assert.notEqual(config.users[0].workspace,config.users[1].workspace);await m.handle({user:'C',chat:'C',group:false,text:'/pair one'});assert.equal(config.users.length,2);});
test('global memory is shared, private memory remains isolated and removable',()=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-memory-'));const a=new Memory(path.join(root,'global.json'),path.join(root,'A.json')),b=new Memory(path.join(root,'global.json'),path.join(root,'B.json'));a.write(a.globalFile,[{text:'SHARED_RULE'}]);const entry=a.add('ONLY_A');b.add('ONLY_B');assert(a.context().includes('SHARED_RULE'));assert(b.context().includes('SHARED_RULE'));assert(!a.context().includes('ONLY_B'));assert(!b.context().includes('ONLY_A'));a.remove(entry.id);assert(!a.context().includes('ONLY_A'));});
test('automatic rotation starts a new thread and carries only local recent summary and memory',async()=>{const f=fixture();f.config.rotationTurns=1;f.bridge.memory=new Memory(path.join(f.root,'global.json'),path.join(f.root,'private.json'));f.bridge.memory.add('PERSISTENT_PRIVATE');await f.bridge.handle(f.event('PREVIOUS_TASK'));f.rpc.emit('notification',{method:'item/completed',params:{threadId:'thread-1',item:{type:'agentMessage',text:'PREVIOUS_RESULT',phase:'final_answer'}}});f.rpc.emit('notification',{method:'turn/completed',params:{threadId:'thread-1',turn:{status:'completed'}}});await new Promise(r=>setImmediate(r));await f.bridge.handle(f.event('NEXT_TASK'));assert.equal(f.rpc.calls.filter(x=>x.method==='thread/start').length,2);const request=f.rpc.calls.filter(x=>x.method==='turn/start').at(-1);assert.match(request.params.input[0].text,/PREVIOUS_RESULT/);assert.match(request.params.input[0].text,/PERSISTENT_PRIVATE/);assert.equal(request.params.threadId,'thread-2');});
test('native compaction and context token events are reported without resetting active task',async()=>{const f=fixture();await f.bridge.handle(f.event('执行'));f.rpc.emit('notification',{method:'thread/tokenUsage/updated',params:{threadId:'thread-1',tokenUsage:{last:{inputTokens:12000},modelContextWindow:100000}}});f.rpc.emit('notification',{method:'item/completed',params:{threadId:'thread-1',item:{type:'contextCompaction'}}});const s=[...f.bridge.sessions.values()][0];assert.equal(s.compactions,1);assert.equal(s.tokenUsage.last.inputTokens,12000);assert.equal(s.active,true);});
test('history imports only account-local conversations once, excludes commentary and live duplicates',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-history-')),h=new History({appId:'test'},root);
  const folder=path.join(h.folder('A'),'codex-home/sessions');fs.mkdirSync(folder,{recursive:true});
  const records=[['2026-09-01','user_message','PRIVATE_A'],['2026-09-02','agent_message','RESULT_A','final_answer'],['2026-09-03','agent_message','COMMENTARY','commentary'],['2026-09-05','user_message','LIVE_DUPLICATE']].map(([timestamp,type,message,phase])=>JSON.stringify({timestamp,type:'event_msg',payload:{type,message,phase}}));
  records.push(JSON.stringify({timestamp:'2026-09-03',type:'event_msg',payload:{type:'item_completed',item:{type:'UserMessage',content:[{type:'text',text:'NEW_FORMAT'}]}}}));
  fs.writeFileSync(path.join(folder,'a.jsonl'),records.join('\n'));
  h.record('A',{time:'2026-09-04',kind:'inbound',text:'LIVE_MESSAGE'});h.record('B',{kind:'inbound',text:'PRIVATE_B'});
  h.importCodex('A');h.importCodex('A');
  assert.deepEqual(h.read('A').map(x=>x.text),['LIVE_MESSAGE','PRIVATE_A','RESULT_A','NEW_FORMAT']);assert.deepEqual(h.read('B').map(x=>x.text),['PRIVATE_B']);
});
test('completed model turn remains busy until its QQ result delivery finishes',async()=>{
  const f=fixture();await f.bridge.handle(f.event('执行'));let finish;f.bridge.deliver=()=>new Promise(resolve=>{finish=resolve;});
  const a=new Accounts({users:[]},{},f.root,()=>{},()=>{});a.instances.set('A',{bridge:f.bridge});
  f.rpc.emit('notification',{method:'turn/completed',params:{threadId:'thread-1',turn:{status:'completed'}}});
  assert.equal(a.busy(),true);finish();await new Promise(resolve=>setImmediate(resolve));assert.equal(a.busy(),false);
});
test('completed result delivery retains its text and files when the session is reset before delivery resumes',async()=>{
  const f=fixture(),original=f.event('生成文件','original'),sent=[],files=[];
  await f.bridge.handle(original);
  const file=path.join(f.root,'result.txt');fs.writeFileSync(file,'completed file');
  f.bridge.media={prepare:async e=>[{type:'text',text:e.text}],sendFile:async(e,file)=>files.push({messageId:e.id,file})};
  f.bridge.send=async(e,text)=>sent.push({messageId:e.id,text});
  const deliver=f.bridge.deliver.bind(f.bridge);let resume;
  const paused=new Promise(resolve=>{resume=resolve;});f.bridge.deliver=async completed=>{await paused;await deliver(completed);};
  const final=`已生成 [文件](${file})`;
  f.rpc.emit('notification',{method:'item/completed',params:{threadId:'thread-1',item:{type:'agentMessage',phase:'final_answer',text:final}}});
  f.rpc.emit('notification',{method:'turn/completed',params:{threadId:'thread-1',turn:{status:'completed'}}});
  await f.bridge.handle(f.event('/new','reset'));
  const next=f.bridge.handle(f.event('新任务','next'));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.rpc.calls.filter(x=>x.method==='turn/start').length,1);
  resume();await next;await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.rpc.calls.filter(x=>x.method==='turn/start').length,2);
  assert.deepEqual(sent.filter(x=>x.text===final),[{messageId:'original',text:final}]);
  assert.deepEqual(files,[{messageId:'original',file}]);
  assert.equal(f.bridge.sessions.get(f.bridge.key(original)).delivering,false);
});
test('native approval tokens reject foreign users, stale turns and duplicate clicks',async()=>{
  const f=fixture();await f.bridge.handle(f.event('执行'));
  const request=()=>f.rpc.emit('request',{id:45,method:'item/commandExecution/requestApproval',params:{threadId:'thread-1',turnId:'turn-1',command:'echo OK'}});request();
  const q=f.bridge.questions.get('1'),data=requestButtons(f.event(''),'1',q)[0][0].action.data;
  await f.bridge.handle({...f.event(data),user:'B',chat:'B'});await f.bridge.handle(f.event('/approve 1 '+'0'.repeat(32)));assert.equal(f.rpc.replies.length,0);
  await f.bridge.handle(f.event(data));await f.bridge.handle(f.event(data));assert.equal(f.rpc.replies.length,1);assert.equal(f.rpc.replies[0].result.decision,'accept');
  request();const q2=f.bridge.questions.get('2');[...f.bridge.sessions.values()][0].turnId='turn-2';await f.bridge.handle(f.event(`/deny 2 ${q2.nonce}`));assert.equal(f.rpc.replies.length,1);
  const m=menu(f.event(''));assert.equal(m[0][0].action.enter,true);assert.equal(m[0][0].action.type,2);assert.deepEqual(m[0][0].action.permission,{type:2});assert.equal(menu({...f.event(''),group:true})[0][0].action.enter,false);
});
test('native question selections preserve option text including pipes',async()=>{
  const f=fixture();await f.bridge.handle(f.event('执行'));f.rpc.emit('request',{id:55,method:'item/tool/requestUserInput',params:{threadId:'thread-1',questions:[{id:'a',question:'first?',options:[{label:'A | B'}]},{id:'b',question:'second?',options:[{label:'中文'}]}]}});
  const q=f.bridge.questions.get('1'),rows=requestButtons(f.event(''),'1',q);await f.bridge.handle(f.event(rows[0][0].action.data));assert.equal(f.rpc.replies.length,0);await f.bridge.handle(f.event(rows[1][0].action.data));assert.deepEqual(f.rpc.replies[0].result,{answers:{a:{answers:['A | B']},b:{answers:['中文']}}});
});
test('QQ keyboard falls back only on definite rejection, never ambiguous timeouts',async()=>{
  const e={user:'A',chat:'A',id:'message',group:false},qq=new QQ({},()=>{}),calls=[];qq.api=async(endpoint,body)=>{calls.push(body);if(body.msg_type===2)throw Object.assign(new Error('denied'),{code:40034029});return {};};
  await qq.sendButtons(e,'details',menu(e));assert.deepEqual(calls.map(x=>x.msg_type),[2,0]);assert.deepEqual(calls.map(x=>x.msg_seq),[1,2]);
  const ambiguous=new QQ({},()=>{});let attempts=0;ambiguous.api=async()=>{attempts++;throw new Error('timeout');};await assert.rejects(()=>ambiguous.sendButtons(e,'details',menu(e)),/timeout/);assert.equal(attempts,1);
});
test('generated image copied into own project and final delivery blocks sibling files',async()=>{
  const f=fixture(),other=fixture('B'),m=new Media({},{}),png=Buffer.from('89504e470d0a1a0a00000000','hex');
  const generated=m.saveGenerated({id:'image',result:png.toString('base64')},f.root,[f.root]);assert(within(f.root,generated));const foreign=path.join(other.root,'private.png');fs.writeFileSync(foreign,png);assert.throws(()=>m.saveGenerated({id:'evil',savedPath:foreign},f.root,[f.root]),/当前账号/);
  const sent=[];f.bridge.media={sendFile:async(e,file)=>sent.push({user:e.user,file})};await f.bridge.deliver({event:f.event(''),generated:[generated],last:`[image](${generated}) [foreign](${foreign})`});assert.deepEqual(sent,[{user:'A',file:generated}]);
});
test('manual transfers keep account manager busy through completion and failures',async()=>{
  const f=fixture(),a=new Accounts({users:[]},{},f.root,()=>{},()=>{});a.instances.set('A',{bridge:f.bridge});let done;const transfer=f.bridge.transfer(()=>new Promise(resolve=>{done=resolve;}));assert.equal(a.busy(),true);done();await transfer;assert.equal(a.busy(),false);await assert.rejects(()=>f.bridge.transfer(()=>{throw new Error('fail');}));assert.equal(a.busy(),false);
});
function panelMock(records=[]){const calls=[];return {calls,records,async api(endpoint,body,method){calls.push({endpoint,body,method});if(endpoint.startsWith('/v2/panels?'))return {records:this.records,is_end:true};if(endpoint==='/v2/panels'){const p={panel_id:'own',...body};this.records.push(p);return {panel_id:'own'};}const p=this.records.find(x=>endpoint==='/v2/panels/'+x.panel_id);assert(p);if(method==='PUT')p.panel=body.panel;return structuredClone(p);}};}
test('command sync creates only dedicated panel and subsequent sync is idempotent',async()=>{
  const unrelated={panel_id:'other',scope:'c2c',target_type:'all',panel:{remark:'custom',items:[{type:'command',name:'mycmd'}]}},qq=panelMock([structuredClone(unrelated)]);
  const first=await syncCommands(qq);assert.equal(first.action,'created');assert.equal(first.count,12);assert.deepEqual(qq.records[0],unrelated);const second=await syncCommands(qq);assert.equal(second.action,'unchanged');assert.equal(qq.calls.filter(x=>x.body).length,1);
  assert(COMMANDS.every(([name,desc])=>name.length<=14&&desc.length<=30));
});
test('command update retains custom owned entries and refuses overflow without writes',async()=>{
  const own={panel_id:'own',scope:'c2c',target_type:'all',panel:{remark:PANEL_REMARK,items:[{type:'command',name:'/status',desc:'old'},{type:'link',name:'site',link:'https://example.com'}]}},qq=panelMock([own]);await syncCommands(qq);assert.equal(qq.records[0].panel.items.at(-1).name,'site');assert(qq.calls.some(x=>x.method==='PUT'));
  const full=panelMock([{...own,panel:{remark:PANEL_REMARK,items:Array.from({length:11},(_,i)=>({type:'command',name:'custom'+i}))}}]);await assert.rejects(()=>syncCommands(full),/20/);assert.equal(full.calls.filter(x=>x.body).length,0);
});
test('QQ omitted empty records and canonicalized names do not cause duplicate panels',async()=>{
  const qq=panelMock();const api=qq.api.bind(qq);qq.api=async(endpoint,body,method)=>{if(endpoint.startsWith('/v2/panels?')&&!qq.records.length)return {is_end:true};const result=await api(endpoint,body,method);if(result.panel){result.panel.items=result.panel.items.map(({only_admin,...item})=>({...item,name:item.type==='command'?item.name.replace(/^\//,''):item.name}));}return result;};
  await syncCommands(qq);await syncCommands(qq);assert.equal(qq.calls.filter(x=>x.body).length,1);
});
test('native bottom menu preserves custom entries and only writes once',async()=>{
  const custom={type:'link',name:'网站',link:'https://example.com'};let items=[custom],writes=0;const qq={async api(endpoint,body,method){assert.equal(endpoint,'/v2/menu');if(method==='PUT'){items=body.menu.items;writes++;}return {menu:{items:structuredClone(items)}};}};
  await syncQuickMenu(qq);const second=await syncQuickMenu(qq);assert.equal(writes,1);assert.deepEqual(items[0],custom);assert.equal(second.preserved,1);assert.equal(second.groups.length,2);
});
test('native bottom menu refuses name conflicts and capacity overflow without mutation',async()=>{
  for(const items of [[{name:'Codex',type:'send_message',send_message:'/mine'}],Array.from({length:9},(_,i)=>({type:'send_message',name:'own'+i,send_message:'own'}))]){let writes=0;const qq={async api(endpoint,body){if(body)writes++;return {menu:{items}};}};await assert.rejects(()=>syncQuickMenu(qq));assert.equal(writes,0);}
});
test('public panel retires technical commands while preserving unrelated entries',async()=>{
  const qq=panelMock([{panel_id:'own',scope:'c2c',target_type:'all',panel:{remark:PANEL_REMARK,items:[...COMMANDS.map(([name,desc])=>({type:'command',name:name.slice(1),desc})),{type:'command',name:'custom'}]}}]);const result=await syncCommands(qq);assert.equal(result.count,12);assert.equal(result.custom,1);assert(!qq.records[0].panel.items.some(x=>['file','voice','forget','approve','deny','answer','media-test'].includes(x.name)));
});
function historyFixture(config={}){const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-history-db-'));return {root,h:new History({appId:'test',...config},root)};}
test('SQLite records and editable titles survive restart with account and session isolation',()=>{
  const {root,h}=historyFixture();h.record('A',{kind:'inbound',threadId:'one',text:'帮我整理图片',recordId:'a'});h.record('A',{kind:'inbound',threadId:'two',text:'只在第二会话',recordId:'b'});h.record('B',{kind:'inbound',threadId:'one',text:'其他账号秘密',recordId:'c'});assert.equal(h.sessions('A').sessions.length,2);assert.equal(h.page('A',{thread:'one'}).records[0].text,'帮我整理图片');assert.throws(()=>h.rename('B','two','偷改'));
  h.rename('A','one','图片整理');h.close();const fresh=new History({appId:'test'},root);assert.equal(fresh.sessions('A').sessions.find(s=>s.id==='one').title,'图片整理');assert.equal(fresh.page('A',{thread:'one'}).total,1);fresh.close();
});
test('keyset pages have no gaps with duplicate timestamps and concurrent newer records',()=>{
  const {h}=historyFixture();for(let i=0;i<75;i++)h.record('A',{recordId:'r'+i,time:'2026-09-30T00:00:00Z',kind:'inbound',threadId:'one',text:'消息'+i});let p=h.page('A',{thread:'one',limit:30});assert.equal(p.records.length,30);const first=p.records.map(x=>x.recordId);h.record('A',{recordId:'new',time:'2026-09-30T01:00:00Z',kind:'outbound',threadId:'one',text:'新消息'});const ids=[...first];while(p.next){p=h.page('A',{thread:'one',limit:30,before:p.next});ids.push(...p.records.map(x=>x.recordId));}assert.equal(new Set(ids).size,75);assert.equal(ids.length,75);assert.equal(h.updates('A','one',75).count,1);assert.throws(()=>h.page('A',{before:'broken'}));
  const plan=h.db.prepare('EXPLAIN QUERY PLAN SELECT payload FROM messages WHERE user=? AND thread_id=? AND (time,id)<(?,?) ORDER BY time DESC,id DESC LIMIT 30').all('A','one','2099',999);assert(plan.some(x=>x.detail.includes('messages_thread_time')));h.close();
});
test('Chinese substring search and quoted terms preserve exact matches across indexed sessions',()=>{
  const {h}=historyFixture();h.record('A',{threadId:'one',kind:'inbound',text:'我的代号蓝色香蕉 "ABC" 100%'});h.record('A',{threadId:'two',kind:'inbound',text:'蓝色香蕉属于另一会话'});h.record('B',{threadId:'one',kind:'inbound',text:'蓝色香蕉其他账号'});
  for(const q of ['蓝色香蕉','香蕉','"ABC"','100%'])assert.equal(h.page('A',{thread:'one',q}).total,1);assert.equal(h.page('A',{thread:'one',q:'另一会话'}).total,0);h.close();
});
test('pending inbound and attachment rows bind to the actual newly started session',async()=>{
  const {h}=historyFixture(),f=fixture();f.bridge.onSession=(e,s)=>h.bindMessage('A',e.id,s.threadId,e.text);const e=f.event('新会话标题','same');h.record('A',{kind:'inbound',messageId:e.id,text:e.text});h.record('A',{kind:'assets',messageId:e.id,files:[{path:'own.png'}]});await f.bridge.handle(e);assert.equal(e.historyThreadId,'thread-1');assert.equal(h.page('A',{thread:'thread-1'}).total,2);assert.equal(h.page('A',{thread:UNASSIGNED}).total,0);assert.equal(h.sessions('A').sessions[0].title,'新会话标题');h.close();
});
test('cleared history is not resurrected by JSONL or Codex backfill',()=>{
  const {root,h}=historyFixture({historyResetBefore:'2026-09-30T01:00:00Z'}),folder=h.folder('A');fs.mkdirSync(path.join(folder,'codex-home/sessions'),{recursive:true});fs.writeFileSync(path.join(folder,'messages.jsonl'),JSON.stringify({time:'2026-09-29',recordId:'old',kind:'inbound',text:'旧 QQ 消息'})+'\n');fs.writeFileSync(path.join(folder,'codex-home/sessions/a.jsonl'),JSON.stringify({timestamp:'2026-09-29',type:'event_msg',payload:{type:'user_message',message:'旧 Codex 消息'}})+'\n');h.migrateLegacy('A');h.importCodex('A');assert.equal(h.read('A').length,0);h.record('A',{time:'2026-09-30T02:00:00Z',kind:'inbound',threadId:'new',text:'新消息'});h.close();const fresh=new History({appId:'test',users:[{id:'A'}],historyResetBefore:'2026-09-30T01:00:00Z'},root);fresh.importCodex('A');assert.equal(fresh.read('A').length,1);assert.equal(fresh.read('A')[0].text,'新消息');fresh.close();
});
test('session export batches data and excludes other sessions and accounts',async()=>{
  const {root,h}=historyFixture();h.transaction(()=>{for(let i=0;i<1100;i++)h.record('A',{threadId:'one',kind:'inbound',text:'ROW'+i});});h.record('A',{threadId:'two',kind:'inbound',text:'PRIVATE_TWO'});h.record('B',{threadId:'one',kind:'inbound',text:'PRIVATE_B'});const file=path.join(root,'export.json'),count=await h.exportJSON('A',file,'one'),rows=JSON.parse(fs.readFileSync(file,'utf8'));assert.equal(count,1100);assert.equal(rows.length,1100);assert(rows.every(x=>x.threadId==='one'&&x.text.startsWith('ROW')));await assert.rejects(h.exportJSON('A',path.join(root,'missing','export.json'),'one'));assert.equal(h.exportsActive,0);h.close();
});
test('equal task results merge with their delivery even across page boundaries without deleting audit data',()=>{
  const {h}=historyFixture();h.record('A',{kind:'result',messageId:'m',threadId:'one',recordId:'result',time:'2026-10-08T00:00:00Z',text:'同一条回复',status:'completed',turnId:'t'});h.record('A',{kind:'outbound',messageId:'m',threadId:'one',recordId:'sent',time:'2026-10-08T00:00:01Z',text:'同一条回复'});
  const newer=h.page('A',{thread:'one',limit:1});assert.equal(newer.records[0].taskResult.turnId,'t');const older=h.page('A',{thread:'one',limit:1,before:newer.next});assert.equal(older.records[0].mergedInto,'sent');assert.equal(h.read('A').length,2);assert.equal(h.read('A')[0].mergedInto,undefined);h.close();
});
test('failed, partial, file and foreign account or session deliveries never hide a task result',()=>{
  const {h}=historyFixture();const result={kind:'result',messageId:'m',threadId:'one',recordId:'result',time:'2026-10-08T00:00:01Z',text:'完整任务结果XYZ',status:'completed'};h.record('A',result);for(const [user,extra] of [['B',{}],['A',{threadId:'two'}],['A',{file:'own.txt'}],['A',{buttons:['确认']}],['A',{time:'2026-10-08T00:00:00Z'}]])h.record(user,{...result,kind:'outbound',recordId:Math.random().toString(),time:'2026-10-08T00:00:02Z',...extra});assert.equal(h.page('A',{thread:'one'}).records.find(x=>x.kind==='result').mergedInto,undefined);
  h.record('A',{kind:'outbound',messageId:'m',threadId:'one',time:'2026-10-08T00:00:03Z',text:'完整任务\n（结果较长，完整内容保存在本机配置页。）'});const partial=h.page('A',{thread:'one'}).records.find(x=>x.kind==='result');assert.equal(partial.partialDelivery,true);assert.equal(partial.mergedInto,undefined);assert.equal(partial.text,result.text);h.record('A',{kind:'error',messageId:'fail',threadId:'one',text:'执行失败'});h.record('A',{kind:'outbound',messageId:'fail',threadId:'one',text:'执行失败'});assert.equal(h.page('A',{thread:'one'}).records.find(x=>x.kind==='error').mergedInto,undefined);h.close();
});
