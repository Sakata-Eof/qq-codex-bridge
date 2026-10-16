import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageBatches } from './message-batches.mjs';

const event=(id,text='',extra={})=>({id,text,user:'A',chat:'A',group:false,attachments:[],quoted:[],...extra});
const image=id=>({content_type:'image/png',filename:`${id}.png`,url:`https://a.qpic.cn/${id}`});
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
function fixture(t,options={}) {
  t.mock.timers.enable({apis:['setTimeout','Date'],now:0});
  const calls=[],errors=[],batches=new MessageBatches({delayMs:30,maxWaitMs:100,handle:async e=>{calls.push(e);},onError:async(e,err)=>{errors.push({event:e,error:err});},...options});
  t.after(()=>batches.cancelAll());
  return {batches,calls,errors};
}

test('image then text merges in arrival order and replies using the final event',async t=>{
  const f=fixture(t),first=event('image','',{attachments:[image('image')]}),last=event('text','/codex 解答这道题');
  const a=f.batches.push(first);t.mock.timers.tick(20);const b=f.batches.push(last);
  assert.equal(f.batches.pendingFor(last),2);assert.equal(f.batches.busy(),true);
  t.mock.timers.tick(29);assert.equal(f.calls.length,0);t.mock.timers.tick(1);await Promise.all([a,b]);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].id,'text');assert.equal(f.calls[0].text,'解答这道题');assert.deepEqual(f.calls[0].sourceEvents,[first,last]);assert.deepEqual(f.calls[0].attachments,[image('image')]);assert.equal(f.batches.busy(),false);
});

test('text then images and quoted attachments preserve every source',async t=>{
  const f=fixture(t),quote={author:{user_openid:'A'},attachments:[image('quoted')]};
  const events=[event('text','/codex 请分析'),event('img','第二点',{attachments:[image('one')],quoted:[quote]}),event('file','',{attachments:[{filename:'data.txt',content_type:'file'}]})];
  const promises=events.map(e=>f.batches.push(e));t.mock.timers.tick(30);await Promise.all(promises);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].text,'请分析\n第二点');assert.deepEqual(f.calls[0].attachments,events.flatMap(e=>e.attachments));assert.deepEqual(f.calls[0].quoted,[quote]);assert.deepEqual(f.calls[0].sourceEvents,events);
});

test('a single image with no text submits automatically',async t=>{
  const f=fixture(t),e=event('only','',{attachments:[image('only')]}),p=f.batches.push(e);
  t.mock.timers.tick(30);await p;assert.equal(f.calls.length,1);assert.equal(f.calls[0].text,'');assert.deepEqual(f.calls[0].sourceEvents,[e]);
});

test('continuous messages submit at maxWait instead of postponing forever',async t=>{
  const f=fixture(t),promises=[f.batches.push(event('0','0'))];
  for(let i=1;i<=4;i++){t.mock.timers.tick(20);promises.push(f.batches.push(event(String(i),String(i))));}
  t.mock.timers.tick(19);assert.equal(f.calls.length,0);t.mock.timers.tick(1);await Promise.all(promises);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].sourceEvents.length,5);assert.equal(f.calls[0].id,'4');
});

test('different users, private chats and groups never share a batch',async t=>{
  const f=fixture(t),events=[event('same','A private'),event('same','B private',{user:'B',chat:'B'}),event('same','A group',{group:true,chat:'G'}),event('same','B group',{user:'B',group:true,chat:'G'}),event('same','private group-id',{chat:'G'})];
  const promises=events.map(e=>f.batches.push(e));t.mock.timers.tick(30);await Promise.all(promises);
  assert.equal(f.calls.length,5);for(const [i,call] of f.calls.entries()){assert.deepEqual(call.sourceEvents,[events[i]]);assert.equal(call.text,events[i].text);}
});

test('duplicate message IDs share their promise before and after submission',async t=>{
  const f=fixture(t),e=event('dup','first'),p=f.batches.push(e);
  assert.equal(f.batches.push({...e,text:'duplicate'}),p);assert.equal(f.batches.pendingFor(e),1);
  t.mock.timers.tick(30);await p;assert.equal(f.batches.push(e),p);t.mock.timers.tick(30);assert.equal(f.calls.length,1);assert.equal(f.calls[0].text,'first');
});

test('a submitted batch is detached while its handler is still running',async t=>{
  const gates=[deferred(),deferred()],calls=[];
  const f=fixture(t,{handle:async e=>{const index=calls.length;calls.push(e);await gates[index].promise;}});
  const first=event('first','first'),second=event('second','second'),a=f.batches.push(first);
  t.mock.timers.tick(30);assert.equal(calls.length,1);assert.equal(f.batches.pendingFor(first),0);assert.equal(f.batches.busy(),true);
  const b=f.batches.push(second);assert.equal(f.batches.pendingFor(second),1);t.mock.timers.tick(30);assert.equal(calls.length,2);
  assert.deepEqual(calls.map(e=>e.sourceEvents),[[first],[second]]);gates[0].resolve();await a;assert.equal(f.batches.busy(),true);gates[1].resolve();await b;assert.equal(f.batches.busy(),false);
});

test('cancel only resolves the selected pending conversation and never calls handle',async t=>{
  const f=fixture(t),a=event('a','a'),b=event('b','b',{user:'B',chat:'B'}),pa=f.batches.push(a),pb=f.batches.push(b);
  assert.deepEqual(f.batches.cancel(a),[a]);await pa;assert.equal(f.batches.pendingFor(a),0);assert.equal(f.batches.busy(),true);assert.deepEqual(f.batches.cancel(a),[]);
  assert.equal(f.batches.push(a),pa);t.mock.timers.tick(30);await pb;assert.deepEqual(f.calls.map(e=>e.id),['b']);
});

test('cancelAll returns pending original events in arrival order',async t=>{
  const f=fixture(t),events=[event('a1','a1'),event('b1','b1',{user:'B',chat:'B'}),event('a2','a2')],promises=events.map(e=>f.batches.push(e));
  assert.deepEqual(f.batches.cancelAll(),events);await Promise.all(promises);assert.equal(f.batches.busy(),false);t.mock.timers.tick(100);assert.equal(f.calls.length,0);assert.deepEqual(f.batches.cancelAll(),[]);
});

test('cancelAll does not cancel an already submitted task',async t=>{
  const gate=deferred(),calls=[],f=fixture(t,{handle:async e=>{calls.push(e);await gate.promise;}}),e=event('active','active'),p=f.batches.push(e);
  t.mock.timers.tick(30);assert.deepEqual(f.batches.cancel(e),[]);assert.deepEqual(f.batches.cancelAll(),[]);assert.equal(f.batches.busy(),true);gate.resolve();await p;assert.equal(f.batches.busy(),false);assert.equal(calls.length,1);
});

test('handler failure calls onError once for the combined batch without retrying',async t=>{
  const error=new Error('routing failed'),calls=[],errors=[],gate=deferred();
  const f=fixture(t,{handle:async e=>{calls.push(e);throw error;},onError:async(e,err)=>{errors.push({event:e,error:err});await gate.promise;}});
  const a=f.batches.push(event('a','one')),b=f.batches.push(event('b','two'));t.mock.timers.tick(30);await Promise.resolve();
  assert.equal(errors.length,1);assert.equal(errors[0].error,error);assert.equal(errors[0].event.id,'b');assert.equal(f.batches.busy(),true);gate.resolve();await Promise.all([a,b]);t.mock.timers.tick(100);assert.equal(calls.length,1);assert.equal(errors.length,1);assert.equal(f.batches.busy(),false);
});

test('attachment overflow reports only the rejected message and preserves the pending batch',async t=>{
  const f=fixture(t),accepted=event('accepted','',{attachments:Array.from({length:7},(_,i)=>image(i))}),rejected=event('rejected','',{attachments:[image('one')],quoted:[{attachments:[image('two')]}]}),a=f.batches.push(accepted),b=f.batches.push(rejected);
  assert.equal(f.batches.push(rejected),b);await b;assert.equal(f.errors.length,1);assert.equal(f.errors[0].event,rejected);assert.equal(f.errors[0].error.code,'ATTACHMENT_LIMIT');assert.equal(f.batches.pendingFor(accepted),1);
  t.mock.timers.tick(30);await a;assert.equal(f.calls.length,1);assert.equal(f.calls[0].attachments.length,7);assert.deepEqual(f.calls[0].sourceEvents,[accepted]);
});

test('exactly eight attachments including quoted inputs are accepted',async t=>{
  const f=fixture(t),e=event('eight','',{attachments:Array.from({length:7},(_,i)=>image(i)),quoted:[{attachments:[image('quoted')]}]}),p=f.batches.push(e);
  t.mock.timers.tick(30);await p;assert.equal(f.calls.length,1);assert.equal(f.errors.length,0);
});

test('oversized first message does not create an empty batch and reporting failure is contained',async t=>{
  let reported=0;const f=fixture(t,{onError:async()=>{reported++;throw new Error('QQ reply failed');}}),e=event('large','',{attachments:Array.from({length:9},(_,i)=>image(i))});
  await f.batches.push(e);assert.equal(reported,1);assert.equal(f.batches.pendingFor(e),0);assert.equal(f.batches.busy(),false);t.mock.timers.tick(100);assert.equal(f.calls.length,0);
});

test('zero delay uses the same automatic batching path',async t=>{
  const f=fixture(t,{delayMs:0}),a=f.batches.push(event('a','first')),b=f.batches.push(event('b','/codex second'));
  t.mock.timers.tick(0);await Promise.all([a,b]);assert.equal(f.calls.length,1);assert.equal(f.calls[0].text,'first\nsecond');
});
