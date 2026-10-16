import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {performance} from 'node:perf_hooks';
import {authorizeUI,browserCookie} from './ui-auth.mjs';
test('browser sessions are shared credentials with expiry, signature and cross-origin checks',()=>{
  const secret='test-secret',base='http://127.0.0.1:17329',now=Date.now(),cookie=browserCookie(secret,now),req={method:'GET',headers:{cookie}};
  assert(cookie.includes('HttpOnly; SameSite=Strict'));assert(authorizeUI(req,secret,base,now));assert(!authorizeUI(req,secret,base,now+31*86400000));assert(!authorizeUI(req,'rotated-secret',base,now));assert(!authorizeUI({...req,headers:{cookie,origin:'https://evil.example'}},secret,base,now));assert(!authorizeUI({...req,headers:{cookie,'sec-fetch-site':'cross-site'}},secret,base,now));assert(!authorizeUI({...req,method:'POST'},secret,base,now));assert(authorizeUI({...req,method:'POST',headers:{cookie,origin:base}},secret,base,now));assert(authorizeUI({method:'POST',headers:{authorization:'Bearer '+secret}},secret,base,now));assert(!authorizeUI({...req,headers:{cookie,authorization:'Bearer stale'}},secret,base,now));
});
function element(){return {children:[],childNodes:[],dataset:{},style:{},hidden:false,classList:{toggle(){}},append(...nodes){this.children.push(...nodes);this.childNodes=this.children;},prepend(...nodes){this.children.unshift(...nodes);},replaceChildren(...nodes){this.children=nodes;this.childNodes=nodes;},setAttribute(){},addEventListener(){},focus(){}};}
function browserContext(fetch){
  const elements=new Map(),storage=new Map(),listeners=new Map(),document={hidden:false,body:element(),createElement:element,querySelector:()=>element(),getElementById:id=>{if(!elements.has(id))elements.set(id,element());return elements.get(id);},
    addEventListener(type,callback){if(!listeners.has(type))listeners.set(type,new Set());listeners.get(type).add(callback);},removeEventListener(type,callback){listeners.get(type)?.delete(callback);},dispatchEvent(event){for(const callback of [...listeners.get(event.type)||[]])callback(event);return true;}};
  return {elements,storage,context:vm.createContext({document,window:{addEventListener(){}},location:{hash:'',pathname:'/'},history:{replaceState(){}},sessionStorage:{getItem:key=>storage.get(key),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},fetch,AbortController,DOMException,setTimeout,clearTimeout,setInterval:()=>0,clearInterval(){},URL,URLSearchParams,Event,console,performance})};
}
const source=fs.readFileSync(new URL('./ui-client.js',import.meta.url),'utf8');
const response=(status,data)=>({status,ok:status===200,json:async()=>data});
const historySource=fs.readFileSync(new URL('./history.js',import.meta.url),'utf8');
const nextTurn=()=>new Promise(resolve=>setImmediate(resolve));
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function sessionRows(account='A',titlePrefix=''){return (account==='A'?['one','two','three']:['b-one']).map(id=>({id,title:titlePrefix+id,count:1,lastAt:'2026-10-15T00:00:00.000Z'}));}
function messagePage(text){return {records:[{kind:'inbound',time:'2026-10-15T00:00:00.000Z',text}],total:1,watermark:1,next:null};}
async function historyBrowser(intercept=()=>{},timers,clock){
  const b=browserContext(),calls=[];
  b.context.qqUI={read:key=>b.storage.get(key)||null,write:(key,value)=>b.storage.set(key,value),async request(url,body,signal){
    calls.push({url,body,signal});const result=intercept(url,body,signal);if(result!==undefined)return result;
    const query=new URL(url,'http://localhost').searchParams;
    if(url.startsWith('/api/history/accounts'))return {qq:'READY',users:[{id:'A',label:'A'},{id:'B',label:'B'}]};
    if(url.startsWith('/api/history/sessions'))return {sessions:sessionRows(query.get('user')),next:null};
    if(url.startsWith('/api/history/updates'))return {count:0};
    if(url.startsWith('/api/history?'))return messagePage('MESSAGE '+query.get('thread'));
    throw new Error(url);
  }};
  b.elements.set('pageSize',{...element(),value:'30'});b.elements.set('search',{...element(),value:''});
  if(clock)b.context.performance=clock;
  if(timers){let timerId=0;b.context.setTimeout=(callback,delay)=>{const id=++timerId;timers.set(id,{callback,delay});return id;};b.context.clearTimeout=id=>timers.delete(id);}
  vm.runInContext(historySource,b.context);await nextTurn();return {...b,calls};
}
const historyMessage=b=>b.elements.get('messages').children[0]?.children[1].textContent;
function paintClock(){
  let now=100,id=0;const frames=new Map(),timers=new Map();
  return {performance:{now:()=>now},advance(ms=1){now+=ms;return now;},get pendingFrames(){return frames.size;},
    install(b){b.context.requestAnimationFrame=callback=>{const key=++id;frames.set(key,callback);return key;};b.context.cancelAnimationFrame=key=>frames.delete(key);b.context.setTimeout=(callback,delay)=>{const key=++id;timers.set(key,{callback,delay});return key;};b.context.clearTimeout=key=>timers.delete(key);},
    async frame(){now+=16;const current=[...frames.values()];frames.clear();for(const callback of current)callback(now);await nextTurn();},
    async timeout(delay){now+=delay;const due=[...timers].filter(([,timer])=>timer.delay===delay);assert(due.length>0,`expected a ${delay} ms fallback`);for(const [key,timer] of due){timers.delete(key);timer.callback();}await nextTurn();}};
}
test('existing token establishes cookie login and subsequent requests omit bearer tokens',async()=>{
  const calls=[],b=browserContext(async(url,opts)=>{calls.push({url,opts});return response(200,{ok:true});});b.storage.set('qq-codex-admin-token','old-token');vm.runInContext(source,b.context);const client=vm.runInContext('qqUI',b.context);await client.request('/api/status');assert.equal(calls[0].url,'/api/session');assert.equal(calls[0].opts.headers.Authorization,'Bearer old-token');assert.equal(calls[1].opts.headers.Authorization,undefined);assert.equal(calls[1].opts.credentials,'same-origin');assert.equal(b.storage.has('qq-codex-admin-token'),false);
});
test('missing login reports an explicit auth error instead of silently returning empty data',async()=>{
  const b=browserContext(async()=>response(403,{}));vm.runInContext(source,b.context);const client=vm.runInContext('qqUI',b.context);await assert.rejects(client.request('/api/status'),e=>e.auth&&e.message.includes('Codex QQ 控制台'));
});
test('stalled reads time out, recover on next request and never retry a mutation automatically',async()=>{
  let stalled=true,mutations=0;const b=browserContext(async(url,opts)=>{if(url==='/api/session')return response(200,{});if(url==='/api/change')mutations++;if(stalled)return new Promise((_,reject)=>opts.signal.addEventListener('abort',()=>reject(new DOMException('cancel','AbortError')),{once:true}));return response(200,{recovered:true});});vm.runInContext(source,b.context);const client=vm.runInContext('qqUI',b.context);await assert.rejects(client.request('/api/status',null,null,5),/读取超时/);await assert.rejects(client.request('/api/change',{},null,5),/勿重复提交/);assert.equal(mutations,1);stalled=false;assert.equal((await client.request('/api/status')).recovered,true);
});
test('history retries a failed first message page rather than leaving a selected session empty',async()=>{
  let attempts=0;const b=browserContext();b.context.qqUI={read:()=>null,write(){},async request(url){if(url.startsWith('/api/history/accounts'))return {qq:'READY',users:[{id:'A',label:'A'}]};if(url.startsWith('/api/history/sessions'))return {sessions:[{id:'one',title:'one',count:1,lastAt:new Date().toISOString()}],next:null};if(url.startsWith('/api/history/updates'))return {count:0};if(url.startsWith('/api/history?')){attempts++;if(attempts===1)throw new Error('first page temporarily failed');return {records:[{kind:'inbound',time:new Date().toISOString(),text:'RECOVERED'}],total:1,watermark:1,next:null};}throw new Error(url);}};b.elements.set('pageSize',{...element(),value:'30'});b.elements.set('search',{...element(),value:''});vm.runInContext(fs.readFileSync(new URL('./history.js',import.meta.url),'utf8'),b.context);await new Promise(r=>setImmediate(r));assert.equal(attempts,1);assert.equal(b.elements.get('pageInfo').textContent,'未读取到消息数量');await vm.runInContext('poll(true)',b.context);assert.equal(attempts,2);assert.equal(b.elements.get('messages').children.length,1);assert.match(b.elements.get('pageInfo').textContent,/共 1 条/);
});
test('history displays matching results once, folds partial results and keeps unsent results',()=>{
  const b=browserContext();b.context.qqUI={read:()=>null,write(){},request:async()=>({users:[],qq:'READY'})};b.elements.set('search',{...element(),value:''});vm.runInContext(fs.readFileSync(new URL('./history.js',import.meta.url),'utf8'),b.context);b.context.sampleRows=[{kind:'result',text:'same',mergedInto:'sent',time:new Date().toISOString()},{kind:'outbound',text:'same',taskResult:{status:'completed'},time:new Date().toISOString()},{kind:'result',text:'full longer reply',partialDelivery:true,time:new Date().toISOString()},{kind:'result',text:'unsent reply',time:new Date().toISOString()}];const visible=vm.runInContext('render(sampleRows)',b.context);assert.equal(visible.displayed,3);assert.equal(visible.merged,1);const cards=b.elements.get('messages').children;assert.equal(cards[0].children[1].textContent,'same');assert.match(cards[0].children[0].textContent,/发送 · 任务结果/);assert.match(cards[1].children[1].children[0].textContent,/查看完整任务结果/);assert.equal(cards[1].children[1].children[1].textContent,'full longer reply');assert.match(cards[2].children[2].textContent,/尚未找到/);
});
test('history locks navigation until a session page finishes and removes the previous session content',async()=>{
  const pending=deferred();let hold=false;
  const b=await historyBrowser(url=>hold&&url.startsWith('/api/history?')&&new URL(url,'http://localhost').searchParams.get('thread')==='two'?pending.promise:undefined);
  assert.equal(historyMessage(b),'MESSAGE one');hold=true;
  const selection=vm.runInContext("selectSession('two')",b.context);
  assert.equal(b.elements.get('sessionTitle').textContent,'two');assert.equal(b.elements.get('messages').children.length,0);assert.doesNotMatch(b.elements.get('pageInfo').textContent,/共 1/);
  assert(b.elements.get('sessions').children.every(button=>button.disabled));assert(b.elements.get('users').children.every(button=>button.disabled));
  const requests=b.calls.length;await vm.runInContext("selectSession('three')",b.context);await vm.runInContext("selectAccount('B')",b.context);
  assert.equal(b.calls.length,requests);assert.equal(b.elements.get('sessionTitle').textContent,'two');
  pending.resolve(messagePage('MESSAGE two'));await selection;
  assert.equal(historyMessage(b),'MESSAGE two');assert(b.elements.get('sessions').children.every(button=>!button.disabled));assert(b.elements.get('users').children.every(button=>!button.disabled));
  await vm.runInContext("selectSession('three')",b.context);assert.equal(historyMessage(b),'MESSAGE three');
});
test('history releases navigation after a failed session page so another session can load',async()=>{
  let fail=false;const b=await historyBrowser(url=>fail&&url.startsWith('/api/history?')&&new URL(url,'http://localhost').searchParams.get('thread')==='two'?Promise.reject(new Error('message page failed')):undefined);
  fail=true;await vm.runInContext("selectSession('two')",b.context);
  assert.match(b.elements.get('state').textContent,/message page failed/);assert.equal(b.elements.get('loading').hidden,true);assert(b.elements.get('sessions').children.every(button=>!button.disabled));assert(b.elements.get('users').children.every(button=>!button.disabled));
  await vm.runInContext("selectSession('three')",b.context);assert.equal(historyMessage(b),'MESSAGE three');
});
test('history unlocks and recovers when the first account session list fails',async()=>{
  let fail=true;const b=await historyBrowser(url=>fail&&url.startsWith('/api/history/sessions')?Promise.reject(new Error('session list failed')):undefined);
  assert.match(b.elements.get('state').textContent,/session list failed/);assert(b.elements.get('users').children.every(button=>!button.disabled));
  fail=false;await vm.runInContext('poll(true)',b.context);assert.equal(historyMessage(b),'MESSAGE one');assert(b.elements.get('sessions').children.every(button=>!button.disabled));
});
test('history ignores an older session list response that arrives after a newer response',async()=>{
  const first=deferred(),second=deferred();let pending=[];
  const b=await historyBrowser(url=>url.startsWith('/api/history/sessions')&&pending.length?pending.shift().promise:undefined);
  pending=[first,second];const oldRequest=vm.runInContext('loadSessions()',b.context),newRequest=vm.runInContext('loadSessions()',b.context);
  second.resolve({sessions:sessionRows('A','FRESH '),next:null});await newRequest;assert.equal(b.elements.get('sessionTitle').textContent,'FRESH one');
  first.resolve({sessions:sessionRows('A','STALE '),next:null});await oldRequest;assert.equal(b.elements.get('sessionTitle').textContent,'FRESH one');
});
test('history ignores a previous account session list failure after switching accounts',async()=>{
  const pending=deferred();let hold=false;
  const b=await historyBrowser(url=>hold&&url.startsWith('/api/history/sessions')&&new URL(url,'http://localhost').searchParams.get('user')==='A'?pending.promise:undefined);
  hold=true;const obsolete=vm.runInContext('loadSessions()',b.context);await vm.runInContext("selectAccount('B')",b.context);
  assert.equal(historyMessage(b),'MESSAGE b-one');pending.reject(new Error('obsolete account failure'));await obsolete;
  assert.doesNotMatch(b.elements.get('state').textContent,/obsolete account failure/);assert.equal(historyMessage(b),'MESSAGE b-one');assert.equal(b.elements.get('sessionTitle').textContent,'b-one');
});
for(const target of ['session','account'])test(`history cancels a previous search debounce when switching ${target}`,async()=>{
  const timers=new Map(),b=await historyBrowser(undefined,timers);
  b.elements.get('search').value='previous search';b.elements.get('search').oninput();assert.equal(timers.size,1);
  await vm.runInContext(target==='session'?"selectSession('two')":"selectAccount('B')",b.context);
  assert.equal(timers.size,0);assert.equal(b.elements.get('search').value,'');const pageCalls=b.calls.filter(call=>call.url.startsWith('/api/history?'));
  assert.equal(pageCalls.length,2);assert.equal(new URL(pageCalls[1].url,'http://localhost').searchParams.get('q'),'');assert.equal(historyMessage(b),target==='session'?'MESSAGE two':'MESSAGE b-one');
});
test('history polling does not supersede an in-flight older session list request',async()=>{
  const pending=deferred();let hold=false;
  const b=await historyBrowser(url=>{
    if(!url.startsWith('/api/history/sessions'))return;
    if(hold&&new URL(url,'http://localhost').searchParams.has('before'))return pending.promise;
    return {sessions:sessionRows(),next:'older-cursor'};
  });
  hold=true;const olderRequest=vm.runInContext('loadSessions(true)',b.context),sessionCalls=b.calls.filter(call=>call.url.startsWith('/api/history/sessions')).length;
  await vm.runInContext('poll(true)',b.context);assert.equal(b.calls.filter(call=>call.url.startsWith('/api/history/sessions')).length,sessionCalls);
  pending.resolve({sessions:[{id:'ancient',title:'ancient',count:1,lastAt:'2026-10-01T00:00:00.000Z'}],next:null});await olderRequest;
  assert(b.elements.get('sessions').children.some(button=>button.children[0].textContent==='ancient'));assert.equal(b.elements.get('moreSessions').hidden,true);
});
for(const timing of ['before poll','during accounts request'])test(`history polling avoids session and update requests when page loading starts ${timing}`,async()=>{
  const accounts=deferred(),page=deferred();let hold=false;
  const b=await historyBrowser(url=>{
    if(hold&&url.startsWith('/api/history/accounts'))return accounts.promise;
    if(hold&&url.startsWith('/api/history?'))return page.promise;
  });
  hold=true;const before={sessions:b.calls.filter(call=>call.url.startsWith('/api/history/sessions')).length,updates:b.calls.filter(call=>call.url.startsWith('/api/history/updates')).length};
  let selection,poll;
  if(timing==='before poll'){selection=vm.runInContext("selectSession('two')",b.context);poll=vm.runInContext('poll(true)',b.context);}
  else{poll=vm.runInContext('poll(true)',b.context);selection=vm.runInContext("selectSession('two')",b.context);}
  accounts.resolve({qq:'READY',users:[{id:'A',label:'A changed'},{id:'B',label:'B'}]});await poll;
  assert.equal(b.calls.filter(call=>call.url.startsWith('/api/history/sessions')).length,before.sessions);assert.equal(b.calls.filter(call=>call.url.startsWith('/api/history/updates')).length,before.updates);
  assert(b.elements.get('users').children.every(button=>button.disabled));assert.equal(b.elements.get('sessionTitle').textContent,'two');
  page.resolve(messagePage('MESSAGE two'));await selection;assert.equal(historyMessage(b),'MESSAGE two');assert(b.elements.get('users').children.every(button=>!button.disabled));
});
test('history discards an obsolete message page even if its transport ignores abort',async()=>{
  const first=deferred(),second=deferred();let pending=[];
  const b=await historyBrowser(url=>url.startsWith('/api/history?')&&pending.length?pending.shift().promise:undefined);
  pending=[first,second];const oldRequest=vm.runInContext('loadPage()',b.context),oldSignal=b.calls.at(-1).signal;
  b.elements.get('search').value='new search';const newRequest=vm.runInContext('loadPage()',b.context);assert.equal(oldSignal.aborted,true);
  second.resolve(messagePage('CURRENT PAGE'));await newRequest;first.resolve(messagePage('OBSOLETE PAGE'));await oldRequest;
  assert.equal(historyMessage(b),'CURRENT PAGE');assert.equal(b.elements.get('loading').hidden,true);assert(b.elements.get('sessions').children.every(button=>!button.disabled));
});
test('history keeps navigation inert until two rendering frames after the response arrives',async()=>{
  const clock=paintClock(),pending=deferred();let hold=false;
  const b=await historyBrowser(url=>hold&&url.startsWith('/api/history?')?pending.promise:undefined,undefined,clock.performance);clock.install(b);hold=true;
  const selection=vm.runInContext("selectSession('two')",b.context);pending.resolve(messagePage('MESSAGE two'));await nextTurn();
  assert.equal(historyMessage(b),'MESSAGE two');assert.equal(clock.pendingFrames,1);
  const assertLocked=()=>{assert.equal(b.elements.get('loading').hidden,false);for(const id of ['users','sessions']){assert.equal(b.elements.get(id).inert,true);assert(b.elements.get(id).children.every(button=>button.disabled));}};
  assertLocked();const calls=b.calls.length;await vm.runInContext("selectSession('three')",b.context);assert.equal(b.calls.length,calls);
  await clock.frame();assertLocked();assert.equal(clock.pendingFrames,1);await clock.frame();
  assert.equal(b.elements.get('loading').hidden,true);for(const id of ['users','sessions']){assert.equal(b.elements.get(id).inert,false);assert(b.elements.get(id).children.every(button=>!button.disabled));}await selection;
});
for(const mode of ['already hidden','becomes hidden','frame timeout'])test(`history releases the rendering lock when ${mode}`,async()=>{
  const clock=paintClock(),b=await historyBrowser(undefined,undefined,clock.performance);clock.install(b);
  if(mode==='already hidden')b.context.document.hidden=true;
  const selection=vm.runInContext("selectSession('two')",b.context);await nextTurn();
  if(mode==='already hidden')assert.equal(clock.pendingFrames,0);
  else{
    assert.equal(b.elements.get('loading').hidden,false);assert.equal(b.elements.get('sessions').inert,true);
    if(mode==='becomes hidden'){b.context.document.hidden=true;b.context.document.dispatchEvent(new Event('visibilitychange'));await nextTurn();}
    else await clock.timeout(100);
  }
  assert.equal(b.elements.get('loading').hidden,true);assert.equal(b.elements.get('sessions').inert,false);assert(b.elements.get('sessions').children.every(button=>!button.disabled));assert.equal(historyMessage(b),'MESSAGE two');await selection;
});
test('history discards a navigation click created while loading even if it is delivered after unlocking',async()=>{
  const clock=paintClock(),pending=deferred();let hold=false;
  const b=await historyBrowser(url=>hold&&url.startsWith('/api/history?')?pending.promise:undefined,undefined,clock.performance);
  clock.advance(10);hold=true;const selection=vm.runInContext("selectSession('two')",b.context),button=b.elements.get('sessions').children.find(node=>node.children[0].textContent==='three'),oldClick={timeStamp:clock.advance()};
  assert.equal(button.disabled,true);clock.advance(10);hold=false;pending.resolve(messagePage('MESSAGE two'));await selection;
  const calls=b.calls.length;button.onclick(oldClick);await nextTurn();assert.equal(b.calls.length,calls);assert.equal(b.elements.get('sessionTitle').textContent,'two');assert.equal(historyMessage(b),'MESSAGE two');
  button.onclick({timeStamp:clock.advance()});await nextTurn();assert.equal(b.calls.length,calls+1);assert.equal(historyMessage(b),'MESSAGE three');
});
test('history rejects queued input and paging callbacks while their controls are disabled',async()=>{
  const timers=new Map(),pending=deferred();let hold=false;
  const b=await historyBrowser(url=>url.startsWith('/api/history?')?(hold?pending.promise:{...messagePage('PAGED MESSAGE'),next:'older-cursor'}):undefined,timers);
  b.elements.get('older').onclick();await nextTurn();assert.match(b.elements.get('pageInfo').textContent,/第 2 页/);
  hold=true;const refresh=vm.runInContext('loadPage()',b.context),calls=b.calls.length;
  try{
    for(const id of ['search','pageSize','older','newer','latest','newMessages']){
      assert.equal(b.elements.get(id).disabled,true,id);b.elements.get(id)[id==='search'?'oninput':id==='pageSize'?'onchange':'onclick']();await nextTurn();
      assert.equal(b.calls.length,calls,`${id} must not start another request`);assert.equal(timers.size,0,`${id} must not queue a later request`);
    }
  }finally{pending.resolve(messagePage('REFRESHED PAGE'));await refresh;}
});
test('history does not let an obsolete rendering callback unlock a newer message request',async()=>{
  const clock=paintClock(),pending=deferred();let hold=false;
  const b=await historyBrowser(url=>hold&&url.startsWith('/api/history?')?pending.promise:undefined,undefined,clock.performance);clock.install(b);
  const oldRequest=vm.runInContext('loadPage()',b.context);await nextTurn();assert.equal(clock.pendingFrames,1);
  hold=true;const newRequest=vm.runInContext('loadPage()',b.context);await clock.frame();await clock.frame();await oldRequest;
  assert.equal(b.elements.get('loading').hidden,false);assert.equal(b.elements.get('sessions').inert,true);assert(b.elements.get('sessions').children.every(button=>button.disabled));
  pending.resolve(messagePage('NEWER PAGE'));await nextTurn();await clock.frame();assert.equal(b.elements.get('loading').hidden,false);await clock.frame();
  assert.equal(b.elements.get('loading').hidden,true);assert.equal(b.elements.get('sessions').inert,false);assert.equal(historyMessage(b),'NEWER PAGE');await newRequest;
});
