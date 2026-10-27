import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../public/setup.js',import.meta.url),'utf8');
const turn=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
async function browser(intercept=()=>{}){
  const elements=new Map(),calls=[],entries={A:[{id:'a1',text:'ONLY A',created:'2026-10-01'}],B:[{id:'b1',text:'ONLY B',created:'2026-10-02'}]},revisions={A:'a-v1',B:'b-v1'},automatic={A:{enabled:true,reviewEveryTurns:10},B:{enabled:true,reviewEveryTurns:10}};
  function element(tag='div'){
    return {tag,children:[],dataset:{},value:'',hidden:false,disabled:false,textContent:'',attributes:{},
      set id(value){this._id=value;elements.set(value,this);},get id(){return this._id;},
      append(...nodes){for(const node of nodes){node.parent=this;this.children.push(node);}},
      replaceChildren(...nodes){this.children=[];this.append(...nodes);},
      remove(){if(this.parent)this.parent.children=this.parent.children.filter(node=>node!==this);},
      setAttribute(name,value){this.attributes[name]=value;}};
  }
  const users=['A','B'].map(id=>({id,label:'账号 '+id,workspace:'workspace-'+id,sessions:[]}));
  const status={users,appId:'test',sandbox:false,globalMemory:'SHARED',logs:[],pairingCodes:[],qq:'READY',codex:'test'};
  const context=vm.createContext({document:{hidden:false,createElement:element,getElementById(id){if(!elements.has(id))elements.set(id,element());return elements.get(id);},addEventListener(){}},setInterval(){},console,qqUI:{async request(url,body){
    calls.push({url,body});const result=intercept(url,body);if(result!==undefined)return result;
    if(url==='/api/status')return status;
    const user=body?.user||new URL(url,'http://localhost').searchParams.get('user');
    if(url.startsWith('/api/memory/private')){
      if(body){
        assert.equal(body.revision,revisions[user]);
        if(body.action==='update')entries[user]=entries[user].map(entry=>entry.id===body.id?{...entry,text:body.text.trim()}:entry);
        if(body.action==='add')entries[user].push({id:'new-'+user,text:body.text.trim(),created:'2026-10-26'});
        if(body.action==='remove')entries[user]=entries[user].filter(entry=>entry.id!==body.id);
        if(body.action==='configure')automatic[user]=structuredClone(body.automatic);
        revisions[user]+='-next';
      }
      return structuredClone({user,entries:entries[user],revision:revisions[user],automatic:automatic[user]});
    }
    throw new Error('Unexpected request '+url);
  }}});
  vm.runInContext(source,context);await turn();
  return {context,elements,calls,entries,automatic,status,state:id=>vm.runInContext(`privateMemoryCards.get('${id}')`,context),refresh:()=>vm.runInContext('refresh()',context)};
}
test('management page loads separate account memories without copying shared memory',async()=>{
  const b=await browser(),a=b.state('A'),other=b.state('B');
  assert.equal(a.edits.get('a1').input.value,'ONLY A');assert.equal(other.edits.get('b1').input.value,'ONLY B');assert.equal(a.edits.has('b1'),false);
  assert.equal(b.elements.get('globalMemory').value,'SHARED');assert.equal(a.summary.textContent,'1 / 40 条 · 6 / 8000 字符');
  b.status.users=[];await b.refresh();assert.equal(b.elements.get('privateMemoryEmpty').hidden,false);assert.equal(b.elements.get('privateMemories').children.length,0);
});
test('polling preserves account drafts and saving one entry preserves other drafts',async()=>{
  const b=await browser(),a=b.state('A'),other=b.state('B');
  a.addInput.value='unfinished new memory';a.edits.get('a1').input.value='changed A';other.edits.get('b1').input.value='unfinished B';
  b.status.users[0].workspace='changed-directory';await b.refresh();assert.equal(b.state('A'),a);assert.equal(a.edits.get('a1').input.value,'changed A');
  await a.list.children[0].children[2].onclick();
  assert.equal(b.entries.A[0].text,'changed A');assert.equal(b.entries.B[0].text,'ONLY B');assert.equal(other.edits.get('b1').input.value,'unfinished B');assert.equal(a.addInput.value,'unfinished new memory');
  const write=b.calls.find(call=>call.body?.action==='update');assert.equal(write.body.user,'A');assert.equal(write.body.id,'a1');assert.equal(write.body.revision,'a-v1');
});
test('account editor adds, validates and explicitly confirms removing a single entry',async()=>{
  const b=await browser(),a=b.state('A');a.addInput.value='   ';await a.add.onclick();assert.equal(b.calls.filter(call=>call.body).length,0);assert.match(a.message.textContent,/1–2000/);
  a.addInput.value='  new private entry  ';await a.add.onclick();assert.equal(a.addInput.value,'');assert.equal(a.edits.get('new-A').input.value,'new private entry');
  const row=a.list.children[1];row.children[3].onclick();assert.equal(row.children[3].textContent,'确认删除');assert.equal(b.entries.A.length,2);
  row.children[4].onclick();assert.equal(row.children[3].textContent,'删除');row.children[3].onclick();await row.children[3].onclick();
  assert.equal(b.entries.A.length,1);assert.equal(b.entries.B.length,1);assert.match(a.message.textContent,/已删除/);
});
test('a delayed account read cannot overwrite another account and failed reads recover explicitly',async()=>{
  const pending=deferred();let hold=true;
  const b=await browser(url=>hold&&url.includes('user=A')?pending.promise:undefined);
  assert.equal(b.state('A').busy,true);assert.equal(b.state('B').edits.get('b1').input.value,'ONLY B');
  pending.reject(new Error('账号读取暂不可用'));await turn();assert.equal(b.state('A').loaded,false);assert.equal(b.state('A').add.disabled,true);assert.match(b.state('A').message.textContent,/读取失败/);
  hold=false;await b.state('A').refresh.onclick();assert.equal(b.state('A').edits.get('a1').input.value,'ONLY A');assert.equal(b.state('A').add.disabled,false);
});
test('a stale write keeps drafts, blocks replay and reload discards them only after confirmation',async()=>{
  let rejectWrite=true;
  const b=await browser((url,body)=>body&&rejectWrite?Promise.reject(new Error('记忆已被 QQ 或其他页面修改，请刷新后重试')):undefined),a=b.state('A');
  a.edits.get('a1').input.value='unsaved draft';await a.list.children[0].children[2].onclick();
  assert.equal(a.edits.get('a1').input.value,'unsaved draft');assert.equal(a.add.disabled,true);assert.match(a.message.textContent,/草稿已保留/);
  await a.list.children[0].children[2].onclick();await b.refresh();assert.equal(b.calls.filter(call=>call.body).length,1);
  await a.refresh.onclick();assert.match(a.refresh.textContent,/确认丢弃草稿/);assert.equal(a.edits.get('a1').input.value,'unsaved draft');
  a.cancelRefresh.onclick();assert.equal(a.edits.get('a1').input.value,'unsaved draft');
  rejectWrite=false;b.entries.A[0].text='QQ changed this';await a.refresh.onclick();await a.refresh.onclick();
  assert.equal(a.edits.get('a1').input.value,'QQ changed this');assert.equal(a.add.disabled,false);
});
test('uncertain writes lock controls until readback and never submit twice',async()=>{
  const pending=deferred();const b=await browser((url,body)=>body?pending.promise:undefined),a=b.state('A');
  a.addInput.value='new draft';const write=a.add.onclick();assert.equal(a.add.disabled,true);assert.equal(a.refresh.disabled,true);
  await a.add.onclick();await a.refresh.onclick();assert.equal(b.calls.filter(call=>call.body).length,1);
  pending.reject(new Error('操作请求超时，结果尚未确认'));await write;assert.equal(a.addInput.value,'new draft');assert.equal(a.add.disabled,true);assert.equal(a.refresh.disabled,false);
});
test('late responses for removed account cards are ignored after account rebinding',async()=>{
  const pending=deferred();let hold=true;
  const b=await browser(url=>hold&&url.includes('user=A')?pending.promise:undefined),old=b.state('A');
  b.status.users=b.status.users.filter(user=>user.id!=='A');await b.refresh();hold=false;b.status.users.push({id:'A',label:'A rebound',workspace:'new',sessions:[]});await b.refresh();await turn();
  pending.resolve({user:'A',revision:'obsolete',entries:[{id:'old',text:'obsolete'}]});await turn();assert.notEqual(b.state('A'),old);assert.equal(b.state('A').edits.has('old'),false);assert.equal(b.state('A').edits.get('a1').input.value,'ONLY A');
});

test('automatic memory settings save explicitly per account and preserve text drafts',async()=>{
  const pending=deferred();const b=await browser((url,body)=>body?.action==='configure'?pending.promise:undefined),a=b.state('A');
  assert.equal(a.automaticEnabled.checked,true);assert.equal(a.reviewEveryTurns.value,'10');assert.match(a.automaticStatus.textContent,/已开启/);
  a.edits.get('a1').input.value='unsaved entry';a.addInput.value='unfinished new entry';a.automaticEnabled.checked=false;a.automaticEnabled.onchange();a.reviewEveryTurns.value='25';a.reviewEveryTurns.oninput();
  assert.equal(a.automaticDraft.hidden,false);assert.equal(b.calls.filter(call=>call.body).length,0);assert.match(a.automaticStatus.textContent,/已开启/);
  await b.refresh();assert.equal(a.automaticEnabled.checked,false);assert.equal(a.reviewEveryTurns.value,'25');
  const write=a.saveAutomatic.onclick();assert.equal(a.automaticEnabled.disabled,true);assert.equal(a.reviewEveryTurns.disabled,true);assert.equal(a.saveAutomatic.disabled,true);assert.equal(a.add.disabled,true);assert.match(a.automaticStatus.textContent,/已开启/);
  assert.deepEqual(JSON.parse(JSON.stringify(b.calls.at(-1).body)),{user:'A',revision:'a-v1',action:'configure',automatic:{enabled:false,reviewEveryTurns:25}});
  pending.resolve({user:'A',revision:'a-v2',entries:structuredClone(b.entries.A),automatic:{enabled:false,reviewEveryTurns:25}});await write;
  assert.match(a.automaticStatus.textContent,/已关闭/);assert.match(a.automaticStatus.textContent,/现有记忆仍会加载/);assert.equal(a.automaticDraft.hidden,true);assert.equal(a.automaticEnabled.disabled,false);
  assert.equal(a.edits.get('a1').input.value,'unsaved entry');assert.equal(a.addInput.value,'unfinished new entry');assert.equal(b.state('B').automaticEnabled.checked,true);assert.match(a.message.textContent,/设置已保存/);
});

test('saving an entry retains unsaved automatic settings without applying them',async()=>{
  const b=await browser(),a=b.state('A');a.automaticEnabled.checked=false;a.automaticEnabled.onchange();a.reviewEveryTurns.value='17';a.reviewEveryTurns.oninput();
  a.edits.get('a1').input.value='edited A';await a.list.children[0].children[2].onclick();
  assert.equal(a.automaticEnabled.checked,false);assert.equal(a.reviewEveryTurns.value,'17');assert.equal(a.automaticDraft.hidden,false);assert.equal(a.automaticSaved.enabled,true);assert.match(a.automaticStatus.textContent,/已开启/);assert.equal(b.calls.some(call=>call.body?.action==='configure'),false);
  await a.saveAutomatic.onclick();assert.equal(b.automatic.A.enabled,false);assert.equal(b.automatic.A.reviewEveryTurns,17);assert.equal(b.automatic.B.enabled,true);assert.equal(a.edits.get('a1').input.value,'edited A');
});

test('automatic review interval rejects invalid values without sending writes',async()=>{
  const b=await browser(),a=b.state('A');
  for(const value of ['0','201','1.5','not a number']){a.reviewEveryTurns.value=value;await a.saveAutomatic.onclick();assert.match(a.message.textContent,/1–200/);}
  assert.equal(b.calls.filter(call=>call.body).length,0);assert.match(a.automaticStatus.textContent,/已开启/);
});

for(const failure of ['记忆已被其他页面修改，请刷新后重试','操作请求超时，结果尚未确认'])test(`failed automatic settings preserve all drafts and block replay: ${failure}`,async()=>{
  const b=await browser((url,body)=>body?.action==='configure'?Promise.reject(new Error(failure)):undefined),a=b.state('A');
  a.automaticEnabled.checked=false;a.automaticEnabled.onchange();a.reviewEveryTurns.value='14';a.reviewEveryTurns.oninput();a.edits.get('a1').input.value='draft survives';
  await a.saveAutomatic.onclick();assert.equal(a.automaticEnabled.checked,false);assert.equal(a.reviewEveryTurns.value,'14');assert.equal(a.edits.get('a1').input.value,'draft survives');assert.match(a.automaticStatus.textContent,/已开启/);assert.match(a.message.textContent,/草稿已保留/);
  assert.equal(a.automaticEnabled.disabled,true);assert.equal(a.reviewEveryTurns.disabled,true);assert.equal(a.saveAutomatic.disabled,true);await a.saveAutomatic.onclick();await b.refresh();assert.equal(b.calls.filter(call=>call.body).length,1);
});

test('refresh confirms discarding automatic settings and keeps them after read failure',async()=>{
  let fail=false;const b=await browser(url=>fail&&url.includes('user=A')?Promise.reject(new Error('offline')):undefined),a=b.state('A');
  a.automaticEnabled.checked=false;a.automaticEnabled.onchange();a.reviewEveryTurns.value='31';a.reviewEveryTurns.oninput();const reads=b.calls.filter(call=>call.url.includes('user=A')).length;
  await a.refresh.onclick();assert.match(a.refresh.textContent,/确认丢弃草稿/);assert.equal(b.calls.filter(call=>call.url.includes('user=A')).length,reads);a.cancelRefresh.onclick();assert.equal(a.automaticEnabled.checked,false);assert.equal(a.reviewEveryTurns.value,'31');
  fail=true;await a.refresh.onclick();await a.refresh.onclick();assert.match(a.message.textContent,/读取失败/);assert.equal(a.automaticEnabled.checked,false);assert.equal(a.reviewEveryTurns.value,'31');assert.equal(a.automaticDraft.hidden,false);
  fail=false;await a.refresh.onclick();await a.refresh.onclick();assert.equal(a.automaticEnabled.checked,true);assert.equal(a.reviewEveryTurns.value,'10');assert.equal(a.automaticDraft.hidden,true);
});

test('automatic provenance renders category and evidence as literal text and keeps editor actions',async()=>{
  const evidence='<img src=x onerror="alert(1)"> user explicitly prefers <plain> text',sourceMessage='<script>message</script>';
  const b=await browser(url=>url.includes('user=A')?{user:'A',revision:'a-v1',automatic:{enabled:false,reviewEveryTurns:12},entries:[{id:'a1',text:'A durable preference',origin:'automatic',manualEdited:true,category:'preference',evidence,source:{messageId:sourceMessage,threadId:'t1'}}]}:undefined),a=b.state('A'),row=a.list.children[0];
  assert.match(row.children[0].textContent,/自动提炼/);assert.match(row.children[0].textContent,/已手动编辑/);assert.match(row.children[0].textContent,/长期偏好/);assert.equal(row.children[1].tag,'textarea');assert.equal(row.children[2].textContent,'保存修改');
  assert.equal(row.children[5].children[1].textContent,evidence);assert.equal(row.children[5].children[1].children.length,0);assert.equal(row.children[5].children[2].textContent,'来源消息：'+sourceMessage);assert.equal(row.children[5].children[2].children.length,0);assert.match(a.automaticStatus.textContent,/已关闭/);assert.match(b.state('B').list.children[0].children[0].textContent,/手动添加/);
});

test('memory snapshots without automatic policy use backward-compatible defaults',async()=>{
  const b=await browser(url=>url.includes('user=A')?{user:'A',revision:'old-api',entries:[]}:undefined),a=b.state('A');
  assert.equal(a.loaded,true);assert.equal(a.automaticEnabled.checked,true);assert.equal(a.reviewEveryTurns.value,'10');assert.equal(a.automaticDraft.hidden,true);
});
