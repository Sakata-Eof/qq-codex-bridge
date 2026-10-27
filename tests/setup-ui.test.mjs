import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../public/setup.js',import.meta.url),'utf8');
const turn=()=>new Promise(resolve=>setImmediate(resolve));
async function browser({savedPanel,failure,users=[],pathname='/'}={}){
  const elements=new Map(),calls=[],focusCalls=[],scrollCalls=[],storage=new Map(savedPanel===undefined?[]:[['qq-codex-setup-panel',savedPanel]]);
  function element(tag='div'){
    const listeners=new Map();
    return {tag,children:[],dataset:{},value:'',hidden:false,disabled:false,textContent:'',attributes:{},
      set id(value){this._id=value;elements.set(value,this);},get id(){return this._id;},
      append(...nodes){for(const node of nodes){node.parent=this;this.children.push(node);}},
      replaceChildren(...nodes){this.children=[];this.append(...nodes);},
      remove(){if(this.parent)this.parent.children=this.parent.children.filter(node=>node!==this);},
      setAttribute(name,value){this.attributes[name]=value;},getAttribute(name){return this.attributes[name]??null;},removeAttribute(name){delete this.attributes[name];},
      addEventListener(name,callback){listeners.set(name,callback);},
      focus(options){focusCalls.push({node:this,options});},
      click(){let prevented=false;listeners.get('click')?.({button:0,preventDefault(){prevented=true;}});return prevented;},
    };
  }
  const ids=['overview','bot','accounts','memory','lifecycle','logs-panel','history-panel'];
  const sections=ids.map(id=>{const section=element('section');section.id=id;return section;});
  const links=ids.map(id=>{const link=element('a');link.setAttribute('href','#'+id);return link;});
  const status={users,appId:'test-app',sandbox:false,globalMemory:'shared rules',logs:[],pairingCodes:[],qq:'QQ 在线（READY）',codex:'已登录；每个 QQ 账号独立启动 Codex 进程',multimodal:'图片直接输入'};
  const location={pathname,hash:'#unchanged-login-token'},historyVisibility=[];
  const context=vm.createContext({document:{hidden:false,createElement:element,getElementById(id){if(!elements.has(id))elements.set(id,element());return elements.get(id);},querySelectorAll(selector){return selector==='[data-panel]'?sections:selector==='[data-panel-link]'?links:[];},addEventListener(){}},location,qqHistory:{setVisible:visible=>historyVisibility.push(visible)},setInterval(){},scrollTo(options){scrollCalls.push(options);},console,qqUI:{
    read:key=>storage.get(key),write:(key,value)=>storage.set(key,value),
    async request(url,body){calls.push({url,body});if(url==='/api/status'){if(failure)throw failure;return status;}if(url.startsWith('/api/memory/private?'))return {user:new URL(url,'http://localhost').searchParams.get('user'),revision:'demo',entries:[],automatic:{enabled:true,reviewEveryTurns:10}};throw new Error('Unexpected request '+url);},
  }});
  vm.runInContext(source,context);await turn();
  return {elements,sections,links,calls,focusCalls,scrollCalls,historyVisibility,status,storage,location,refresh:()=>vm.runInContext('refresh()',context),fail(error){failure=error;}};
}
const visiblePanels=b=>b.sections.filter(section=>!section.hidden).map(section=>section.id);

test('legacy history URL selects the shared history workspace and navigation controls its lifetime',async()=>{
  const b=await browser({pathname:'/history',savedPanel:'memory'});
  assert.deepEqual(visiblePanels(b),['history-panel']);assert.equal(b.elements.get('pageTitle').textContent,'消息历史');assert.deepEqual(b.historyVisibility,[true]);
  b.links[3].click();assert.deepEqual(visiblePanels(b),['memory']);assert.equal(b.historyVisibility.at(-1),false);
  b.elements.get('globalMemory').value='unfinished shared rules';b.links[6].click();
  assert.deepEqual(visiblePanels(b),['history-panel']);assert.equal(b.historyVisibility.at(-1),true);assert.equal(b.elements.get('globalMemory').value,'unfinished shared rules');
});

test('setup moves focus and scrolls to the top only after user navigation',async()=>{
  const b=await browser({savedPanel:'memory'});assert.equal(b.focusCalls.length,0);assert.equal(b.scrollCalls.length,0);
  b.links[1].click();assert.deepEqual(visiblePanels(b),['bot']);assert.equal(b.focusCalls.length,1);assert.equal(b.focusCalls[0].node,b.elements.get('pageTitle'));assert.equal(b.focusCalls[0].options.preventScroll,true);
  assert.equal(b.scrollCalls.length,1);assert.equal(b.scrollCalls[0].top,0);assert.equal(b.scrollCalls[0].behavior,'instant');
  await b.refresh();assert.equal(b.focusCalls.length,1);assert.equal(b.scrollCalls.length,1);
});

test('setup restores the saved panel with one visible section and matching navigation',async()=>{
  const b=await browser({savedPanel:'memory'});
  assert.deepEqual(visiblePanels(b),['memory']);assert.equal(b.elements.get('pageTitle').textContent,'记忆管理');
  assert.equal(b.links[3].getAttribute('aria-current'),'page');assert(b.links.filter((_,index)=>index!==3).every(link=>link.getAttribute('aria-current')===null));
  assert.match(b.elements.get('pageDescription').textContent,/各账号独立/);assert.equal(b.location.hash,'#unchanged-login-token');
});

for(const savedPanel of [undefined,'missing-panel','__proto__'])test(`setup falls back to overview for ${String(savedPanel)} saved navigation`,async()=>{
  const b=await browser({savedPanel});assert.deepEqual(visiblePanels(b),['overview']);assert.equal(b.elements.get('pageTitle').textContent,'运行概览');assert.equal(b.links[0].getAttribute('aria-current'),'page');
});

test('switching setup panels preserves form nodes and drafts without making requests',async()=>{
  const b=await browser(),input=b.elements.get('globalMemory'),appId=b.elements.get('appId'),callCount=b.calls.length;
  input.value='unfinished memory draft';appId.value='unfinished app draft';
  assert.equal(b.links[3].click(),true);assert.deepEqual(visiblePanels(b),['memory']);
  assert.equal(b.links[2].click(),true);assert.deepEqual(visiblePanels(b),['accounts']);assert.equal(b.links[3].getAttribute('aria-current'),null);
  assert.equal(b.storage.get('qq-codex-setup-panel'),'accounts');assert.equal(b.calls.length,callCount);assert.equal(b.location.hash,'#unchanged-login-token');
  await b.refresh();assert.equal(b.elements.get('globalMemory'),input);assert.equal(input.value,'unfinished memory draft');assert.equal(b.elements.get('appId'),appId);assert.equal(appId.value,'unfinished app draft');
});

test('setup summaries distinguish gateway readiness, login state and account sessions',async()=>{
  const b=await browser({users:[{id:'demo',label:'演示账号',workspace:'demo-workspace',sessions:[{status:'idle'},{status:'running'}]}]});
  assert.equal(b.elements.get('qqState').textContent,'在线');assert.equal(b.elements.get('qqState').dataset.tone,'ok');assert.equal(b.elements.get('codexState').dataset.tone,'ok');
  assert.equal(b.elements.get('accountCount').textContent,'1');assert.equal(b.elements.get('sessionCount').textContent,'2');assert.equal(b.elements.get('accountsEmpty').hidden,true);
  b.status.qq='QQ 连接关闭 (4009)';b.status.codex='Codex 尚未登录';await b.refresh();
  assert.equal(b.elements.get('qqState').dataset.tone,'error');assert.equal(b.elements.get('qqState').getAttribute('title'),'QQ 连接关闭 (4009)');assert.equal(b.elements.get('codexState').textContent,'未登录');assert.equal(b.elements.get('codexState').dataset.tone,'warn');
  b.status.qq='QQ 在线（RESUMED）';b.status.codex='已登录；每个 QQ 账号独立启动 Codex 进程';b.status.users=[];await b.refresh();
  assert.equal(b.elements.get('qqState').dataset.tone,'ok');assert.equal(b.elements.get('codexState').dataset.tone,'ok');assert.equal(b.elements.get('accountsEmpty').hidden,false);assert.equal(b.elements.get('sessionCount').textContent,'0');
});

for(const auth of [false,true])test(`setup marks loaded data stale after ${auth?'authentication':'connection'} failure and recovers`,async()=>{
  const b=await browser(),error=Object.assign(new Error('read failed'),{auth});
  b.fail(error);await b.refresh();await b.refresh();
  assert.equal(b.elements.get('connectionState').dataset.tone,'error');assert.match(b.elements.get('connectionState').textContent,/数据已过期/);
  for(const id of ['qqState','codexState']){assert.equal(b.elements.get(id).textContent,'状态已过期');assert.notEqual(b.elements.get(id).dataset.tone,'ok');}
  assert.equal(b.elements.get('status').textContent.match(/数据已过期/g).length,1);assert.match(b.elements.get('status').textContent,/QQ 在线/);
  b.fail(null);await b.refresh();assert.equal(b.elements.get('connectionState').dataset.tone,'ok');assert.equal(b.elements.get('qqState').dataset.tone,'ok');assert.doesNotMatch(b.elements.get('status').textContent,/数据已过期/);assert.equal(b.elements.get('notice').textContent,'');
});

test('setup never presents a first authentication failure as empty healthy data',async()=>{
  const b=await browser({failure:Object.assign(new Error('login expired'),{auth:true})});
  assert.match(b.elements.get('connectionState').textContent,/未登录/);assert.match(b.elements.get('status').textContent,/未登录/);assert.equal(b.elements.get('qqState').textContent,'尚未读取');assert.equal(b.elements.get('qqState').dataset.tone,'warn');assert.equal(b.elements.get('commands').textContent,'暂未获取指令状态');
});
