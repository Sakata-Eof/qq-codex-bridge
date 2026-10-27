const $=id=>document.getElementById(id);
const api=(url,body)=>qqUI.request(url,body,null,url.startsWith('/api/models?')||body?60000:10000);
let initial=true,refreshing=false,hasData=false,refreshError='';
const panels={
  overview:['运行概览','查看 QQ、Codex 与账号的当前状态。'],
  'history-panel':['消息历史','按账号与会话回看消息、附件和任务记录。'],
  bot:['机器人连接','配置专用机器人，并管理 QQ 指令面板。'],
  accounts:['账号管理','添加 QQ 账号，分配项目目录与模型。'],
  memory:['记忆管理','管理共同规则与各账号独立的长期记忆。'],
  lifecycle:['会话策略','设置会话轮换，让长时间任务保持连贯。'],
  'logs-panel':['服务日志','查看最近的连接和服务事件。'],
};
function setupNavigation(){
  if(!document.querySelectorAll)return;
  const sections=[...document.querySelectorAll('[data-panel]')],links=[...document.querySelectorAll('[data-panel-link]')];
  if(!sections.length)return;
  function selectPanel(candidate){
    const id=Object.hasOwn(panels,candidate)?candidate:'overview';
    for(const section of sections)section.hidden=section.id!==id;
    for(const link of links){if(link.getAttribute('href')==='#'+id)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');}
    if($('pageTitle'))$('pageTitle').textContent=panels[id][0];
    if($('pageDescription'))$('pageDescription').textContent=panels[id][1];
    globalThis.qqHistory?.setVisible(id==='history-panel');
    return id;
  }
  for(const link of links)link.addEventListener('click',event=>{if(event.button>0||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;event.preventDefault();qqUI.write?.('qq-codex-setup-panel',selectPanel(link.getAttribute('href').slice(1)));$('pageTitle')?.focus?.({preventScroll:true});globalThis.scrollTo?.({top:0,behavior:'instant'});});
  selectPanel(globalThis.location?.pathname==='/history'?'history-panel':qqUI.read?.('qq-codex-setup-panel'));
}
function statusSummary(id,text,tone='neutral',detail=''){
  const node=$(id);if(!node)return;node.textContent=text;node.dataset.tone=tone;if(detail)node.setAttribute('title',detail);
}
function refreshSummary(s){
  const qq=String(s.qq||''),codex=String(s.codex||'');
  const qqOnline=/^(?:QQ 在线（(?:READY|RESUMED)）|READY|RESUMED)$/.test(qq);
  const qqPending=qq==='正在连接'||qq==='未配置'||qq==='已停止';
  statusSummary('qqState',qqOnline?'在线':qqPending?qq:'连接异常',qqOnline?'ok':qqPending?'warn':'error',qq);
  const codexReady=/^已登录(?:；|$)/.test(codex),codexPending=codex==='正在检查',codexSignedOut=codex==='Codex 尚未登录';
  statusSummary('codexState',codexReady?'已登录':codexPending?'检查中':codexSignedOut?'未登录':'检查失败',codexReady?'ok':codexPending||codexSignedOut?'warn':'error',codex);
  statusSummary('accountCount',String(s.users.length));
  statusSummary('sessionCount',String(s.users.reduce((sum,user)=>sum+(user.sessions?.length||0),0)));
  if($('accountsEmpty'))$('accountsEmpty').hidden=s.users.length>0;
}
setupNavigation();
const privateMemoryCards=new Map();
function memoryNode(tag,text,className){
  const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;
}
function automaticMemoryDirty(state){return state.automaticEnabled.checked!==state.automaticSaved.enabled||Number(state.reviewEveryTurns.value)!==state.automaticSaved.reviewEveryTurns;}
function automaticMemoryDraft(state){state.automaticDraft.hidden=!automaticMemoryDirty(state);}
function memoryDrafts(state){return state.addInput.value.trim()||automaticMemoryDirty(state)||[...state.edits.values()].some(edit=>edit.input.value!==edit.original);}
function memoryControls(state){
  state.refresh.disabled=state.busy;state.cancelRefresh.disabled=state.busy;
  for(const control of state.controls)control.disabled=state.busy||!state.loaded||state.needsReload;
  state.card.setAttribute('aria-busy',String(state.busy));
}
function acceptMemory(state,data,changedId,{acceptAutomatic=false}={}){
  if(data.user!==state.user.id||!Array.isArray(data.entries)||typeof data.revision!=='string')throw new Error('记忆响应与当前账号不匹配，请重新加载。');
  const automatic=data.automatic??{enabled:true,reviewEveryTurns:10};
  if(typeof automatic.enabled!=='boolean'||!Number.isInteger(automatic.reviewEveryTurns)||automatic.reviewEveryTurns<1||automatic.reviewEveryTurns>200)throw new Error('自动记忆设置无效，请重新加载。');
  const keepAutomaticDraft=state.loaded&&!acceptAutomatic&&automaticMemoryDirty(state);
  const drafts=new Map([...state.edits].filter(([id,edit])=>id!==changedId&&edit.input.value!==edit.original).map(([id,edit])=>[id,edit.input.value]));
  state.automaticSaved={...automatic};
  if(!keepAutomaticDraft){state.automaticEnabled.checked=automatic.enabled;state.reviewEveryTurns.value=String(automatic.reviewEveryTurns);}
  state.automaticStatus.textContent=automatic.enabled?`已保存：自动记忆已开启，每完成 ${automatic.reviewEveryTurns} 轮回顾最近对话。`:'已保存：自动记忆已关闭，现有记忆仍会加载，也可以继续手动编辑。';automaticMemoryDraft(state);
  state.revision=data.revision;state.loaded=true;state.needsReload=false;state.confirmRefresh=false;state.refresh.textContent='刷新记忆';state.cancelRefresh.hidden=true;state.list.replaceChildren();state.edits.clear();state.controls=[state.addInput,state.add,state.automaticEnabled,state.reviewEveryTurns,state.saveAutomatic];
  state.summary.textContent=`${data.entries.length} / 40 条 · ${data.entries.reduce((sum,entry)=>sum+entry.text.length,0)} / 8000 字符`;
  if(!data.entries.length)state.list.append(memoryNode('p','此账号还没有独立记忆。','memory-empty'));
  for(const entry of data.entries){
    const category={preference:'长期偏好',profile:'用户信息',project:'项目背景',lesson:'经验与纠正'}[entry.category],origin=entry.origin==='automatic'?'自动提炼':'手动添加';
    const row=memoryNode('div',undefined,'memory-entry'),meta=memoryNode('small',[`编号 ${entry.id}`,origin,entry.manualEdited?'已手动编辑':'',category].filter(Boolean).join(' · ')),input=memoryNode('textarea');
    input.rows=3;input.maxLength=2000;input.value=drafts.get(entry.id)??entry.text;input.setAttribute('aria-label',state.user.label+' 的记忆 '+entry.id);
    const save=memoryNode('button','保存修改'),remove=memoryNode('button','删除','secondary'),cancel=memoryNode('button','取消删除','secondary');
    for(const button of [save,remove,cancel])button.type='button';cancel.hidden=true;
    save.onclick=()=>changeMemory(state,{action:'update',id:entry.id,text:input.value});
    remove.onclick=()=>{if(state.busy||state.needsReload)return;if(cancel.hidden){cancel.hidden=false;remove.textContent='确认删除';}else return changeMemory(state,{action:'remove',id:entry.id});};
    cancel.onclick=()=>{cancel.hidden=true;remove.textContent='删除';};
    state.edits.set(entry.id,{input,original:entry.text});state.controls.push(input,save,remove,cancel);row.append(meta,input,save,remove,cancel);
    if(typeof entry.evidence==='string'&&entry.evidence){const evidence=memoryNode('details',undefined,'memory-evidence');evidence.append(memoryNode('summary','查看记忆依据'),memoryNode('p',entry.evidence));if(typeof entry.source?.messageId==='string')evidence.append(memoryNode('small','来源消息：'+entry.source.messageId));row.append(evidence);}
    state.list.append(row);
  }
}
async function loadMemory(state,discard=false){
  if(state.busy||privateMemoryCards.get(state.user.id)!==state)return;
  if(state.loaded&&memoryDrafts(state)&&!discard){state.confirmRefresh=true;state.refresh.textContent='确认丢弃草稿并刷新';state.cancelRefresh.hidden=false;state.message.textContent='刷新会丢弃此账号未保存的修改；也可以取消刷新，先复制或保存草稿。';return;}
  state.confirmRefresh=false;state.refresh.textContent='刷新记忆';state.cancelRefresh.hidden=true;state.busy=true;state.message.textContent='正在读取此账号的记忆…';memoryControls(state);
  try{
    const data=await api('/api/memory/private?user='+encodeURIComponent(state.user.id));
    if(privateMemoryCards.get(state.user.id)!==state)return;
    // Explicit reload discards drafts only after the read succeeds.
    const oldEdits=state.edits;state.edits=new Map();
    try{acceptMemory(state,data,undefined,{acceptAutomatic:true});}catch(e){state.edits=oldEdits;throw e;}
    state.addInput.value='';state.message.textContent='已读取。保存后从该账号的下一次任务起加载。';
  }catch(e){state.needsReload=true;state.message.textContent='读取失败：'+e.message+' 已有内容和草稿已保留，请刷新记忆重试。';}
  finally{state.busy=false;memoryControls(state);}
}
async function changeMemory(state,change){
  if(state.busy||!state.loaded||state.needsReload||privateMemoryCards.get(state.user.id)!==state)return;
  if(change.action==='configure'){
    if(typeof change.automatic?.enabled!=='boolean'||!Number.isInteger(change.automatic.reviewEveryTurns)||change.automatic.reviewEveryTurns<1||change.automatic.reviewEveryTurns>200){state.message.textContent='回顾间隔需要为 1–200 的整数轮数。';return;}
  }else if(change.action!=='remove'&&(!change.text.trim()||change.text.length>2000)){state.message.textContent='记忆内容需要为 1–2000 字符。';return;}
  state.busy=true;state.message.textContent='正在保存此账号的记忆…';memoryControls(state);
  try{
    const data=await api('/api/memory/private',{user:state.user.id,revision:state.revision,...change});
    if(privateMemoryCards.get(state.user.id)!==state)return;
    acceptMemory(state,data,change.id,{acceptAutomatic:change.action==='configure'});if(change.action==='add')state.addInput.value='';
    state.message.textContent=change.action==='configure'?'此账号的自动记忆设置已保存。':change.action==='remove'?'已删除此账号的记忆，下一次任务起加载。':'已保存到此账号的独立记忆，下一次任务起加载。';
  }catch(e){
    // A failed/uncertain write must be read back before another write, never replayed.
    state.needsReload=true;state.message.textContent=e.message+' 草稿已保留；请先复制需要的内容，再刷新记忆核对结果。';
  }finally{state.busy=false;memoryControls(state);}
}
function syncPrivateMemories(users){
  const ids=new Set(users.map(user=>user.id));for(const [id,state] of privateMemoryCards)if(!ids.has(id)){state.card.remove();privateMemoryCards.delete(id);}
  $('privateMemoryEmpty').hidden=users.length>0;
  for(const user of users){
    let state=privateMemoryCards.get(user.id);
    if(state){state.user=user;state.title.textContent=user.label;continue;}
    const card=memoryNode('section',undefined,'memory-account'),title=memoryNode('h3',user.label),identity=memoryNode('small','账号标识：'+user.id),summary=memoryNode('p','尚未读取'),message=memoryNode('p','正在读取…','memory-message'),list=memoryNode('div'),refresh=memoryNode('button','刷新记忆','secondary'),cancelRefresh=memoryNode('button','取消刷新','secondary'),addLabel=memoryNode('label','新增此账号的记忆'),addInput=memoryNode('textarea'),add=memoryNode('button','新增记忆');
    const automaticControls=memoryNode('div',undefined,'memory-automatic'),automaticLabel=memoryNode('label',undefined,'memory-toggle'),automaticEnabled=memoryNode('input'),automaticText=memoryNode('span','自动提炼长期记忆'),reviewLabel=memoryNode('label','每完成多少轮回顾最近对话'),reviewEveryTurns=memoryNode('input'),automaticStatus=memoryNode('p','正在读取自动记忆设置…'),automaticDraft=memoryNode('small','设置修改尚未保存。'),saveAutomatic=memoryNode('button','保存自动记忆设置');
    automaticEnabled.type='checkbox';automaticEnabled.checked=true;automaticEnabled.setAttribute('aria-label',user.label+' 的自动记忆开关');reviewEveryTurns.type='number';reviewEveryTurns.min='1';reviewEveryTurns.max='200';reviewEveryTurns.step='1';reviewEveryTurns.value='10';reviewEveryTurns.setAttribute('aria-label',user.label+' 的记忆回顾间隔');automaticDraft.hidden=true;automaticStatus.setAttribute('role','status');automaticLabel.append(automaticEnabled,automaticText);reviewLabel.append(reviewEveryTurns);automaticControls.append(automaticLabel,reviewLabel,automaticStatus,automaticDraft,saveAutomatic);
    message.setAttribute('role','status');message.setAttribute('aria-live','polite');list.className='memory-list';addInput.rows=3;addInput.maxLength=2000;addInput.value='';addInput.placeholder='只会加载给此 QQ 账号；每条最多 2000 字符';addInput.setAttribute('aria-label',user.label+' 的新增记忆');addLabel.append(addInput);cancelRefresh.hidden=true;
    for(const button of [refresh,cancelRefresh,add,saveAutomatic])button.type='button';
    state={user,card,title,summary,message,list,refresh,cancelRefresh,addInput,add,automaticEnabled,reviewEveryTurns,automaticStatus,automaticDraft,saveAutomatic,automaticSaved:{enabled:true,reviewEveryTurns:10},controls:[addInput,add,automaticEnabled,reviewEveryTurns,saveAutomatic],edits:new Map(),busy:false,loaded:false,needsReload:false};
    automaticEnabled.onchange=()=>automaticMemoryDraft(state);reviewEveryTurns.oninput=()=>automaticMemoryDraft(state);saveAutomatic.onclick=()=>changeMemory(state,{action:'configure',automatic:{enabled:automaticEnabled.checked,reviewEveryTurns:Number(reviewEveryTurns.value)}});
    refresh.onclick=()=>loadMemory(state,state.confirmRefresh);cancelRefresh.onclick=()=>{state.confirmRefresh=false;refresh.textContent='刷新记忆';cancelRefresh.hidden=true;message.textContent='已取消刷新，草稿已保留。';};add.onclick=()=>changeMemory(state,{action:'add',text:addInput.value});
    card.append(title,identity,summary,automaticControls,refresh,cancelRefresh,message,list,addLabel,add);privateMemoryCards.set(user.id,state);$('privateMemories').append(card);void loadMemory(state);
  }
}
async function refresh(){if(refreshing)return;refreshing=true;try{
  const s=await api('/api/status');if(initial){$('appId').value=s.appId;$('sandbox').checked=s.sandbox;$('globalMemory').value=s.globalMemory||'';$('rotationTurns').value=s.rotationTurns||40;$('idleHours').value=s.idleHours||6;initial=false;}
  hasData=true;if(refreshError&&$('notice').textContent===refreshError)$('notice').textContent='';refreshError='';statusSummary('connectionState','页面已连接 · '+new Date().toLocaleTimeString('zh-CN'),'ok');refreshSummary(s);$('status').textContent=`QQ：${s.qq}\nCodex：${s.codex}\n授权账号：${s.users.length}\n${s.multimodal}`;
  $('commands').textContent=s.commands?.ok?`已同步 ${s.commands.count} 个指令${s.commands.quickMenu?.ok?'，底部菜单：'+s.commands.quickMenu.groups.join('、'):''}；保留 ${s.commands.preservedPanels} 个其他面板；最近核对 ${new Date(s.commands.time).toLocaleString('zh-CN')}`:(s.commands?.message||'等待同步…');
  $('pair').replaceChildren(...s.pairingCodes.map(p=>{const pre=document.createElement('pre');pre.textContent=`${p.label}\n${p.command}`;return pre;}));
  $('logs').textContent=s.logs.join('\n');syncPrivateMemories(s.users);
  const signatures=s.users.map(u=>u.id+u.workspace).join('|');
  if($('results').dataset.signature!==signatures){$('results').dataset.signature=signatures;$('results').replaceChildren(...s.users.map(u=>{
    const div=document.createElement('div');div.className='result';const title=document.createElement('h3');title.textContent=u.label;
    const input=document.createElement('input');input.value=u.workspace;input.setAttribute('aria-label',u.label+' 的项目目录');const button=document.createElement('button');button.type='button';button.className='secondary';button.textContent='分配该账号的项目目录';button.onclick=async()=>{try{await api('/api/user',{id:u.id,workspace:input.value});await refresh();}catch(e){$('notice').textContent=e.message;}};
    const pre=document.createElement('pre');pre.id='user-'+u.id;
    const modelLine=document.createElement('p');modelLine.id='model-'+u.id;
    const loadModels=document.createElement('button');loadModels.type='button';loadModels.className='secondary';loadModels.textContent='查看／切换此账号模型';
    const controls=document.createElement('div');controls.hidden=true;
    loadModels.onclick=async()=>{loadModels.disabled=true;try{const data=await api('/api/models?user='+encodeURIComponent(u.id));controls.replaceChildren();controls.hidden=false;
      const model=document.createElement('select');model.setAttribute('aria-label',u.label+' 模型');
      const def=document.createElement('option');def.value='default';def.textContent='继承 Codex 默认';model.append(def);
      for(const m of data.models){const opt=document.createElement('option');opt.value=m.model;opt.textContent=m.name+' · '+(m.inputModalities.includes('image')?'支持图片':'仅文字');model.append(opt);}
      model.value=data.current.inherited?'default':data.current.model;
      const effort=document.createElement('select');effort.setAttribute('aria-label',u.label+' 推理强度');
      const fillEfforts=()=>{effort.replaceChildren();const entry=data.models.find(x=>x.model===model.value);effort.hidden=!entry;if(!entry)return;for(const value of entry.efforts){const opt=document.createElement('option');opt.value=value;opt.textContent=value;effort.append(opt);}effort.value=entry.efforts.includes(data.current.effort)?data.current.effort:entry.defaultEffort;};model.onchange=fillEfforts;fillEfforts();
      const save=document.createElement('button');save.textContent='保存此账号模型';save.onclick=async()=>{save.disabled=true;try{await api('/api/model',{user:u.id,model:model.value,...(model.value==='default'?{}:{effort:effort.value})});$('notice').textContent='模型已保存，下一次任务生效，当前会话上下文保留。';await refresh();}catch(e){$('notice').textContent=e.message;}finally{save.disabled=false;}};
      const note=document.createElement('small');note.textContent='模型列表来自本机 Codex；实际访问以任务结果为准。QQ 可用 /models 选择，或 /model 模型名 high。';controls.append(model,effort,save,note);
    }catch(e){$('notice').textContent=e.message;}finally{loadModels.disabled=false;}};
    div.append(title,input,button,modelLine,loadModels,controls,pre);return div;
  }));}
  for(const u of s.users){$('model-'+u.id).textContent=`账号模型：${u.model?.model||'Codex 配置默认'} · 推理强度 ${u.model?.effort||'默认'}${u.model?.inherited?'（继承）':''}`;$('user-'+u.id).textContent=`独立进程：${u.process||'按需启动'}\n`+u.sessions.map(x=>`${x.status}\n${x.cwd}\n最近执行模型：${x.model||'未知'} · ${x.effort||'默认'}\n${x.last||'尚无结果'}`).join('\n\n');}
}catch(e){statusSummary('connectionState',(e.auth?'页面未登录':'页面连接中断')+(hasData?' · 数据已过期':'，无法读取数据'),'error');for(const id of ['qqState','codexState'])statusSummary(id,hasData?'状态已过期':'尚未读取','warn');if(!hasData){$('status').textContent=e.auth?'未登录，请从本机启动脚本验证后查看':'读取失败，正在重试';$('commands').textContent='暂未获取指令状态';}else if(!$('status').textContent.startsWith('数据已过期'))$('status').textContent='数据已过期，以下为上次读取的状态：\n'+$('status').textContent;refreshError=e.message;$('notice').textContent=e.message;}finally{refreshing=false;}}
$('form').onsubmit=async e=>{e.preventDefault();try{await api('/api/config',{appId:$('appId').value.trim(),clientSecret:$('clientSecret').value.trim(),sandbox:$('sandbox').checked});$('clientSecret').value='';$('notice').textContent='已保存，正在连接 QQ。';await refresh();}catch(e){$('notice').textContent=e.message;}};
$('reconnect').onclick=async()=>{try{await api('/api/reconnect',{});await refresh();}catch(e){$('notice').textContent=e.message;}};
$('pairButton').onclick=async()=>{try{await api('/api/pair',{label:$('userLabel').value});await refresh();}catch(e){$('notice').textContent=e.message;}};
$('saveMemory').onclick=async()=>{try{await api('/api/memory',{text:$('globalMemory').value});$('notice').textContent='全局记忆已保存，下次任务起加载。';}catch(e){$('notice').textContent=e.message;}};
$('saveLifecycle').onclick=async()=>{try{await api('/api/lifecycle',{rotationTurns:Number($('rotationTurns').value),idleHours:Number($('idleHours').value)});$('notice').textContent='会话策略已保存。';}catch(e){$('notice').textContent=e.message;}};
$('syncCommands').onclick=async()=>{const b=$('syncCommands');b.disabled=true;try{const s=await api('/api/commands/sync',{});$('notice').textContent=`QQ 已回读核对 ${s.count} 个指令。`;await refresh();}catch(e){$('notice').textContent=e.message;}finally{b.disabled=false;}};
document.addEventListener('qq-ui-retry',()=>void refresh());document.addEventListener('visibilitychange',()=>{if(!document.hidden)void refresh();});void refresh();setInterval(()=>{if(!document.hidden)void refresh();},5000);
