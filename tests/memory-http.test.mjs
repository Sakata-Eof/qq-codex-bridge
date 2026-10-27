import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Accounts } from '../src/core/accounts.mjs';
import { Memory } from '../src/core/memory.mjs';
import { createMemoryRoutes } from '../src/http/memory-routes.mjs';
import { authorizeUI } from '../src/http/auth.mjs';

function fixture(t){
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'qq-memory-http-'));
  const config={appId:'memory-test',users:[{id:'A'},{id:'B'}]};
  const accounts=new Accounts(config,{},temporary,()=>{},()=>{});
  accounts.get=()=>{throw new Error('Reading memory must not start Codex');};
  t.after(()=>{
    const relative=path.relative(path.resolve(os.tmpdir()),path.resolve(temporary));
    assert(relative.startsWith('qq-memory-http-')&&!relative.includes(path.sep));
    fs.rmSync(temporary,{recursive:true,force:true});
  });
  return {temporary,config,accounts,memory:user=>accounts.memory(config.users.find(item=>item.id===user))};
}

async function httpFixture(t){
  const f=fixture(t),secret='synthetic-memory-secret';
  const respond=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
  const body=async req=>{let raw='';for await(const chunk of req)raw+=chunk;return JSON.parse(raw||'{}');};
  let base,routes,reached=0;
  const server=http.createServer(async(req,res)=>{
    if(req.headers.host!==new URL(base).host||req.headers.origin&&req.headers.origin!==base)return respond(res,403,{error:'Local only'});
    if(!authorizeUI(req,secret,base))return respond(res,403,{error:'Login required'});
    reached++;
    if(!await routes(req,res))respond(res,404,{error:'Not found'});
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  base=`http://127.0.0.1:${server.address().port}`;
  routes=createMemoryRoutes({...f,base,respond,body});
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const request=async(url,input,headers={Authorization:'Bearer '+secret})=>{
    const response=await fetch(base+url,{method:input===undefined?'GET':'POST',headers,body:input===undefined?undefined:typeof input==='string'?input:JSON.stringify(input)});
    return {status:response.status,body:await response.json()};
  };
  return {...f,request,reached:()=>reached};
}

test('private memory HTTP requires local authenticated access before touching account data',async t=>{
  const f=await httpFixture(t);
  assert.equal((await f.request('/api/memory/private?user=A',undefined,{})).status,403);
  assert.equal((await f.request('/api/memory/private',{user:'A',action:'add',text:'blocked'},{})).status,403);
  assert.equal((await f.request('/api/memory/private?user=A',undefined,{Authorization:'Bearer synthetic-memory-secret',Origin:'https://foreign.example'})).status,403);
  assert.equal(f.reached(),0);
  assert.equal(fs.existsSync(path.join(f.temporary,'users')),false);
});

test('private memory HTTP CRUD uses existing account storage and preserves other accounts and shared memory',async t=>{
  const f=await httpFixture(t),a=f.memory('A'),b=f.memory('B');
  a.write(a.globalFile,[{id:'global',text:'shared rule'}]);
  const globalBefore=fs.readFileSync(a.globalFile,'utf8');
  const empty=await f.request('/api/memory/private?user=A');
  assert.equal(empty.status,200);assert.equal(empty.body.user,'A');assert.deepEqual(empty.body.entries,[]);
  assert.equal(fs.existsSync(path.dirname(a.privateFile)),false);
  const saved=await f.request('/api/memory/private',{user:'A',revision:empty.body.revision,action:'add',text:' private A '});
  assert.equal(saved.status,200);assert.equal(saved.body.ok,true);
  const entry=saved.body.entries[0];assert.equal(entry.text,'private A');assert.match(entry.id,/^[a-f0-9]{8}$/);assert(entry.created);
  const ownB=b.add('private B');
  const updated=await f.request('/api/memory/private',{user:'A',revision:saved.body.revision,action:'update',id:entry.id,text:'edited A'});
  assert.equal(updated.status,200);assert.equal(updated.body.entries[0].id,entry.id);assert.equal(updated.body.entries[0].created,entry.created);assert(updated.body.entries[0].updated);
  assert.match(a.context(),/edited A/);assert.doesNotMatch(a.context(),/private B/);assert.doesNotMatch(b.context(),/edited A/);
  const crossAccount=await f.request('/api/memory/private',{user:'A',revision:updated.body.revision,action:'remove',id:ownB.id});
  assert.equal(crossAccount.status,400);assert.deepEqual(b.snapshot().entries,[ownB]);
  const removed=await f.request('/api/memory/private',{user:'A',revision:updated.body.revision,action:'remove',id:entry.id});
  assert.equal(removed.status,200);assert.deepEqual(removed.body.entries,[]);
  assert.deepEqual(b.snapshot().entries,[ownB]);assert.equal(fs.readFileSync(a.globalFile,'utf8'),globalBefore);
  assert.equal(f.accounts.instances.size,0);assert.equal(f.accounts.starting.size,0);
  assert.equal((await f.request('/api/memory')).status,404);
});

test('stale HTTP edits cannot replace QQ additions or deletions and are never replayed',async t=>{
  const f=await httpFixture(t),memory=f.memory('A'),first=memory.add('first');
  const loaded=(await f.request('/api/memory/private?user=A')).body;
  const fromQQ=memory.add('added from QQ');
  const stale=await f.request('/api/memory/private',{user:'A',revision:loaded.revision,action:'update',id:first.id,text:'stale edit'});
  assert.equal(stale.status,409);assert.match(stale.body.error,/重新加载/);
  assert.deepEqual(memory.snapshot().entries.map(entry=>entry.text),['first','added from QQ']);
  const refreshed=memory.snapshot();memory.remove(first.id);
  const afterDelete=await f.request('/api/memory/private',{user:'A',revision:refreshed.revision,action:'add',text:'stale addition'});
  assert.equal(afterDelete.status,409);assert.deepEqual(memory.snapshot().entries,[fromQQ]);
});

test('two HTTP writers with the same revision only accept one mutation',async t=>{
  const f=await httpFixture(t),revision=f.memory('A').snapshot().revision;
  const attempts=await Promise.all(['first','second'].map(text=>f.request('/api/memory/private',{user:'A',revision,action:'add',text})));
  assert.deepEqual(attempts.map(result=>result.status).sort(),[200,409]);
  assert.equal(f.memory('A').snapshot().entries.length,1);
});

test('private memory rejects unbound accounts, ambiguous selectors and malformed mutations without writing',async t=>{
  const f=await httpFixture(t),memory=f.memory('A'),entry=memory.add('retain me'),before=fs.readFileSync(memory.privateFile,'utf8'),revision=memory.snapshot().revision;
  for(const query of ['','?user=absent','?user=..%2F..%2Fglobal-memory.json','?user=A&user=B'])assert.equal((await f.request('/api/memory/private'+query)).status,400,query);
  const invalid=[null,[],{}, {user:{}}, {user:'absent',revision,action:'add',text:'bad'}, {user:'A',action:'add',text:'no revision'},
    {user:'A',revision,action:'unknown'}, {user:'A',revision,action:'add',text:4}, {user:'A',revision,action:'add',text:'   '},
    {user:'A',revision,action:'add',text:'a'.repeat(2001)}, {user:'A',revision,action:'update',id:entry.id,text:[]},
    {user:'A',revision,action:'remove',id:[]}, {user:'A',revision,action:'remove',id:'foreign-entry'}];
  for(const input of invalid){const response=await f.request('/api/memory/private',input);assert.equal(response.status,400,JSON.stringify(input).slice(0,180));}
  assert.equal((await f.request('/api/memory/private','{invalid JSON')).status,400);
  assert.equal(fs.readFileSync(memory.privateFile,'utf8'),before);
  assert.equal(fs.existsSync(memory.privateFile+'.tmp'),false);
});

test('editing enforces existing entry, account count and total text limits without losing data',t=>{
  const f=fixture(t),memory=f.memory('A');
  for(let i=0;i<4;i++)memory.add('x'.repeat(2000));
  let snapshot=memory.snapshot();
  assert.throws(()=>memory.change({revision:snapshot.revision,action:'add',text:'extra'}),/已满/);
  assert.equal(memory.snapshot().revision,snapshot.revision);
  snapshot=memory.change({revision:snapshot.revision,action:'update',id:snapshot.entries[0].id,text:'shorter'});
  assert.equal(snapshot.entries[0].text,'shorter');
  memory.add('y'.repeat(1993));snapshot=memory.snapshot();
  assert.throws(()=>memory.change({revision:snapshot.revision,action:'update',id:snapshot.entries[0].id,text:'too long now'}),/已满/);
  assert.equal(memory.snapshot().revision,snapshot.revision);
  const b=f.memory('B');for(let i=0;i<40;i++)b.add('entry '+i);
  const full=b.snapshot();assert.throws(()=>b.change({revision:full.revision,action:'add',text:'41st'}),/已满/);
  assert.equal(b.snapshot().revision,full.revision);
  assert.throws(()=>b.change({revision:full.revision,action:'update',id:full.entries[0].id,text:'x'.repeat(2001)}),/2000/);
  assert.equal(b.snapshot().revision,full.revision);
});

test('private memory storage failures remain recoverable without disclosing local paths',async t=>{
  const f=await httpFixture(t),memory=f.memory('A');
  fs.mkdirSync(path.dirname(memory.privateFile),{recursive:true});
  for(const broken of ['not json','{}','[{"id":"bad","text":7}]']){
    fs.writeFileSync(memory.privateFile,broken);
    const response=await f.request('/api/memory/private?user=A');
    assert.equal(response.status,503);assert.match(response.body.error,/重新加载/);assert.equal(JSON.stringify(response.body).includes(f.temporary),false);
    assert.equal(fs.readFileSync(memory.privateFile,'utf8'),broken);
  }
  fs.writeFileSync(memory.privateFile,'[]');
  assert.equal((await f.request('/api/memory/private?user=A')).status,200);
});

test('private memory HTTP configures per-account learning and exposes only safe source metadata',async t=>{
  const f=await httpFixture(t),a=f.memory('A'),initial=a.snapshot();
  const configured=await f.request('/api/memory/private',{user:'A',revision:initial.revision,action:'configure',automatic:{enabled:false,reviewEveryTurns:7}});
  assert.equal(configured.status,200);assert.deepEqual(configured.body.automatic,{enabled:false,reviewEveryTurns:7});assert.deepEqual(f.memory('B').snapshot().automatic,{enabled:true,reviewEveryTurns:10});
  assert.equal((await f.request('/api/memory/private',{user:'A',revision:initial.revision,action:'configure',automatic:{enabled:true,reviewEveryTurns:10}})).status,409);
  for(const automatic of [{enabled:true,reviewEveryTurns:0},{enabled:true,reviewEveryTurns:201},{enabled:1,reviewEveryTurns:10},{enabled:true,reviewEveryTurns:10,path:'bad'}])assert.equal((await f.request('/api/memory/private',{user:'A',revision:configured.body.revision,action:'configure',automatic})).status,400);
  a.write(a.privateFile,[{id:'auto-1',text:'用户偏好中文',origin:'automatic',category:'preference',evidence:'请用中文',manualEdited:true,source:{messageId:'message-A',threadId:'thread-A',turnId:'turn-A',chat:'A',group:false,userText:'PRIVATE RAW USER',assistantText:'PRIVATE RAW ASSISTANT',path:'PRIVATE PATH'},privateField:'PRIVATE VALUE'}]);
  const visible=(await f.request('/api/memory/private?user=A')).body;
  assert.equal(visible.entries[0].origin,'automatic');assert.equal(visible.entries[0].category,'preference');assert.equal(visible.entries[0].manualEdited,true);assert.equal(visible.entries[0].source.messageId,'message-A');assert.equal(visible.entries[0].evidence,'请用中文');assert.equal(JSON.stringify(visible).includes('PRIVATE'),false);
});
