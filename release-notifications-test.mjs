import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ReleaseNotifications } from './release-notifications.mjs';

const release={id:'mobile-message-combining-v1',text:'已支持连续图片和文字合并处理。'};
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
function fixture(t,options={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-release-notices-')),file=path.join(root,'runtime','release-notifications.json'),users=[{id:'A'},{id:'B'}],sent=[],records=[];
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const config={file,users:()=>users,send:async(user,text)=>{sent.push({user,text});return {id:`platform-${user.id}`};},record:async(user,entry)=>{records.push({user,entry});},...options};
  const notifications=new ReleaseNotifications(config);
  return {root,file,users,sent,records,config,notifications,state:()=>JSON.parse(fs.readFileSync(file,'utf8'))};
}

test('each currently paired account gets one durable attempt and one history record',async t=>{
  let f;f=fixture(t,{send:async(user,text)=>{const current=f.state().releases[0].recipients.find(entry=>entry.userId===user.id);assert.equal(current.status,'attempted');assert.equal(current.platformMessageId,undefined);f.sent.push({user,text});return {platformMessageId:`msg-${user.id}`};}});
  const counts=await f.notifications.broadcast(release);
  assert.deepEqual(counts,{recipients:2,attempted:2,sent:2,failed:0,unknown:0,skipped:0,storageErrors:0,recordErrors:0});
  assert.equal(f.records.length,2);assert.deepEqual(f.state().releases[0].recipients.map(entry=>[entry.userId,entry.status,entry.platformMessageId]),[['A','sent','msg-A'],['B','sent','msg-B']]);
  assert.equal(JSON.stringify(counts).includes('msg-A'),false);assert.equal(JSON.stringify(counts).includes('"A"'),false);
});

test('restart and repeated release skip previous attempts while newly paired accounts receive once',async t=>{
  const f=fixture(t);await f.notifications.broadcast(release);const restored=new ReleaseNotifications(f.config);
  f.users.push({id:'C'});const counts=await restored.broadcast(release);assert.equal(counts.skipped,2);assert.equal(counts.attempted,1);assert.equal(counts.sent,1);assert.deepEqual(f.sent.map(entry=>entry.user.id),['A','B','C']);
  f.users.splice(0,1);await restored.broadcast({...release,id:'next-release'});assert.deepEqual(f.sent.slice(-2).map(entry=>entry.user.id),['B','C']);
});

test('disabled notifications reject before writing or sending',async t=>{
  const f=fixture(t,{enabled:false});await assert.rejects(f.notifications.broadcast(release),/已禁用/);assert.equal(f.sent.length,0);assert.equal(fs.existsSync(f.file),false);
});

test('reusing a release ID with different text is refused',async t=>{
  const f=fixture(t);await f.notifications.broadcast(release);await assert.rejects(f.notifications.broadcast({...release,text:'different'}),/不同/);assert.equal(f.sent.length,2);assert.equal(f.state().releases[0].text,release.text);
});

test('concurrent same-release broadcasts are serialized without duplicate sends',async t=>{
  const gate=deferred(),sent=[],f=fixture(t,{send:async user=>{sent.push(user.id);if(user.id==='A')await gate.promise;return {id:user.id};}});
  const first=f.notifications.broadcast(release),second=f.notifications.broadcast(release);assert.equal(f.notifications.busy(),true);await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(sent,['A']);gate.resolve();const [a,b]=await Promise.all([first,second]);assert.equal(a.sent,2);assert.equal(b.skipped,2);assert.deepEqual(sent,['A','B']);assert.equal(f.notifications.busy(),false);
});

test('a queued different-text release is still refused after its predecessor finishes',async t=>{
  const gate=deferred(),f=fixture(t,{send:async user=>{await gate.promise;return {id:user.id};}}),first=f.notifications.broadcast(release),second=f.notifications.broadcast({...release,text:'changed'});
  const rejected=assert.rejects(second,/不同/);gate.resolve();await first;await rejected;assert.equal(f.state().releases.length,1);
});

test('only definite platform rejections are failed; uncertain outcomes are never retried',async t=>{
  const cases=[['forbidden',{status:403,code:123},'failed'],['business',{status:200,code:40001},'failed'],['code-only',{code:40001},'failed'],['explicit',{definite:true},'failed'],['timeout',{code:'UND_ERR_CONNECT_TIMEOUT'},'unknown'],['network',{code:'ECONNRESET'},'unknown'],['server',{status:503,code:123},'unknown'],['explicit-unknown',{status:400,definite:false},'unknown']];
  const f=fixture(t,{users:()=>cases.map(([id])=>({id})),send:async user=>{const [,details]=cases.find(([id])=>id===user.id);throw Object.assign(new Error('send failed'),details);}});
  const result=await f.notifications.broadcast(release);assert.equal(result.failed,4);assert.equal(result.unknown,4);assert.deepEqual(f.state().releases[0].recipients.map(entry=>[entry.userId,entry.status]),cases.map(([id,,status])=>[id,status]));
  const next=await new ReleaseNotifications(f.config).broadcast(release);assert.equal(next.attempted,0);assert.equal(next.skipped,8);
});

test('a successful HTTP response without a platform message ID remains unknown',async t=>{
  const f=fixture(t,{send:async()=>({ok:true})});const result=await f.notifications.broadcast(release);assert.equal(result.sent,0);assert.equal(result.unknown,2);assert.equal(f.state().releases[0].recipients[0].error.code,'MISSING_MESSAGE_ID');assert.equal((await f.notifications.broadcast(release)).skipped,2);
});

test('initial ledger persistence failure prevents every send',async t=>{
  const f=fixture(t);t.mock.method(fs,'renameSync',()=>{throw new Error('disk unavailable');});
  await assert.rejects(f.notifications.broadcast(release),err=>err.code==='NOTIFICATION_PERSIST_FAILED'&&err.counts.attempted===0);assert.equal(f.sent.length,0);assert.equal(f.records.length,0);assert.equal(fs.existsSync(f.file),false);
});

test('attempt persistence failure prevents send and preserves previous durable state',async t=>{
  const f=fixture(t),rename=fs.renameSync;let writes=0;
  t.mock.method(fs,'renameSync',(...args)=>{if(++writes===2)throw new Error('attempt save failed');return rename(...args);});
  await assert.rejects(f.notifications.broadcast(release),/无法安全保存/);assert.equal(f.sent.length,0);assert.equal(f.state().releases[0].recipients.length,0);
});

test('failure to persist a sent outcome leaves durable attempted and never resends after restart',async t=>{
  const f=fixture(t,{users:()=>[{id:'A'}]}),rename=fs.renameSync;let writes=0;
  const mock=t.mock.method(fs,'renameSync',(...args)=>{if(++writes===3)throw new Error('final save failed');return rename(...args);});
  const result=await f.notifications.broadcast(release);assert.equal(result.sent,1);assert.equal(result.storageErrors,1);assert.equal(f.sent.length,1);assert.equal(f.state().releases[0].recipients[0].status,'attempted');assert.equal(f.records[0].entry.status,'sent');assert.equal(f.records[0].entry.platformMessageId,'platform-A');
  mock.mock.restore();const restored=new ReleaseNotifications(f.config);assert.equal((await restored.broadcast(release)).skipped,1);assert.equal(f.sent.length,1);
  // The original instance can repair its dirty local outcome without another send.
  assert.equal((await f.notifications.broadcast(release)).skipped,1);assert.equal(f.state().releases[0].recipients[0].status,'sent');assert.equal(f.sent.length,1);
});

test('history failure does not change delivery status or cause another send or history replay',async t=>{
  let records=0;const f=fixture(t,{record:async()=>{records++;throw new Error('history unavailable');}}),result=await f.notifications.broadcast(release);
  assert.equal(result.sent,2);assert.equal(result.recordErrors,2);assert.equal(f.state().releases[0].recipients[0].status,'sent');assert.match(f.state().releases[0].recipients[0].recordError.message,/history/);
  await new ReleaseNotifications(f.config).broadcast(release);assert.equal(f.sent.length,2);assert.equal(records,2);
});

test('combined outcome-storage and history failures still cannot resend after restart',async t=>{
  const f=fixture(t,{users:()=>[{id:'A'}],record:async()=>{throw new Error('history down');}}),rename=fs.renameSync;let writes=0;
  const mock=t.mock.method(fs,'renameSync',(...args)=>{if(++writes>=3)throw new Error('disk down');return rename(...args);});
  const result=await f.notifications.broadcast(release);assert.equal(result.sent,1);assert.equal(result.recordErrors,1);assert.equal(result.storageErrors,2);assert.equal(f.state().releases[0].recipients[0].status,'attempted');
  mock.mock.restore();const restored=new ReleaseNotifications(f.config);assert.equal((await restored.broadcast(release)).skipped,1);assert.equal(f.sent.length,1);
});

test('account removal during a broadcast prevents its later send',async t=>{
  let f;f=fixture(t,{send:async user=>{f.sent.push(user.id);if(user.id==='A')f.users.splice(1,1);return {id:user.id};}});
  const result=await f.notifications.broadcast(release);assert.equal(result.sent,1);assert.equal(result.skipped,1);assert.deepEqual(f.sent,['A']);
});

test('disabling during an active broadcast prevents subsequent recipients',async t=>{
  let f;f=fixture(t,{send:async user=>{f.sent.push(user.id);f.notifications.enabled=false;return {id:user.id};}});
  await assert.rejects(f.notifications.broadcast(release),/已停止后续发送/);assert.deepEqual(f.sent,['A']);assert.equal(f.notifications.busy(),false);
});

test('an existing attempted record is skipped after a crash before final status is saved',async t=>{
  const f=fixture(t);fs.mkdirSync(path.dirname(f.file),{recursive:true});fs.writeFileSync(f.file,JSON.stringify({version:1,releases:[{...release,recipients:[{userId:'A',status:'attempted',attemptedAt:'2026-10-15T00:00:00Z'}]}]}));
  const restored=new ReleaseNotifications(f.config),result=await restored.broadcast(release);assert.equal(result.skipped,1);assert.equal(result.sent,1);assert.deepEqual(f.sent.map(entry=>entry.user.id),['B']);
});

test('empty and duplicate paired lists do not create extra sends',async t=>{
  const f=fixture(t,{users:()=>[]});assert.equal((await f.notifications.broadcast(release)).recipients,0);f.notifications.users=()=>[{id:'A'},{id:'A'}];const result=await f.notifications.broadcast(release);assert.equal(result.recipients,1);assert.equal(result.sent,1);
});

test('corrupt ledger fails closed instead of resetting the delivery history',t=>{
  const f=fixture(t);fs.mkdirSync(path.dirname(f.file),{recursive:true});fs.writeFileSync(f.file,'invalid json');assert.throws(()=>new ReleaseNotifications(f.config));
  fs.writeFileSync(f.file,JSON.stringify({version:1,releases:[{...release,recipients:[{userId:'A',status:'unexpected'}]}]}));assert.throws(()=>new ReleaseNotifications(f.config),/损坏/);assert.equal(f.sent.length,0);
});
