import test from 'node:test';
import assert from 'node:assert/strict';
import { QQ } from './qq.mjs';
import { menu } from './controls.mjs';

const event=(extra={})=>({id:'source-message',user:'owner',chat:'owner',group:false,...extra});
const messageBody=call=>call.body.msg_type===2?call.body.markdown.content:call.body.content;
function fixture(config={}){
  const qq=new QQ(config,()=>{}),calls=[],sent=[];
  qq.api=async(endpoint,body,method)=>{calls.push({endpoint,body,method});return {id:'platform-'+calls.length};};
  qq.on('sent',entry=>sent.push(entry));
  return {qq,calls,sent};
}
const error=(message,details={})=>Object.assign(new Error(message),details);
const longText='连续内容段落。\n\n'.repeat(260);

test('ordinary replies use native Markdown syntax and audit original and rendered text',async()=>{
  const f=fixture(),e=event(),text='# 解答\n\n**核心观点**\n\n- 第一项\n- 第二项\n\n[资料](https://example.com)\n\n```js\nconst count = 1;\n```';
  await f.qq.send(e,text);
  assert.equal(f.calls.length,1);const {endpoint,body}=f.calls[0];
  assert.equal(endpoint,'/v2/users/owner/messages');assert.equal(body.msg_type,2);assert.equal(body.msg_id,e.id);assert.equal(body.msg_seq,1);
  assert(body.markdown.content.includes('**核心观点**'));assert(body.markdown.content.includes('[资料](https://example.com)'));assert(body.markdown.content.includes('```js'));
  assert(!body.markdown.content.includes('\\*\\*核心观点'));
  assert.equal(f.sent[0].text,text);assert.equal(f.sent[0].format,'markdown');assert.equal(f.sent[0].renderedText,body.markdown.content);
});

for(const [label,config,options] of [['configured plain',{replyFormat:'plain'},{}],['per-call plain',{}, {format:'plain'}]])test(`${label} sends unescaped source as plain text`,async()=>{
  const f=fixture(config),e=event(),text='**原文** [链接](https://example.com) <tag> & value';await f.qq.send(e,text,options);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].body.msg_type,0);assert.equal(f.calls[0].body.content,text);assert.equal(f.calls[0].body.markdown,undefined);
  assert.equal(f.sent[0].text,text);assert.equal(f.sent[0].format,'plain');assert.equal(f.sent[0].renderedText,text);
});

test('sendPlain always uses a plain payload even when native Markdown is the default',async()=>{
  const f=fixture(),text='**literal**';await f.qq.sendPlain(event(),text);
  assert.equal(f.calls[0].body.msg_type,0);assert.equal(f.calls[0].body.content,text);assert.equal(f.sent[0].format,'plain');
});

for(const code of [22006,304061,40034011,40034029,40034127])test(`definite Markdown rejection ${code} falls back once with a fresh sequence`,async()=>{
  const f=fixture(),base=f.qq.api.bind(f.qq),text='**回复**';let rejected=false;
  f.qq.api=async(endpoint,body,method)=>{if(!rejected){rejected=true;f.calls.push({endpoint,body,method});throw error('format rejected',{code});}return base(endpoint,body,method);};
  await f.qq.send(event(),text);
  assert.deepEqual(f.calls.map(x=>x.body.msg_type),[2,0]);assert.deepEqual(f.calls.map(x=>x.body.msg_seq),[1,2]);
  assert.equal(f.sent.length,1);assert.equal(f.sent[0].text,text);assert.equal(f.sent[0].format,'plain');assert.equal(f.sent[0].sequence,2);
});

test('HTTP 403 permits a plain fallback without retrying the rejected Markdown sequence',async()=>{
  const f=fixture(),base=f.qq.api.bind(f.qq);let first=true;
  f.qq.api=async(endpoint,body,method)=>{if(first){first=false;f.calls.push({endpoint,body,method});throw error('permission denied',{status:403});}return base(endpoint,body,method);};
  await f.qq.send(event(),'格式权限不支持');
  assert.deepEqual(f.calls.map(x=>[x.body.msg_type,x.body.msg_seq]),[[2,1],[0,2]]);
});

for(const [label,details] of [['timeout',{code:'UND_ERR_CONNECT_TIMEOUT'}],['HTTP 500',{status:500}],['HTTP 503 even with a format code',{status:503,code:40034029}],['explicitly uncertain format code',{code:40034029,definite:false}],['unknown HTTP 400',{status:400,code:99999}]])test(`${label} never triggers fallback or a duplicate POST`,async()=>{
  const f=fixture(),failure=error(label,details);f.qq.api=async(endpoint,body)=>{f.calls.push({endpoint,body});throw failure;};
  await assert.rejects(f.qq.send(event(),'不能重复提交的回复'),err=>err===failure);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].body.msg_type,2);assert.equal(f.sent.length,0);
});

test('a format rejection switches all remaining parts of that reply to plain text',async()=>{
  const f=fixture(),base=f.qq.api.bind(f.qq);let first=true;
  f.qq.api=async(endpoint,body,method)=>{if(first){first=false;f.calls.push({endpoint,body,method});throw error('format rejected',{code:40034029});}return base(endpoint,body,method);};
  await f.qq.send(event(),longText);
  assert(f.calls.length>2);assert.equal(f.calls[0].body.msg_type,2);assert(f.calls.slice(1).every(x=>x.body.msg_type===0));
  assert.deepEqual(f.calls.map(x=>x.body.msg_seq),f.calls.map((_,i)=>i+1));assert(f.calls.length<=4);
  assert.equal(f.sent.map(x=>x.text).join(''),longText);assert(f.sent.every(x=>x.format==='plain'&&x.renderedText===x.text));
});

test('a later part rejected for format falls back without resending a successful earlier part',async()=>{
  const f=fixture(),base=f.qq.api.bind(f.qq);let attempts=0;
  f.qq.api=async(endpoint,body,method)=>{attempts++;if(attempts===2){f.calls.push({endpoint,body,method});throw error('second part rejected',{code:40034011});}return base(endpoint,body,method);};
  await f.qq.send(event(),longText);
  assert(f.calls.length>=3);assert.equal(f.calls[0].body.msg_type,2);assert.equal(f.calls[1].body.msg_type,2);assert(f.calls.slice(2).every(x=>x.body.msg_type===0));
  assert.equal(f.sent.map(x=>x.text).join(''),longText);assert.equal(f.sent[0].format,'markdown');
  assert.equal(f.sent[0].renderedText,f.calls[0].body.markdown.content);
  assert(!f.sent.slice(1).some(x=>x.text===f.sent[0].text));
});

for(const [label,details] of [['timeout',{}],['server failure',{status:502}]])test(`a ${label} after partial success stops without resending completed parts`,async()=>{
  const f=fixture(),base=f.qq.api.bind(f.qq),failure=error(label,details);let attempts=0;
  f.qq.api=async(endpoint,body,method)=>{attempts++;if(attempts===2){f.calls.push({endpoint,body,method});throw failure;}return base(endpoint,body,method);};
  await assert.rejects(f.qq.send(event(),longText),err=>err===failure);
  assert.equal(f.calls.length,2);assert.equal(f.sent.length,1);assert.deepEqual(f.calls.map(x=>x.body.msg_seq),[1,2]);
  assert.equal(f.sent[0].renderedText,messageBody(f.calls[0]));
});

for(const [group,limit] of [[false,4],[true,5]])test(`${group?'group':'private'} replies stay within the ${limit}-POST quota and cannot send after exhaustion`,async()=>{
  const f=fixture(),e=event({group,chat:group?'group':'owner'});await f.qq.send(e,'内容很多。\n\n'.repeat(2500));
  assert.equal(f.calls.length,limit);assert.deepEqual(f.calls.map(x=>x.body.msg_seq),Array.from({length:limit},(_,i)=>i+1));
  assert(f.calls.every(x=>x.endpoint===`/v2/${group?'groups/group':'users/owner'}/messages`));
  await assert.rejects(f.qq.send(e,'额外一条'));assert.equal(f.calls.length,limit);
});

test('a rejected final allowed POST cannot fall back past the private reply quota',async()=>{
  const f=fixture(),e=event();f.qq.counts.set(e.id,3);
  f.qq.api=async(endpoint,body)=>{f.calls.push({endpoint,body});throw error('format rejected',{code:40034029});};
  await assert.rejects(f.qq.send(e,'只剩最后一个名额'));
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].body.msg_seq,4);assert.equal(f.sent.length,0);
});

test('send reserve leaves a reply slot available for a subsequent keyboard card',async()=>{
  const f=fixture(),e=event();await f.qq.send(e,'长内容。\n\n'.repeat(2000),{reserve:1});
  assert.equal(f.calls.length,3);await f.qq.sendButtons(e,'请选择',menu(e));
  assert.equal(f.calls.length,4);assert.equal(f.calls[3].body.msg_seq,4);assert(f.calls[3].body.keyboard);
});

test('long button details reserve the final private message for the keyboard',async()=>{
  const f=fixture(),e=event();await f.qq.sendButtons(e,'详细审批内容。\n\n'.repeat(2000),menu(e));
  assert.equal(f.calls.length,4);assert.deepEqual(f.calls.map(x=>x.body.msg_seq),[1,2,3,4]);
  assert(f.calls.slice(0,-1).every(x=>!x.body.keyboard));assert(f.calls.at(-1).body.keyboard);
});

test('a rejected short keyboard falls back explicitly to plain text',async()=>{
  const f=fixture(),e=event(),base=f.qq.api.bind(f.qq);let first=true;
  f.qq.api=async(endpoint,body,method)=>{if(first){first=false;f.calls.push({endpoint,body,method});throw error('keyboard rejected',{code:40034029});}return base(endpoint,body,method);};
  await f.qq.sendButtons(e,'审批 **内容**',menu(e));
  assert.deepEqual(f.calls.map(x=>x.body.msg_type),[2,0]);assert.deepEqual(f.calls.map(x=>x.body.msg_seq),[1,2]);assert.equal(f.calls[1].body.content,'审批 **内容**');
});

test('announcements use one native message without reply identifiers and preserve the platform response',async()=>{
  const f=fixture(),response={id:'original-platform-id',timestamp:'2026-10-15T01:00:00Z'};
  f.qq.api=async(endpoint,body)=>{f.calls.push({endpoint,body});return response;};
  const result=await f.qq.sendAnnouncement({id:'recipient/id'},'**发布说明**\n\n已更新消息格式。');
  assert.deepEqual(result,response);assert.equal(f.calls.length,1);const {endpoint,body}=f.calls[0];
  assert.equal(endpoint,'/v2/users/recipient%2Fid/messages');assert.equal(body.msg_type,2);assert(body.markdown.content.includes('**发布说明**'));
  assert.equal(Object.hasOwn(body,'msg_id'),false);assert.equal(Object.hasOwn(body,'msg_seq'),false);assert.equal(f.qq.counts.size,0);
});

test('announcements accept 1400 characters and reject oversized notices before any extra POST',async()=>{
  const f=fixture();await f.qq.sendAnnouncement({id:'recipient'},'更新内容。'.repeat(280));
  assert.equal(f.calls.length,1);assert(messageBody(f.calls[0]).length<=1400);
  await assert.rejects(f.qq.sendAnnouncement({id:'recipient'},'更'.repeat(1401)));
  assert.equal(f.calls.length,1);
});

test('an announcement definite format rejection permits only one plain fallback and returns its platform id',async()=>{
  const f=fixture(),response={id:'plain-platform-id'};let attempts=0;
  f.qq.api=async(endpoint,body)=>{f.calls.push({endpoint,body});if(++attempts===1)throw error('native rejected',{code:40034127});return response;};
  assert.deepEqual(await f.qq.sendAnnouncement({id:'recipient'},'**通知**'),response);
  assert.deepEqual(f.calls.map(x=>x.body.msg_type),[2,0]);
  for(const {body} of f.calls){assert.equal(Object.hasOwn(body,'msg_id'),false);assert.equal(Object.hasOwn(body,'msg_seq'),false);}
});

for(const [label,details] of [['timeout',{}],['HTTP 503 with a format code',{status:503,code:40034029}]])test(`an announcement ${label} is never retried or downgraded to plain`,async()=>{
  const f=fixture(),failure=error('announcement '+label,details);f.qq.api=async(endpoint,body)=>{f.calls.push({endpoint,body});throw failure;};
  await assert.rejects(f.qq.sendAnnouncement({id:'recipient'},'只通知一次'),err=>err===failure);assert.equal(f.calls.length,1);assert.equal(f.calls[0].body.msg_type,2);
});

test('plain reply configuration also makes announcements plain',async()=>{
  const f=fixture({replyFormat:'plain'});await f.qq.sendAnnouncement({id:'recipient'},'**原样通知**');
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].body.msg_type,0);assert.equal(f.calls[0].body.content,'**原样通知**');
});

test('an audit listener failure after platform acceptance cannot trigger a plain fallback',async()=>{
  const f=fixture(),failure=error('audit persistence failed',{code:40034029});
  f.qq.on('sent',()=>{throw failure;});
  await assert.rejects(f.qq.send(event(),'平台已接受的回复'),err=>err===failure);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].body.msg_type,2);
});

test('an announcement audit failure after platform acceptance cannot send a second notice',async()=>{
  const f=fixture(),failure=error('announcement audit failed',{code:40034029});
  f.qq.on('announcementSent',()=>{throw failure;});
  await assert.rejects(f.qq.sendAnnouncement({id:'recipient'},'平台已接受的通知'),err=>err===failure);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].body.msg_type,2);
});

test('a rejected keyboard after successful long details sends only a short instruction instead of repeating the details',async()=>{
  const f=fixture(),e=event(),base=f.qq.api.bind(f.qq),details='审批详情。'.repeat(300)+'\n/approve 1 同意；/deny 1 拒绝';
  f.qq.api=async(endpoint,body,method)=>{if(body.keyboard){f.calls.push({endpoint,body,method});throw error('keyboard format rejected',{code:40034029});}return base(endpoint,body,method);};
  await f.qq.sendButtons(e,details,menu(e));
  assert.deepEqual(f.calls.map(x=>x.body.msg_seq),[1,2,3,4]);
  assert.equal(f.calls[2].body.msg_type,2);assert(f.calls[2].body.keyboard);
  assert.equal(f.calls[3].body.msg_type,0);assert(f.calls[3].body.content.includes('文字指令'));assert(f.calls[3].body.content.length<200);
  assert(!f.calls[3].body.content.includes('审批详情'));
  assert.equal(f.sent.slice(0,2).map(x=>x.text).join(''),details);
});

test('plain configuration splits extreme code language metadata by source length without oversized payloads',async()=>{
  const f=fixture({replyFormat:'plain'}),text='```'+'LANG'.repeat(650)+'\nconsole.log("source must remain complete");\n```';
  await f.qq.send(event(),text);
  assert(f.calls.length>1);assert(f.calls.length<=4);assert(f.calls.every(x=>x.body.msg_type===0&&x.body.content.length<=1500));
  assert.equal(f.sent.map(x=>x.text).join(''),text);assert.equal(f.calls.map(x=>x.body.content).join(''),text);
});

test('native rejection around extreme code metadata re-splits only unsent source for plain fallback',async()=>{
  const f=fixture(),base=f.qq.api.bind(f.qq),prefix='FIRST_ACCEPTED_'+'甲'.repeat(1250)+'\n\n',text=prefix+'```'+'LANG'.repeat(500)+'\nconsole.log("remaining source");\n```';let attempt=0;
  f.qq.api=async(endpoint,body,method)=>{if(++attempt===2){f.calls.push({endpoint,body,method});throw error('second native part rejected',{code:40034029});}return base(endpoint,body,method);};
  await f.qq.send(event(),text);
  assert.equal(f.calls[0].body.msg_type,2);assert.equal(f.calls[1].body.msg_type,2);assert(f.calls.slice(2).every(x=>x.body.msg_type===0));
  assert(f.calls.every(x=>messageBody(x).length<=1500));assert(f.calls.length<=4);
  const accepted=f.sent[0].text;assert.equal(accepted,prefix);
  assert.equal(f.calls.slice(2).map(x=>x.body.content).join(''),text.slice(accepted.length));
  assert.equal(f.sent.map(x=>x.text).join(''),text);
});
