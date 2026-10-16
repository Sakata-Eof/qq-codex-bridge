import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskRoutes } from '../src/http/task-routes.mjs';

const task=(user='A',id='task-1')=>({id,user,chat:user,group:false,title:'任务标题',stage:'completed',stageLabel:'执行完成',executionStatus:'completed',executionLabel:'已完成',deliveryStatus:'partial',deliveryLabel:'部分投递',threadId:'thread-'+user,turnId:'turn-'+user,parentTaskId:'',createdAt:'2026-10-16T00:00:00.000Z',updatedAt:'2026-10-16T00:00:01.000Z',sourceIds:['source-'+user],eventCount:1,events:[{stage:'completed',label:'执行完成',code:'',time:'2026-10-16T00:00:01.000Z'}]});
function fixture(){
  const responses=[],calls=[],accounts={instances:new Map(),starting:new Map()},qq={state:'QQ 在线（READY）'};
  const tasks={list(user,options){calls.push(['list',user,options]);return [task(user)];},get(user,id,options){calls.push(['get',user,id,options]);return id==='task-1'?task('A'):null;}};
  const routes=createTaskRoutes({config:{users:[{id:'A',workspace:'C:\\secret-A'},{id:'B',workspace:'C:\\secret-B'}]},tasks,accounts,qq,base:'http://127.0.0.1:17329',respond:(res,status,data)=>responses.push({status,data})});
  const request=async(url,method='GET')=>{const handled=await routes({method,url},{});return {handled,...responses.at(-1)};};
  return {request,tasks,accounts,qq,responses,calls};
}

test('task endpoints require one bound account before accessing the task store',async()=>{
  const f=fixture();
  for(const path of ['/api/tasks','/api/diagnostics','/api/tasks/task-1'])for(const query of ['','?user=unknown','?user=A&user=B','?user=']){
    const result=await f.request(path+query);assert.equal(result.handled,true);assert.equal(result.status,400);
  }
  assert.equal(f.calls.length,0);
});

test('task lists forward only the requested account, bound limit and explicit thread',async()=>{
  const f=fixture();await f.request('/api/tasks?user=A');await f.request('/api/tasks?user=B&limit=999&thread=two');await f.request('/api/tasks?user=A&limit=bad');
  assert.deepEqual(f.calls,[['list','A',{limit:10}],['list','B',{limit:30,thread:'two'}],['list','A',{limit:10}]]);
  assert.equal(f.responses[0].data.tasks[0].user,'A');assert.equal(f.responses[1].data.tasks[0].user,'B');
  assert.equal('events' in f.responses[0].data.tasks[0],false);
});

test('foreign and nonexistent task identifiers return the same 404 response',async()=>{
  const f=fixture();const foreign=await f.request('/api/tasks/task-1?user=B'),missing=await f.request('/api/tasks/missing?user=B');
  assert.deepEqual(foreign,missing);assert.equal(foreign.status,404);
  assert.deepEqual(f.calls,[['get','B','task-1',{limit:100}],['get','B','missing',{limit:100}]]);
});

test('task DTOs discard raw internal objects, foreign rows and foreign events',async()=>{
  const f=fixture(),row={...task(),config:{secret:'TOP_SECRET'},error:'C:\\private\\logs',events:[...task().events,{user:'B',stage:'failed',label:'FOREIGN EVENT',raw:'TOP_SECRET'}]};
  f.tasks.list=()=>[row,task('B')];f.tasks.get=()=>row;
  const list=await f.request('/api/tasks?user=A'),detail=await f.request('/api/tasks/task-1?user=A');
  assert.equal(list.data.tasks.length,1);assert.equal(detail.data.task.events.length,1);assert.equal(detail.data.task.events[0].createdAt,task().events[0].time);
  assert.doesNotMatch(JSON.stringify([list,detail]),/TOP_SECRET|private|FOREIGN EVENT/);
});

test('event reasons use controlled Chinese labels and discard arbitrary error codes or supplied labels',async()=>{
  const f=fixture();f.tasks.get=()=>({...task(),events:[
    {stage:'uncertain',label:'状态待确认',code:'reply_uncertain',codeLabel:'RAW_SECRET'},
    {stage:'uncertain',label:'状态待确认',code:'C:\\private\\error PRIVATE',codeLabel:'<img src=x onerror=alert(1)>'},
    {stage:'uncertain',label:'状态待确认',code:'constructor'}
  ]});
  const result=await f.request('/api/tasks/task-1?user=A'),events=result.data.task.events;
  assert.equal(events[0].code,'reply_uncertain');assert.equal(events[0].codeLabel,'结果投递需要确认');
  assert.equal(events[1].code,'');assert.equal(events[1].codeLabel,'');assert.equal(events[2].code,'');assert.equal(events[2].codeLabel,'');
  assert.doesNotMatch(JSON.stringify(result),/RAW_SECRET|private|PRIVATE|<img/);
});

test('diagnostics inspect only the selected existing process and never claim model reachability',async()=>{
  const f=fixture();f.accounts.instances.set('B',{rpc:{child:{exitCode:null,killed:false,pid:123,privatePath:'B_PRIVATE'}},bridge:{secret:'PRIVATE'}});
  let result=await f.request('/api/diagnostics?user=A');assert.equal(result.data.process.state,'not_started');assert.equal(result.data.qq.state,'online');assert.equal(result.data.model.state,'unchecked');
  f.accounts.starting.set('A',Promise.resolve());result=await f.request('/api/diagnostics?user=A');assert.equal(result.data.process.state,'starting');
  f.accounts.starting.delete('A');result=await f.request('/api/diagnostics?user=B');assert.equal(result.data.process.state,'running');assert.match(result.data.model.label,/不代表模型可用/);
  assert.deepEqual(result.data.problems,['最近结果尚未完整投递']);assert.doesNotMatch(JSON.stringify(result),/123|PRIVATE|workspace/);
});

test('diagnostics redact raw gateway failures and report degraded task recording',async()=>{
  const f=fixture();f.qq.state='connect failed: secret=CREDENTIAL C:\\private\\logs';f.accounts.taskTrackingError=true;
  const result=await f.request('/api/diagnostics?user=A');assert.equal(result.data.qq.state,'unavailable');assert.equal(result.data.tracking.state,'degraded');assert.doesNotMatch(JSON.stringify(result),/CREDENTIAL|private/);
});

test('diagnostic recording failures are scoped to the selected account',async()=>{
  const f=fixture();f.accounts.taskTrackingError=new Map([['A',true]]);
  assert.equal((await f.request('/api/diagnostics?user=A')).data.tracking.state,'degraded');
  assert.equal((await f.request('/api/diagnostics?user=B')).data.tracking.state,'ok');
});

test('storage errors become generic read failures without raw SQL paths or secrets',async()=>{
  const f=fixture();f.tasks.list=()=>{throw new Error('C:\\private\\tasks.db auth=secret');};f.tasks.get=f.tasks.list;
  for(const url of ['/api/tasks?user=A','/api/tasks/task-1?user=A','/api/diagnostics?user=A']){const result=await f.request(url);assert.equal(result.status,503);assert.doesNotMatch(JSON.stringify(result),/private|secret|tasks\.db/);}
});

test('task router does not handle unrelated routes or mutation methods',async()=>{
  const f=fixture();for(const [url,method] of [['/health','GET'],['/api/tasks?user=A','POST'],['/api/tasks/task-1','DELETE'],['/api/tasks/a/b?user=A','GET']])assert.equal((await f.request(url,method)).handled,false);
  assert.equal(f.responses.length,0);assert.equal(f.calls.length,0);
});
