import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../public/history.js',import.meta.url),'utf8');
const turn=()=>new Promise(resolve=>setImmediate(resolve));
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {resolve,reject,promise};}
function element(tag='div'){
  const result={tag,children:[],childNodes:[],dataset:{},style:{},open:false,hidden:false,classList:{toggle(){}},append(...nodes){this.children.push(...nodes);this.childNodes=this.children;},replaceChildren(...nodes){this.children=nodes;this.childNodes=nodes;},setAttribute(){},addEventListener(){},focus(){}};
  Object.defineProperty(result,'innerHTML',{set(){throw Error('unsafe HTML rendering');}});return result;
}
const task=(user='A',id='task-'+user)=>({id,user,title:'任务 '+user,stage:'completed',stageLabel:'执行完成',executionStatus:'completed',executionLabel:'已完成',deliveryStatus:'sent',deliveryLabel:'已投递',updatedAt:'2026-10-16T00:00:00.000Z',eventCount:1});
async function browser(intercept=()=>{}){
  const elements=new Map(),calls=[],intervals=[],listeners=new Map();
  const document={hidden:false,body:element(),createElement:tag=>element(tag),getElementById(id){if(!elements.has(id))elements.set(id,element());return elements.get(id);},addEventListener(type,fn){if(!listeners.has(type))listeners.set(type,[]);listeners.get(type).push(fn);},removeEventListener(){}};
  elements.set('search',{...element(),value:''});elements.set('pageSize',{...element(),value:'30'});
  const context=vm.createContext({document,window:{addEventListener(){}},URL,URLSearchParams,AbortController,DOMException,setTimeout,clearTimeout,setInterval:fn=>intervals.push(fn),clearInterval(){},console,qqUI:{read:()=>null,write(){},async request(url,body,signal){
    calls.push({url,signal});const override=intercept(url,body,signal);if(override!==undefined)return override;
    const query=new URL(url,'http://localhost').searchParams,account=query.get('user');
    if(url==='/api/history/accounts')return {qq:'READY',users:[{id:'A',label:'甲'},{id:'B',label:'乙'}]};
    if(url.startsWith('/api/history/sessions'))return {sessions:['one','two'].map(id=>({id,title:id,count:1,lastAt:'2026-10-16T00:00:00.000Z'})),next:null};
    if(url.startsWith('/api/history/updates'))return {count:0};
    if(url.startsWith('/api/history?'))return {records:[{kind:'inbound',text:'MESSAGE '+account+' '+query.get('thread'),time:'2026-10-16T00:00:00.000Z'}],total:1,watermark:1,next:null};
    if(url.startsWith('/api/tasks?'))return {tasks:[task(account)]};
    if(url.startsWith('/api/tasks/'))return {task:{...task(account),events:[{stage:'completed',label:'执行完成',createdAt:'2026-10-16T00:00:00.000Z'}]}};
    if(url.startsWith('/api/diagnostics?'))return {user:account,qq:{label:'QQ 已连接'},process:{label:'账号进程未启动'},tracking:{label:'任务记录正常'},model:{label:'模型调用未验证'},problems:[]};
    throw Error(url);
  }}});
  vm.runInContext(source,context);await turn();
  const run=expression=>vm.runInContext(expression,context),open=async()=>{elements.get('taskPanel').open=true;elements.get('taskPanel').ontoggle();await turn();};
  return {elements,calls,context,intervals,run,open};
}
const renderedText=node=>[node.textContent||'',...node.children.map(renderedText)].join(' ');

test('recent tasks are collapsed and lazy; opening does not change the selected session',async()=>{
  const b=await browser();assert.equal(b.calls.some(call=>call.url.startsWith('/api/tasks')),false);const selected=b.elements.get('sessionTitle').textContent;
  await b.open();assert.equal(b.elements.get('taskList').children.length,1);assert.equal(b.elements.get('sessionTitle').textContent,selected);
  assert.equal(b.calls.filter(call=>call.url.startsWith('/api/tasks/')).length,0);assert.match(b.elements.get('taskDiagnostics').textContent,/模型调用未验证/);
  await b.run("selectSession('two')");assert.equal(b.calls.filter(call=>call.url.startsWith('/api/tasks?')).length,1);
  const taskQuery=new URL(b.calls.find(call=>call.url.startsWith('/api/tasks?')).url,'http://localhost').searchParams;assert.equal(taskQuery.has('thread'),false);
});

test('task failures keep existing tasks and use their own error state without exposing raw errors',async()=>{
  let fail=false;const b=await browser(url=>fail&&url.startsWith('/api/tasks?')?Promise.reject(Error('C:\\secret\\task.db PRIVATE')):undefined);await b.open();const messageState=b.elements.get('state').textContent;
  fail=true;await b.run('taskView.refresh()');assert.equal(b.elements.get('taskList').children.length,1);assert.equal(b.elements.get('taskError').hidden,false);assert.match(b.elements.get('taskError').textContent,/已显示的记录会保留/);assert.doesNotMatch(b.elements.get('taskError').textContent,/PRIVATE|secret/);assert.equal(b.elements.get('state').textContent,messageState);
  fail=false;await b.run('taskView.refresh()');assert.equal(b.elements.get('taskError').hidden,true);
});

test('empty task state explains that only new tasks after upgrade are recorded',async()=>{
  const b=await browser(url=>url.startsWith('/api/tasks?')?{tasks:[]}:undefined);await b.open();assert.equal(b.elements.get('taskList').children.length,0);assert.equal(b.elements.get('taskEmpty').hidden,false);assert.match(b.elements.get('taskEmpty').textContent,/升级后的新任务/);assert.equal(b.elements.get('taskError').hidden,true);
});

test('switching accounts clears and aborts old task requests and discards late old responses',async()=>{
  const old=deferred(),fresh=deferred();const b=await browser(url=>url.startsWith('/api/tasks?')?(new URL(url,'http://localhost').searchParams.get('user')==='A'?old.promise:fresh.promise):undefined);
  b.elements.get('taskPanel').open=true;const first=b.run('taskView.refresh()');await turn();const firstSignal=b.calls.find(call=>call.url.startsWith('/api/tasks?')).signal;
  await b.run("selectAccount('B')");assert.equal(firstSignal.aborted,true);assert.equal(b.elements.get('taskList').children.length,0);assert.equal(b.elements.get('taskDiagnostics').textContent,'');
  fresh.resolve({tasks:[task('B')]});await turn();old.resolve({tasks:[task('A')]});await first;
  assert.match(renderedText(b.elements.get('taskList')),/任务 B/);assert.doesNotMatch(renderedText(b.elements.get('taskList')),/任务 A/);assert.match(b.elements.get('messages').children[0].children[1].textContent,/MESSAGE B/);
});

test('task refreshes do not overlap or lock history navigation',async()=>{
  const pending=deferred();const b=await browser(url=>url.startsWith('/api/tasks?')?pending.promise:undefined);b.elements.get('taskPanel').open=true;
  const read=b.run('taskView.refresh()');await b.run('taskView.refresh()');await b.run('taskView.refresh()');assert.equal(b.calls.filter(call=>call.url.startsWith('/api/tasks?')).length,1);assert.equal(b.elements.get('loading').hidden,true);assert(b.elements.get('sessions').children.every(button=>!button.disabled));
  await b.run("selectSession('two')");pending.resolve({tasks:[task('A')]});await read;assert.equal(b.elements.get('sessionTitle').textContent,'two');assert.equal(b.elements.get('taskList').children.length,1);
});

test('task summaries and detail labels render as text; detail is lazy, bounded and account scoped',async()=>{
  const html='<img src=x onerror=alert(1)>',b=await browser(url=>url.startsWith('/api/tasks?')?{tasks:[{...task(),title:html},task('B')]}:url.startsWith('/api/tasks/')?{task:{...task(),events:Array.from({length:105},(_,i)=>({label:html+i,createdAt:'2026-10-16T00:00:00.000Z'})),eventCount:105}}:undefined);
  await b.open();assert.equal(b.elements.get('taskList').children.length,1);assert.match(renderedText(b.elements.get('taskList')),/<img/);
  const card=b.elements.get('taskList').children[0];card.open=true;card.ontoggle();await turn();const timeline=card.children[1].children[0].children[0];assert.equal(timeline.tag,'ol');assert.equal(timeline.children.length,100);assert.match(renderedText(card),/最近 100 个阶段/);assert.match(renderedText(card),/<img/);
  const calls=b.calls.filter(call=>call.url.startsWith('/api/tasks/'));assert.equal(calls.length,1);assert.equal(new URL(calls[0].url,'http://localhost').searchParams.get('user'),'A');card.ontoggle();await turn();assert.equal(b.calls.filter(call=>call.url.startsWith('/api/tasks/')).length,1);
});

test('timeline displays Chinese reasons instead of internal codes and renders reason labels as text',async()=>{
  const html='<img src=x onerror=alert(1)>',b=await browser(url=>url.startsWith('/api/tasks/')?{task:{...task(),events:[
    {stage:'uncertain',label:'状态待确认',code:'reply_uncertain',codeLabel:'结果投递需要确认',createdAt:task().updatedAt},
    {stage:'uncertain',label:'状态待确认',code:'INTERNAL_ONLY',codeLabel:html,createdAt:task().updatedAt}
  ]}}:undefined);
  await b.open();const card=b.elements.get('taskList').children[0];card.open=true;card.ontoggle();await turn();const rendered=renderedText(card);
  assert.match(rendered,/状态待确认 · 结果投递需要确认/);assert.doesNotMatch(rendered,/reply_uncertain|INTERNAL_ONLY/);assert.match(rendered,/<img src=x onerror=alert\(1\)>/);
});

test('late detail and diagnostic responses from a previous account cannot reappear',async()=>{
  const detail=deferred(),diagnostic=deferred();let hold=false;
  const b=await browser(url=>url.startsWith('/api/tasks/')?detail.promise:hold&&url.startsWith('/api/diagnostics?user=A')?diagnostic.promise:undefined);await b.open();const oldCard=b.elements.get('taskList').children[0];oldCard.open=true;oldCard.ontoggle();hold=true;const read=b.run('taskView.refresh()');await turn();
  await b.run("selectAccount('B')");detail.resolve({task:{...task('A'),events:[{label:'PRIVATE A',createdAt:'2026-10-16T00:00:00.000Z'}]}});diagnostic.resolve({user:'A',qq:{label:'PRIVATE A'}});await read;await turn();
  assert.doesNotMatch(renderedText(b.elements.get('taskList')),/PRIVATE A|任务 A/);assert.doesNotMatch(b.elements.get('taskDiagnostics').textContent,/PRIVATE A/);assert.match(renderedText(b.elements.get('taskList')),/任务 B/);
});

test('queued toggle events from discarded task cards cannot close the current timeline',async()=>{
  let updated=false;const b=await browser(url=>url.startsWith('/api/tasks?')?{tasks:[{...task(),updatedAt:updated?'2026-10-16T00:00:01.000Z':task().updatedAt}]}:undefined);
  await b.open();const previous=b.elements.get('taskList').children[0];previous.open=true;previous.ontoggle();await turn();
  updated=true;await b.run('taskView.refresh()');const current=b.elements.get('taskList').children[0];assert.notEqual(previous,current);assert.equal(current.open,true);
  previous.ontoggle();await turn();assert.equal(current.open,true);assert.equal(b.run('user'),'A');
});

test('an expanded timeline refreshes when events change within the same timestamp',async()=>{
  let eventCount=1;const b=await browser(url=>url.startsWith('/api/tasks?')?{tasks:[{...task(),eventCount}]}:url.startsWith('/api/tasks/')?{task:{...task(),eventCount,events:Array.from({length:eventCount},(_,i)=>({label:i?'结果已投递':'执行完成',createdAt:task().updatedAt}))}}:undefined);
  await b.open();const initial=b.elements.get('taskList').children[0];initial.open=true;initial.ontoggle();await turn();
  assert.match(renderedText(initial),/执行完成/);assert.doesNotMatch(renderedText(initial),/结果已投递/);assert.equal(b.calls.filter(call=>call.url.startsWith('/api/tasks/')).length,1);
  eventCount=2;await b.run('taskView.refresh()');await turn();const current=b.elements.get('taskList').children[0];
  assert.equal(current.open,true);assert.match(renderedText(current),/结果已投递/);assert.equal(b.calls.filter(call=>call.url.startsWith('/api/tasks/')).length,2);
  await b.run('taskView.refresh()');assert.equal(b.calls.filter(call=>call.url.startsWith('/api/tasks/')).length,2);
});
