import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { Writable } from 'node:stream';
import { createHistoryRoutes } from '../src/http/history-routes.mjs';

function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-history-routes-'));
  const first=path.join(root,'A'),second=path.join(root,'B');
  fs.mkdirSync(first);fs.mkdirSync(second);
  const config={users:[{id:'A',label:'甲',allowedRoots:[first],privateValue:'hidden'},{id:'B',label:'乙',allowedRoots:[second]}]};
  const calls=[],responses=[],exportsRoot=path.join(root,'exports');
  const history=Object.fromEntries(['sessions','page','updates','rename'].map(method=>[method,(...args)=>{calls.push({method,args});return {method,args};}]));
  history.exportJSON=async(user,file,thread)=>{calls.push({method:'exportJSON',args:[user,file,thread]});fs.writeFileSync(file,'[]');return 3;};
  const routes=createHistoryRoutes({config,accounts:{userKey:user=>'key-'+user},history,qq:{state:'READY'},base:'http://127.0.0.1:17329',exportsRoot,
    body:async req=>req.input,respond:(res,status,data)=>responses.push({status,data})});
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  return {root,first,second,config,calls,responses,exportsRoot,routes};
}
const request=(url,method='GET',input)=>({url,method,input});

test('history routes expose only public account fields and forward explicit account/session queries',async t=>{
  const f=fixture(t);
  assert.equal(await f.routes(request('/api/history/accounts'),{}),true);
  assert.deepEqual(f.responses.at(-1),{status:200,data:{qq:'READY',storage:'SQLite',users:[{id:'A',label:'甲'},{id:'B',label:'乙'}]}});
  await f.routes(request('/api/history/sessions?user=A&before=cursor&limit=60'),{});
  await f.routes(request('/api/history?user=A&thread=one&q=%E8%AF%8D&before=older&limit=10'),{});
  await f.routes(request('/api/history/updates?user=B&thread=two&after=42'),{});
  await f.routes(request('/api/history/title','POST',{user:'B',thread:'two',title:'新标题'}),{});
  assert.deepEqual(f.calls,[
    {method:'sessions',args:['A',{before:'cursor',limit:'60'}]},
    {method:'page',args:['A',{thread:'one',q:'词',before:'older',limit:'10'}]},
    {method:'updates',args:['B','two',42]},
    {method:'rename',args:['B','two','新标题']}
  ]);
});

test('unknown accounts cannot query, rename or export history',async t=>{
  const f=fixture(t);
  for(const req of [
    request('/api/history/sessions?user=foreign'),request('/api/history?user=foreign&thread=one'),
    request('/api/history/updates?user=foreign&thread=one'),request('/api/history/title','POST',{user:'foreign',thread:'one',title:'bad'}),
    request('/api/export','POST',{user:'foreign',thread:'one'})
  ])await assert.rejects(f.routes(req,{}),/账号不存在/);
  assert.equal(f.calls.length,0);assert.equal(f.responses.length,0);
  assert.equal(fs.existsSync(f.exportsRoot),false);
});

test('history query keeps an omitted thread distinct from an explicitly empty thread',async t=>{
  const f=fixture(t);
  await f.routes(request('/api/history?user=A'),{});
  await f.routes(request('/api/history?user=A&thread='),{});
  assert.equal(f.calls[0].args[1].thread,undefined);
  assert.equal(f.calls[1].args[1].thread,'');
});

test('session exports stay under the requested account export folder and return the generated file',async t=>{
  const f=fixture(t);
  assert.equal(await f.routes(request('/api/export','POST',{user:'B',thread:'two'}),{}),true);
  const call=f.calls[0],file=call.args[1];
  assert.deepEqual([call.method,call.args[0],call.args[2]],['exportJSON','B','two']);
  assert.equal(path.dirname(file),path.join(f.exportsRoot,'key-B'));
  assert.match(path.basename(file),/^history-[\dT-]+Z-[a-f\d]{6}\.json$/);
  assert.equal(fs.readFileSync(file,'utf8'),'[]');
  assert.deepEqual(f.responses.at(-1),{status:200,data:{file,count:3}});
});

test('assets reject foreign and sibling-prefix paths while streaming the current account file',async t=>{
  const f=fixture(t),file=path.join(f.first,'自有.png'),foreign=path.join(f.second,'private.png'),sibling=path.join(f.root,'A-sibling');
  fs.writeFileSync(file,'IMAGE');fs.writeFileSync(foreign,'PRIVATE');fs.mkdirSync(sibling);fs.writeFileSync(path.join(sibling,'private.png'),'SIBLING');
  const url=(user,file)=>'/api/asset?'+new URLSearchParams({user,file});
  for(const target of [foreign,path.join(sibling,'private.png'),f.first,'relative.png'])await assert.rejects(f.routes(request(url('A',target)),{}),/文件不属于当前账号目录/);
  await assert.rejects(f.routes(request(url('foreign',file)),{}),/文件不属于当前账号目录/);
  const chunks=[],headers=new Map(),res=new Writable({write(chunk,encoding,done){chunks.push(chunk);done();}});
  res.setHeader=(name,value)=>headers.set(name,value);
  const finished=once(res,'finish');
  assert.equal(await f.routes(request(url('A',file)),res),true);await finished;
  assert.equal(Buffer.concat(chunks).toString(),'IMAGE');assert.equal(headers.get('Content-Length'),5);
  assert.equal(headers.get('Content-Type'),'image/png');assert.match(headers.get('Content-Disposition'),/filename\*=UTF-8''/);
});

test('unrelated paths and wrong methods remain available to the outer application router',async t=>{
  const f=fixture(t);
  for(const req of [request('/health'),request('/api/history/accounts','POST'),request('/api/export'),request('/api/history?user=A','DELETE')])assert.equal(await f.routes(req,{}),false);
  assert.equal(f.calls.length,0);assert.equal(f.responses.length,0);
});
