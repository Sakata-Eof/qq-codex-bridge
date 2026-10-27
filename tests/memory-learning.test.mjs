import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Memory } from '../src/core/memory.mjs';
import { runMemoryTool, memoryToolSpec, MEMORY_TOOL_NAME } from '../src/core/memory-learning.mjs';

function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-memory-learning-'));
  t.after(()=>{const relative=path.relative(path.resolve(os.tmpdir()),path.resolve(root));assert(relative.startsWith('qq-memory-learning-')&&!relative.includes(path.sep));fs.rmSync(root,{recursive:true,force:true});});
  return {root,a:new Memory(path.join(root,'shared.json'),path.join(root,'A','private.json')),b:new Memory(path.join(root,'shared.json'),path.join(root,'B','private.json'))};
}
const source={messageId:'message-A',threadId:'thread-A',turnId:'turn-A',chat:'A',group:false,userText:'我习惯先看结论，再看过程。请保持中文回复。',assistantText:'测试已通过。'};
function tool(memory,args,from=source){const reply=runMemoryTool(memory,args,from);return {success:reply.success,...JSON.parse(reply.contentItems[0].text)};}
function remember(memory,overrides={},from=source){return tool(memory,{action:'remember',revision:memory.snapshot().revision,text:'用户偏好先看结论，再看过程。',category:'preference',evidence:'先看结论，再看过程',...overrides},from);}

test('automatic memory is account-local, attributed and compatible with manual QQ memory',t=>{
  const {a,b}=fixture(t);a.write(a.globalFile,[{id:'shared',text:'shared rule'}]);const sharedBefore=fs.readFileSync(a.globalFile,'utf8');
  const saved=remember(a);assert.equal(saved.success,true);assert.equal(saved.entry.origin,'automatic');assert.equal(saved.entry.category,'preference');assert.equal(saved.entry.evidence,'先看结论，再看过程');assert.equal(saved.entry.source.messageId,'message-A');assert.equal(saved.entry.source.userText,undefined);
  assert.match(a.context(),/用户偏好先看结论/);assert.doesNotMatch(b.context(),/用户偏好先看结论/);assert.equal(b.snapshot().entries.length,0);assert.equal(fs.readFileSync(a.globalFile,'utf8'),sharedBefore);
  const listed=tool(a,{action:'list'});assert.equal(listed.success,true);assert.deepEqual(listed.automatic,{enabled:true,reviewEveryTurns:10});assert.equal(listed.entries[0].source.threadId,'thread-A');
  assert.equal(memoryToolSpec.name,MEMORY_TOOL_NAME);assert.equal(memoryToolSpec.inputSchema.additionalProperties,false);
});

test('automatic settings default without creating storage and changes invalidate prior readers',t=>{
  const {a,b}=fixture(t),initial=a.snapshot();assert.deepEqual(initial.automatic,{enabled:true,reviewEveryTurns:10});assert.equal(fs.existsSync(path.dirname(a.privateFile)),false);
  const disabled=a.change({revision:initial.revision,action:'configure',automatic:{enabled:false,reviewEveryTurns:5}});assert.equal(disabled.automatic.enabled,false);assert.notEqual(disabled.revision,initial.revision);assert.deepEqual(b.snapshot().automatic,{enabled:true,reviewEveryTurns:10});
  assert.equal(remember(a).success,false);assert.match(remember(a).error,/关闭/);assert.equal(a.snapshot().entries.length,0);
  assert.throws(()=>a.change({revision:initial.revision,action:'configure',automatic:{enabled:true,reviewEveryTurns:10}}),/发生变化/);
  assert.throws(()=>a.change({revision:disabled.revision,action:'configure',automatic:{enabled:true,reviewEveryTurns:0}}),/1–200/);
  assert.throws(()=>a.change({revision:disabled.revision,action:'configure',automatic:{enabled:'true',reviewEveryTurns:10}}),/启用状态/);
  const reopened=new Memory(a.globalFile,a.privateFile);assert.deepEqual(reopened.snapshot().automatic,{enabled:false,reviewEveryTurns:5});
});

test('automatic writes require fresh revisions and duplicates do not change files or consume capacity',t=>{
  const {a}=fixture(t),initial=a.snapshot(),saved=remember(a),before=fs.readFileSync(a.privateFile,'utf8');
  const stale=remember(a,{revision:initial.revision});assert.equal(stale.success,false);assert.equal(stale.status,409);assert.equal(fs.readFileSync(a.privateFile,'utf8'),before);
  const duplicate=remember(a,{text:'  用户偏好先看结论，再看过程。  '});assert.equal(duplicate.success,true);assert.equal(duplicate.unchanged,true);assert.equal(duplicate.entry.id,saved.entry.id);assert.equal(a.snapshot().entries.length,1);assert.equal(fs.readFileSync(a.privateFile,'utf8'),before);
  a.add('手动增加的内容');assert.equal(remember(a,{revision:saved.revision,text:'过期提炼'}).status,409);
});

test('automatic updates retain identity but refuse manual entries and manually edited automatic entries',t=>{
  const {a}=fixture(t),saved=remember(a),updated=tool(a,{action:'update',revision:saved.revision,id:saved.entry.id,text:'用户希望回复使用中文。',category:'preference',evidence:'保持中文回复'});
  assert.equal(updated.success,true);assert.equal(updated.entry.id,saved.entry.id);assert.equal(updated.entry.created,saved.entry.created);assert(updated.entry.updated);
  const manual=a.add('手工长期规则'),manualAttempt=tool(a,{action:'update',revision:a.snapshot().revision,id:manual.id,text:'自动改写手工规则',category:'preference',evidence:'保持中文回复'});assert.equal(manualAttempt.success,false);assert.match(manualAttempt.error,/手动维护/);
  const edited=a.change({action:'update',revision:a.snapshot().revision,id:saved.entry.id,text:'管理员手工编辑'});assert.equal(edited.entries[0].manualEdited,true);assert.equal(edited.entries[0].source.messageId,'message-A');
  const overwrite=tool(a,{action:'update',revision:edited.revision,id:saved.entry.id,text:'再次自动改写',category:'preference',evidence:'保持中文回复'});assert.equal(overwrite.success,false);assert.match(overwrite.error,/手动维护/);assert.equal(a.snapshot().entries[0].text,'管理员手工编辑');
  const resurrect=remember(a,{text:updated.entry.text,evidence:'保持中文回复'});assert.equal(resurrect.success,false);assert.match(resurrect.error,/手动删除/);
});

test('deletions prevent normalized automatic resurrection while manual restoration remains possible',t=>{
  const {a}=fixture(t),saved=remember(a);a.remove(saved.entry.id);assert.equal(a.snapshot().entries.length,0);
  const retry=remember(a,{text:'  用户偏好先看结论，再看过程。  '});assert.equal(retry.success,false);assert.match(retry.error,/手动删除/);assert.equal(a.snapshot().entries.length,0);
  const manuallyRestored=a.add(saved.entry.text);assert.equal(a.snapshot().entries[0].id,manuallyRestored.id);assert.equal(a.snapshot().entries[0].origin,undefined);
});

test('memory evidence must originate in the current account task, and assistant lessons require verified completion',t=>{
  const {a}=fixture(t);
  assert.equal(remember(a,{evidence:'另一账号的偏好'}).success,false);
  assert.equal(remember(a,{category:'lesson',evidence:'测试已通过',text:'已验证的经验'}).success,false);
  const lesson=remember(a,{category:'lesson',evidence:'测试已通过',text:'已验证的经验'},{...source,validatedOutcome:true});assert.equal(lesson.success,true);
  assert.equal(remember(a,{category:'profile',evidence:'测试已通过',text:'将助手猜测当作用户背景'},{...source,validatedOutcome:true}).success,false);
  assert.equal(remember(a,{}, {...source,threadId:''}).success,false);
  assert.equal(remember(a,{evidence:'PASSWORD=secret',text:'PASSWORD=secret'},{...source,userText:'PASSWORD=secret'}).success,false);
});

test('dynamic memory arguments cannot select accounts, paths, global storage or deletion',t=>{
  const {a,b}=fixture(t),before=a.snapshot();
  for(const args of [null,[],{action:'remove'},{action:'list',user:'B'},{action:'remember',path:b.privateFile},{action:'list',global:true},{action:'list',source}])assert.equal(tool(a,args).success,false,JSON.stringify(args));
  assert.equal(a.snapshot().revision,before.revision);assert.equal(fs.existsSync(path.dirname(a.privateFile)),false);assert.equal(b.snapshot().entries.length,0);
});

test('storage faults are sanitized and malformed settings block automatic mutations',t=>{
  const {a}=fixture(t);fs.mkdirSync(path.dirname(a.privateFile),{recursive:true});fs.writeFileSync(a.settingsFile,'{"automatic":false}');
  const listed=tool(a,{action:'list'});assert.equal(listed.success,false);assert.equal(JSON.stringify(listed).includes(a.privateFile),false);assert.equal(fs.existsSync(a.privateFile),false);
  fs.writeFileSync(a.settingsFile,'not json');assert.equal(tool(a,{action:'list'}).success,false);
});

test('automatic capacity failures preserve entries and never evict manually maintained facts',t=>{
  const {a}=fixture(t);for(let i=0;i<40;i++)a.add('manual '+i);const before=a.snapshot();assert.equal(remember(a).success,false);assert.equal(a.snapshot().revision,before.revision);assert.equal(a.snapshot().entries.length,40);
});

test('a rejected oversized manual edit does not create a tombstone for the retained automatic fact',t=>{
  const {a}=fixture(t),saved=remember(a);a.add('x'.repeat(2000));a.add('y'.repeat(2000));a.add('z'.repeat(2000));a.add('q'.repeat(1900));const before=a.snapshot();
  assert.throws(()=>a.change({action:'update',revision:before.revision,id:saved.entry.id,text:'a'.repeat(2000)}),/已满/);assert.equal(a.snapshot().revision,before.revision);assert.equal(a.settings().forgotten.length,0);assert.equal(remember(a).unchanged,true);
});
