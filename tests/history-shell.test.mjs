import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../public/history.js',import.meta.url),'utf8');
const nextTurn=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
async function browser(intercept=()=>{}){
  const nodes=new Map(),calls=[],intervals=[],listeners=new Map(),storage=new Map();
  function element(){return {children:[],dataset:{},hidden:false,open:false,value:'',textContent:'',style:{},classList:{toggle(){}},append(...values){this.children.push(...values);},replaceChildren(...values){this.children=values;},setAttribute(){},addEventListener(){},focus(){}};}
  const panel=element();panel.hidden=true;
  const get=id=>{if(!nodes.has(id))nodes.set(id,element());return nodes.get(id);};
  get('search').value='';get('titleInput').value='';get('pageSize').value='30';get('historyFeed').scrollTo=()=>get('historyFeed').scrolls=(get('historyFeed').scrolls||0)+1;
  const document={hidden:false,body:element(),createElement:element,getElementById:get,querySelector:selector=>selector==='#history-panel'?panel:null,addEventListener(name,fn){if(!listeners.has(name))listeners.set(name,[]);listeners.get(name).push(fn);},removeEventListener(){}};
  const context=vm.createContext({document,window:{addEventListener(){}},URL,URLSearchParams,AbortController,DOMException,setTimeout,clearTimeout,setInterval:fn=>intervals.push(fn),console,qqUI:{read:key=>storage.get(key),write:(key,value)=>storage.set(key,value),async request(url,body,signal){
    calls.push({url,body,signal});const result=intercept(url,body,signal);if(result!==undefined)return result;
    const query=new URL(url,'http://localhost').searchParams;
    if(url==='/api/history/accounts')return {qq:'READY',users:[{id:'A',label:'演示账号'}]};
    if(url.startsWith('/api/history/sessions'))return {sessions:[{id:'one',title:'演示会话',count:3,lastAt:'2026-10-27T01:00:00Z'}],next:null};
    if(url.startsWith('/api/history/updates'))return {count:0};
    if(url.startsWith('/api/history?'))return {records:[{kind:'inbound',text:'CURRENT '+query.get('q'),time:'2026-10-27T01:00:00Z'}],next:'older-page',total:3,watermark:3};
    if(url.startsWith('/api/tasks?'))return {tasks:[]};
    if(url.startsWith('/api/diagnostics?'))return {user:'A'};
    if(url==='/api/export')return {count:3,file:'demo-export.md'};
    if(url==='/api/status')return {appId:'demo',sandbox:false,users:[],pairingCodes:[],logs:[],qq:'READY',codex:'已登录'};
    throw new Error('Unexpected request '+url);
  }}});
  vm.runInContext(source,context);await nextTurn();
  const setVisible=async visible=>{panel.hidden=!visible;context.qqHistory.setVisible(visible);await nextTurn();};
  return {nodes,calls,intervals,listeners,context,setVisible,run:code=>vm.runInContext(code,context)};
}
const message=b=>b.nodes.get('messages').children[0]?.children[1].textContent;

test('embedded history is lazy and hidden polling never reads accounts or tasks',async()=>{
  const b=await browser();assert.equal(b.calls.length,0);
  for(const interval of b.intervals)interval();for(const retry of b.listeners.get('qq-ui-retry'))retry();await nextTurn();assert.equal(b.calls.length,0);
  await b.setVisible(true);assert.equal(message(b),'CURRENT ');assert.equal(b.calls.filter(call=>call.url==='/api/history/accounts').length,1);
  await b.setVisible(false);const count=b.calls.length;for(const interval of b.intervals)interval();for(const retry of b.listeners.get('qq-ui-retry'))retry();await nextTurn();assert.equal(b.calls.length,count);
});

test('leaving history discards an in-flight account response without reviving old polls',async()=>{
  const old=deferred();let hold=true;
  const b=await browser(url=>hold&&url==='/api/history/accounts'?old.promise:undefined);
  await b.setVisible(true);const signal=b.calls[0].signal;await b.setVisible(false);assert.equal(signal.aborted,true);
  hold=false;await b.setVisible(true);assert.equal(message(b),'CURRENT ');const state=b.nodes.get('state').textContent;
  old.resolve({qq:'STALE',users:[{id:'OLD',label:'PRIVATE OLD'}]});await nextTurn();
  assert.equal(b.nodes.get('state').textContent,state);assert.equal(b.nodes.get('users').children[0].textContent,'演示账号');assert.equal(b.run('user'),'A');
});

test('history resume preserves account, session, search, page and rename draft',async()=>{
  const b=await browser();await b.setVisible(true);
  b.nodes.get('search').value='query draft';b.nodes.get('titleInput').value='unfinished title';b.nodes.get('renameForm').hidden=false;b.run("pageStack=['','older-page']");
  await b.setVisible(false);await b.setVisible(true);
  assert.equal(b.run('user'),'A');assert.equal(b.run('thread'),'one');assert.equal(b.nodes.get('search').value,'query draft');assert.equal(b.nodes.get('titleInput').value,'unfinished title');assert.equal(b.nodes.get('renameForm').hidden,false);assert.equal(b.run('pageStack.length'),2);
  const page=b.calls.filter(call=>call.url.startsWith('/api/history?')).at(-1),query=new URL(page.url,'http://localhost').searchParams;
  assert.equal(query.get('q'),'query draft');assert.equal(query.get('before'),'older-page');assert.equal(message(b),'CURRENT query draft');assert.equal(b.nodes.get('historyFeed').scrolls,2);
});

test('late message reads cannot replace the resumed history or keep its controls locked',async()=>{
  const old=deferred();let hold=false;
  const b=await browser(url=>hold&&url.startsWith('/api/history?')?old.promise:undefined);await b.setVisible(true);hold=true;
  const read=b.run('loadPage()');await nextTurn();const signal=b.calls.filter(call=>call.url.startsWith('/api/history?')).at(-1).signal;
  await b.setVisible(false);assert.equal(signal.aborted,true);hold=false;await b.setVisible(true);
  old.resolve({records:[{kind:'inbound',text:'PRIVATE OLD',time:'2026-10-27T00:00:00Z'}],total:1,watermark:1});await read;
  assert.equal(message(b),'CURRENT ');assert.equal(b.nodes.get('loading').hidden,true);assert.equal(b.nodes.get('users').inert,false);
});

test('an export finishes once across history navigation and is never replayed on resume',async()=>{
  const result=deferred();const b=await browser((url,body)=>url==='/api/export'&&body?result.promise:undefined);await b.setVisible(true);
  const writing=b.nodes.get('export').onclick();await b.setVisible(false);await b.setVisible(true);assert.equal(b.calls.filter(call=>call.url==='/api/export').length,1);
  result.resolve({count:3,file:'demo-export.md'});await writing;assert.match(b.nodes.get('exported').textContent,/demo-export.md/);
  await b.setVisible(false);await b.setVisible(true);assert.equal(b.calls.filter(call=>call.url==='/api/export').length,1);
});

test('history and management scripts share one document without lexical name collisions',async()=>{
  const b=await browser();
  vm.runInContext(fs.readFileSync(new URL('../public/setup.js',import.meta.url),'utf8'),b.context);await nextTurn();
  assert.equal(typeof b.context.qqHistory.setVisible,'function');assert.equal(b.nodes.get('appId').value,'demo');assert.equal(b.calls.filter(call=>call.url==='/api/history/accounts').length,0);
});
