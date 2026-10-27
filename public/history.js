const history$=id=>document.getElementById(id);
let user='',thread='',sessions=[],sessionNext=null,pageStack=[''],next=null,watermark=0,generation=0,request=null,polling=false,searchTimer,assets=new Map(),sessionSignature='';
const historyHost=document.querySelector?.('#history-panel')||null,historyReads=new Set();
let historyActive=!historyHost||!historyHost.hidden,historyLifecycleEpoch=0,historyPollSequence=0;
async function historyAPI(url,body,signal){
  // Writes must finish once submitted; a hidden panel must never replay them.
  if(body)return qqUI.request(url,body,signal,60000);
  if(!historyActive)throw new DOMException('历史分区已隐藏','AbortError');
  const lifecycle=historyLifecycleEpoch,controller=new AbortController(),cancel=()=>controller.abort();
  if(signal?.aborted)cancel();else signal?.addEventListener('abort',cancel,{once:true});
  historyReads.add(controller);
  try{
    const data=await qqUI.request(url,body,controller.signal,10000);
    if(!historyActive||lifecycle!==historyLifecycleEpoch||controller.signal.aborted)throw new DOMException('历史读取已取消','AbortError');
    return data;
  }finally{historyReads.delete(controller);signal?.removeEventListener('abort',cancel);}
}
let pageFailed=false,hasPage=false,pageLoading=false,accountLoading=false,sessionsLoading=false,sessionsRequest=0,exporting=false,controlsBusy=false,lastNavigationUnlock=-Infinity;
const viewLoading=()=>pageLoading||accountLoading;
// This read-only view owns its requests and errors independently of message pages.
const taskView=(()=>{
  let account='',epoch=0,busy=false,controller=null,detailController=null,detailKey='',detailHost=null,opened='',signature='',rows=[],cache=new Map();
  const taskKey=task=>task.id+'|'+task.updatedAt+'|'+task.eventCount;
  const node=(tag,value,className)=>{const element=document.createElement(tag);if(value!==undefined)element.textContent=value;if(className)element.className=className;return element;};
  const time=value=>{const date=new Date(value);return Number.isNaN(date.getTime())?'时间未知':date.toLocaleString('zh-CN');};
  const problem=task=>task.executionStatus==='unknown'?'执行结果不明确，请先核对任务，勿重复提交':task.executionStatus==='failed'?'执行失败，请查看阶段记录':
    task.deliveryStatus==='unknown'?'投递状态不明确，请先核对 QQ 收件':task.deliveryStatus==='partial'?'结果仅部分投递':task.deliveryStatus==='failed'?'结果投递失败':'';
  function reset(id){
    account=id;epoch++;controller?.abort();detailController?.abort();controller=detailController=null;busy=false;opened='';signature='';rows=[];cache.clear();
    history$('taskList').replaceChildren();history$('taskDiagnostics').textContent='';history$('taskError').hidden=true;history$('taskLoading').hidden=true;history$('taskRefresh').disabled=!account;
    history$('taskEmpty').hidden=false;history$('taskEmpty').textContent=account?'升级后的新任务会在这里记录':'请选择账号';
  }
  async function detail(task,container){
    const ticket=epoch,owner=account,key=taskKey(task);
    if(cache.has(key)){container.replaceChildren(cache.get(key));return;}
    if(detailKey===key&&detailHost===container&&!detailController?.signal.aborted)return;
    detailKey=key;detailHost=container;
    detailController?.abort();const active=detailController=new AbortController();container.replaceChildren(node('div','正在读取阶段记录…','task-note'));
    try{
      const data=await historyAPI('/api/tasks/'+encodeURIComponent(task.id)+'?'+new URLSearchParams({user:owner}),null,active.signal);
      if(ticket!==epoch||owner!==account||active.signal.aborted||opened!==task.id)return;
      if(data.task?.user!==owner||data.task.id!==task.id)throw new Error('任务不属于当前账号');
      const events=Array.isArray(data.task.events)?data.task.events.slice(-100):[],list=node('ol',undefined,'task-events');
      for(const event of events)list.append(node('li',`${time(event.createdAt||event.time)} · ${event.label||event.stage}${event.codeLabel?' · '+event.codeLabel:''}`));
      const content=node('div');content.append(list);
      if(!events.length)content.append(node('div','尚无阶段记录','task-note'));
      if(data.task.eventCount>events.length)content.append(node('div',`仅显示最近 ${events.length} 个阶段，共 ${data.task.eventCount} 个`,'task-note'));
      cache.set(key,content);container.replaceChildren(content);
    }catch(error){if(ticket===epoch&&owner===account&&!active.signal.aborted&&opened===task.id){const retry=node('button','重新读取阶段');retry.type='button';retry.onclick=()=>void detail(task,container);container.replaceChildren(node('div',error.auth?'请先验证页面登录':'阶段记录暂时不可用','task-error'),retry);}}
    finally{if(detailController===active){detailKey='';detailHost=null;}}
  }
  function render(){
    const nextSignature=JSON.stringify(rows);if(signature===nextSignature)return;signature=nextSignature;
    const validKeys=new Set(rows.map(taskKey));for(const key of cache.keys())if(!validKeys.has(key))cache.delete(key);
    if(!rows.some(task=>task.id===opened)){opened='';detailController?.abort();}
    const cards=rows.map(task=>{
      const card=node('details',undefined,'task-card'),summary=node('summary'),body=node('div');card.dataset.id=task.id;
      summary.append(node('div',task.title||'未命名任务','task-title'),node('div',`任务 ${String(task.id).slice(0,8)}${task.parentTaskId?' · 补充至 '+String(task.parentTaskId).slice(0,8):''} · 阶段：${task.stageLabel||task.stage||'待处理'} · ${time(task.updatedAt)}`,'task-status'),
        node('div',`执行：${task.executionLabel||task.executionStatus||'待处理'} · 投递：${task.deliveryLabel||task.deliveryStatus||'待处理'}`,'task-status'));
      const issue=problem(task);if(issue)summary.append(node('div',issue,'task-problem'));card.append(summary,body);
      card.ontoggle=()=>{
        if(!historyActive||!Array.from(history$('taskList').children).includes(card))return;
        if(card.open){opened=task.id;for(const other of history$('taskList').children)if(other!==card)other.open=false;void detail(task,body);}
        else if(opened===task.id){opened='';detailController?.abort();}
      };
      if(opened===task.id){card.open=true;void detail(task,body);}return card;
    });
    history$('taskList').replaceChildren(...cards);history$('taskEmpty').hidden=rows.length>0;history$('taskEmpty').textContent='暂无任务记录；升级后的新任务会在这里记录';
  }
  async function refresh(){
    if(!historyActive||!account||!history$('taskPanel').open||busy||document.hidden||viewLoading())return;
    const ticket=epoch,owner=account,active=controller=new AbortController();busy=true;history$('taskLoading').hidden=false;history$('taskRefresh').disabled=true;
    try{
      const results=await Promise.allSettled([historyAPI('/api/tasks?'+new URLSearchParams({user:owner,limit:'10'}),null,active.signal),historyAPI('/api/diagnostics?'+new URLSearchParams({user:owner}),null,active.signal)]);
      if(ticket!==epoch||owner!==account||active.signal.aborted)return;
      const [tasks,diagnostics]=results;
      if(tasks.status==='fulfilled'&&Array.isArray(tasks.value.tasks)){
        rows=tasks.value.tasks.filter(task=>task.user===owner).slice(0,10);render();history$('taskError').hidden=true;
      }else{history$('taskError').hidden=false;history$('taskError').textContent=tasks.reason?.auth?'请先验证页面登录以读取任务':'任务状态暂时不可用，已显示的记录会保留';}
      if(diagnostics.status==='fulfilled'&&diagnostics.value.user===owner){
        const value=diagnostics.value;history$('taskDiagnostics').textContent=[value.qq?.label,value.process?.label,value.tracking?.label,value.model?.label,...(Array.isArray(value.problems)?value.problems:[])].filter(Boolean).join(' · ');
      }else history$('taskDiagnostics').textContent='诊断摘要暂时不可用';
    }catch{
      if(ticket===epoch&&owner===account&&!active.signal.aborted){history$('taskError').hidden=false;history$('taskError').textContent='任务状态暂时不可用，已显示的记录会保留';}
    }finally{if(ticket===epoch&&owner===account){busy=false;history$('taskLoading').hidden=true;history$('taskRefresh').disabled=false;}}
  }
  function pause(){controller?.abort();detailController?.abort();epoch++;busy=false;opened='';for(const card of history$('taskList').children)card.open=false;history$('taskLoading').hidden=true;history$('taskRefresh').disabled=!account;}
  history$('taskPanel').ontoggle=()=>{if(history$('taskPanel').open)void refresh();else pause();};history$('taskRefresh').onclick=()=>void refresh();
  return {reset,refresh,pause};
})();
function navigationBlocked(event){return !historyActive||viewLoading()||Boolean(event&&Number.isFinite(event.timeStamp)&&event.timeStamp<=lastNavigationUnlock);}
function afterPaint(){
  if(document.hidden||typeof requestAnimationFrame!=='function')return Promise.resolve();
  return new Promise(resolve=>{
    let frame,timer,finished=false;
    const finish=()=>{if(finished)return;finished=true;clearTimeout(timer);if(typeof cancelAnimationFrame==='function')cancelAnimationFrame(frame);document.removeEventListener('visibilitychange',onVisibility);resolve();};
    const onVisibility=()=>{if(document.hidden)finish();};
    document.addEventListener('visibilitychange',onVisibility);timer=setTimeout(finish,100);frame=requestAnimationFrame(()=>{frame=requestAnimationFrame(finish);});
  });
}
function syncControls(){
  const busy=viewLoading();
  if(controlsBusy&&!busy)lastNavigationUnlock=globalThis.performance?.now()??Date.now();controlsBusy=busy;
  for(const id of ['users','sessions']){const container=history$(id);container.inert=busy;container.setAttribute('aria-busy',String(busy));for(const button of container.children)button.disabled=busy;}
  history$('moreSessions').disabled=busy||sessionsLoading;
  for(const id of ['search','pageSize','latest','newMessages','rename'])history$(id).disabled=busy||!thread;
  history$('export').disabled=busy||!thread||exporting;
  history$('newer').disabled=busy||!hasPage||pageFailed||pageStack.length===1;
  history$('older').disabled=busy||!hasPage||pageFailed||!next;
  history$('loading').hidden=!busy;history$('messages').setAttribute('aria-busy',String(busy));
}
function resetPage(message){hasPage=false;pageFailed=false;pageStack=[''];next=null;watermark=0;history$('messages').replaceChildren();history$('empty').hidden=false;history$('empty').textContent=message;history$('pageInfo').textContent='正在读取消息数量…';}
function disposeAssets(){for(const asset of assets.values()){asset.controller.abort();if(asset.url)URL.revokeObjectURL(asset.url);}assets.clear();}
function invalidate(){generation++;clearTimeout(searchTimer);request?.abort();disposeAssets();history$('newMessages').hidden=true;return generation;}
function error(e){if(e.name!=='AbortError'){history$('state').textContent=e.auth?'页面未登录，无法读取历史':`读取失败，稍后会重试：${e.message}`;if(!hasPage){history$('empty').hidden=false;history$('empty').textContent=e.auth?'请先从本机启动脚本验证登录':'消息尚未加载成功，正在重试';history$('pageInfo').textContent='未读取到消息数量';}}}
async function copyText(value){
  try{if(globalThis.navigator?.clipboard?.writeText){await navigator.clipboard.writeText(value);return;}}catch{}
  const focused=document.activeElement,selection=window.getSelection?.(),ranges=selection?Array.from({length:selection.rangeCount},(_,i)=>selection.getRangeAt(i).cloneRange()):[],input=document.createElement('textarea');
  input.value=value;input.readOnly=true;input.style.position='fixed';input.style.opacity='0';input.style.left='-9999px';document.body.append(input);
  try{input.select();if(!document.execCommand('copy'))throw new Error('浏览器未允许复制');}
  finally{input.remove();focused?.focus({preventScroll:true});if(selection){selection.removeAllRanges();for(const range of ranges)selection.addRange(range);}}
}
function copyButton(value){
  const button=document.createElement('button');button.type='button';button.className='copy';button.textContent='复制';button.title='复制这条消息的完整正文';button.setAttribute('aria-label','复制这条消息的完整正文');button.setAttribute('aria-live','polite');
  button.onclick=async()=>{button.disabled=true;try{await copyText(value);button.textContent='已复制';}catch{button.textContent='复制失败';button.title='浏览器未允许复制，请手动选择正文复制';}finally{button.disabled=false;setTimeout(()=>{button.textContent='复制';button.title='复制这条消息的完整正文';},2000);}};
  return button;
}
function preview(file,container,account){
  const source=file.path||file,name=file.name||String(source).split(/[\\/]/).pop(),box=document.createElement('div'),button=document.createElement('button'),content=document.createElement('div');box.className='attachment';button.textContent=`查看附件 · ${name}`;box.append(button,content);container.append(box);
  button.onclick=async()=>{
    if(!historyActive)return;
    if(content.childNodes.length){const media=content.querySelector('video,audio');media?.pause();content.replaceChildren();button.textContent=`查看附件 · ${name}`;return;}
    const epoch=generation;button.disabled=true;button.textContent='加载附件…';const key=account+'\n'+source;
    try{
      let asset=assets.get(key);if(!asset){asset={controller:new AbortController()};assets.set(key,asset);asset.promise=(async()=>{const blob=await qqUI.asset(`/api/asset?user=${encodeURIComponent(account)}&file=${encodeURIComponent(source)}`,asset.controller.signal);if(asset.controller.signal.aborted)throw new DOMException('已取消','AbortError');asset.url=URL.createObjectURL(blob);asset.type=blob.type;return asset;})();}
      await asset.promise;if(epoch!==generation||!box.isConnected)return;let node;
      if(asset.type.startsWith('image/')){node=document.createElement('img');node.alt=name;node.decoding='async';node.src=asset.url;}
      else if(asset.type.startsWith('video/')||asset.type.startsWith('audio/')){node=document.createElement(asset.type.startsWith('video/')?'video':'audio');node.controls=true;node.preload='metadata';node.src=asset.url;}
      else{node=document.createElement('a');node.href=asset.url;node.download=name;node.textContent='下载 '+name;}
      content.append(node);button.textContent=`收起附件 · ${name}`;
    }catch(e){assets.delete(key);if(epoch===generation&&box.isConnected){content.textContent=e.name==='AbortError'?'附件加载已取消':e.message;button.textContent='重新加载附件';}}
    finally{button.disabled=false;}
  };
}
function render(records){
  const merged=records.filter(r=>r.mergedInto).length;records=records.filter(r=>!r.mergedInto);
  history$('messages').replaceChildren();history$('empty').hidden=records.length>0;history$('empty').textContent=thread?(history$('search').value?'没有匹配的消息':'这个会话暂无消息'):'请选择会话';
  if(!records.length&&merged)history$('empty').textContent='本页的重复结果已合并到对应的发送消息，可翻页查看。';
  const labels={inbound:'收到',outbound:'发送',error:'错误',assets:'附件',result:'任务结果'};
  const nodes=records.map(r=>{const div=document.createElement('article');div.className='message '+r.kind;const meta=document.createElement('div');meta.className='meta';meta.textContent=`${r.taskResult?'发送 · 任务结果':labels[r.kind]||r.kind} · ${new Date(r.time).toLocaleString('zh-CN')}`;if(r.text)meta.append(copyButton(r.text));const text=document.createElement('div');text.className='text';text.textContent=r.text||'';div.append(meta);
    if(r.kind==='result'&&r.partialDelivery){const detail=document.createElement('details'),summary=document.createElement('summary');summary.textContent='查看完整任务结果（发送内容已在列表中）';detail.append(summary,text);div.append(detail);}else div.append(text);
    if(r.kind==='result'&&!r.partialDelivery){const info=document.createElement('div');info.className='status';info.textContent='Codex 已保存结果；尚未找到内容一致的 QQ 发送记录。';div.append(info);}
    if(r.buttons?.length){const info=document.createElement('div');info.className='status';info.textContent='按钮：'+r.buttons.join(' · ');div.append(info);}
    if(r.attachments?.length){const info=document.createElement('div');info.className='status';info.textContent=r.attachments.map(a=>`${a.filename||a.type}${a.size?' · '+Math.round(a.size/1024)+' KB':''}`).join('；');div.append(info);}
    for(const f of r.files||[])preview(f,div,user);if(r.file)preview(r.file,div,user);return div;});history$('messages').append(...nodes);return {displayed:records.length,merged};
}
function renderSessions(){
  const sig=JSON.stringify(sessions.map(s=>({id:s.id,title:s.title,count:s.count})))+'|'+thread+'|'+sessionNext;if(sig===sessionSignature){syncControls();return;}sessionSignature=sig;
  history$('sessions').replaceChildren(...sessions.map(s=>{const b=document.createElement('button');b.className='session'+(s.id===thread?' selected':'');const title=document.createElement('span'),meta=document.createElement('small');title.textContent=s.title;meta.textContent=`${s.count} 条 · ${new Date(s.lastAt).toLocaleDateString('zh-CN')}`;b.append(title,meta);b.onclick=e=>{if(!navigationBlocked(e))void selectSession(s.id).catch(error);};return b;}));
  history$('moreSessions').hidden=!sessionNext;const active=sessions.find(s=>s.id===thread);history$('sessionTitle').textContent=active?.title||'请选择会话';history$('rename').hidden=!active||thread==='__unassigned__';syncControls();
}
async function loadSessions(older=false){
  if(!historyActive||!user||(older&&(viewLoading()||sessionsLoading||!sessionNext)))return;const account=user,epoch=generation,sequence=++sessionsRequest;sessionsLoading=true;syncControls();
  try{const d=await historyAPI('/api/history/sessions?'+new URLSearchParams({user:account,limit:'30',...(older&&sessionNext?{before:sessionNext}:{})}));if(account!==user||epoch!==generation||sequence!==sessionsRequest)return;
    if(older){sessions=[...sessions,...d.sessions];sessionNext=d.next;}else{const olderSessions=sessions.filter(s=>!d.sessions.some(x=>x.id===s.id));sessions=[...d.sessions,...olderSessions];if(!olderSessions.length)sessionNext=d.next;}
    if(!thread&&sessions.length){thread=(sessions.find(s=>s.id===qqUI.read('qq-history-thread:'+user))||sessions.find(s=>s.id!=='__unassigned__')||sessions[0]).id;qqUI.write('qq-history-thread:'+user,thread);renderSessions();await loadPage();}else renderSessions();
  }catch(e){if(account===user&&epoch===generation&&sequence===sessionsRequest){error(e);throw e;}}finally{if(sequence===sessionsRequest){sessionsLoading=false;syncControls();}}
}
async function selectSession(id){if(!historyActive||viewLoading()||id===thread)return;invalidate();thread=id;qqUI.write('qq-history-thread:'+user,id);resetPage('正在读取会话消息…');history$('search').value='';history$('exported').hidden=true;history$('renameForm').hidden=true;renderSessions();await loadPage();}
async function selectAccount(id){
  if(!historyActive)return;const lifecycle=historyLifecycleEpoch;
  if(viewLoading()||id===user)return;invalidate();accountLoading=true;user=id;taskView.reset(id);qqUI.write('qq-history-user',id);thread='';sessions=[];sessionNext=null;sessionSignature='';resetPage('正在读取会话…');history$('search').value='';history$('sessionTitle').textContent='请选择会话';history$('sessions').replaceChildren();history$('moreSessions').hidden=true;history$('rename').hidden=true;history$('renameForm').hidden=true;history$('exported').hidden=true;for(const el of history$('users').children)el.classList.toggle('selected',el.dataset.id===user);syncControls();
  try{await loadSessions();if(lifecycle===historyLifecycleEpoch&&!sessions.length){history$('empty').textContent='暂无会话，QQ 发送新任务后会在这里出现';history$('pageInfo').textContent='0 条消息';}}finally{if(lifecycle===historyLifecycleEpoch){accountLoading=false;syncControls();void taskView.refresh();}}
}
async function loadPage(){
  if(!historyActive||!user||!thread)return;const epoch=invalidate(),controller=request=new AbortController();pageLoading=true;syncControls();
  try{const d=await historyAPI('/api/history?'+new URLSearchParams({user,thread,q:history$('search').value,limit:history$('pageSize').value,...(pageStack.at(-1)?{before:pageStack.at(-1)}:{})}),null,controller.signal);if(epoch!==generation)return;
    pageFailed=false;hasPage=true;next=d.next;watermark=d.watermark;const visible=render(d.records);history$('historyFeed')?.scrollTo?.({top:0,behavior:'instant'});history$('pageInfo').textContent=`第 ${pageStack.length} 页 · 本页 ${visible.displayed} 条 / 共 ${d.total} 条记录${visible.merged?`（合并 ${visible.merged} 条重复结果）`:''}`;
  }catch(e){if(epoch===generation&&e.name!=='AbortError'){pageFailed=true;error(e);}}finally{if(epoch===generation){await afterPaint();if(epoch===generation){pageLoading=false;syncControls();}}}
}
async function poll(force=false){
  if(!historyActive||polling||(!force&&document.hidden))return;polling=true;const sequence=++historyPollSequence,retryPage=pageFailed,retryEpoch=generation;
  try{const d=await historyAPI('/api/history/accounts');history$('state').textContent=`${d.qq} · 附件点击后加载`;
    const sig=JSON.stringify(d.users);if(history$('users').dataset.signature!==sig){history$('users').dataset.signature=sig;history$('users').replaceChildren(...d.users.map(u=>{const b=document.createElement('button');b.className='user'+(u.id===user?' selected':'');b.dataset.id=u.id;b.textContent=u.label;b.onclick=e=>{if(!navigationBlocked(e))void selectAccount(u.id).catch(error);};return b;}));syncControls();if(!user&&d.users.length)await selectAccount((d.users.find(u=>u.id===qqUI.read('qq-history-user'))||d.users[0]).id);}
    if(viewLoading()||sessionsLoading)return;await loadSessions();if(viewLoading())return;if(retryPage&&pageFailed&&retryEpoch===generation&&user&&thread)await loadPage();if(user&&thread&&hasPage&&!pageFailed&&!viewLoading()){const epoch=generation;try{const d=await historyAPI('/api/history/updates?'+new URLSearchParams({user,thread,after:String(watermark)}));if(epoch===generation&&d.count){history$('newMessages').hidden=false;history$('newMessages').textContent=`有 ${d.count} 条新记录 · 查看最新`;}}catch(e){if(epoch===generation)error(e);}}
  }catch(e){error(e);}finally{if(sequence===historyPollSequence)polling=false;}
}
history$('search').oninput=e=>{if(navigationBlocked(e))return;clearTimeout(searchTimer);invalidate();searchTimer=setTimeout(()=>{pageStack=[''];void loadPage();},300);};
history$('pageSize').onchange=e=>{if(navigationBlocked(e))return;pageStack=[''];void loadPage();};history$('older').onclick=e=>{if(navigationBlocked(e))return;if(next){pageStack.push(next);void loadPage();}};history$('newer').onclick=e=>{if(navigationBlocked(e))return;if(pageStack.length>1){pageStack.pop();void loadPage();}};
history$('latest').onclick=history$('newMessages').onclick=e=>{if(navigationBlocked(e))return;pageStack=[''];void loadPage();};history$('moreSessions').onclick=e=>{if(!navigationBlocked(e))void loadSessions(true).catch(error);};
history$('rename').onclick=e=>{if(navigationBlocked(e))return;history$('titleInput').value=sessions.find(s=>s.id===thread)?.title||'';history$('renameForm').hidden=false;history$('titleInput').focus();};history$('cancelRename').onclick=()=>{history$('renameForm').hidden=true;};
history$('renameForm').onsubmit=async e=>{e.preventDefault();if(navigationBlocked(e))return;const account=user,id=thread;try{const d=await historyAPI('/api/history/title',{user:account,thread:id,title:history$('titleInput').value});if(account===user&&id===thread){const s=sessions.find(x=>x.id===id);if(s)s.title=d.title;renderSessions();history$('renameForm').hidden=true;}}catch(e){if(account===user&&id===thread)error(e);}};
history$('export').onclick=async()=>{if(!historyActive||!user||!thread||viewLoading()||exporting)return;const account=user,id=thread;exporting=true;syncControls();try{const d=await historyAPI('/api/export',{user:account,thread:id});if(account===user&&id===thread){history$('exported').textContent=`已导出本会话 ${d.count} 条记录：${d.file}`;history$('exported').hidden=false;}}catch(e){if(account===user&&id===thread)error(e);}finally{exporting=false;syncControls();}};
for(const id of ['users','sessions'])for(const type of ['pointerdown','click','keydown'])history$(id).addEventListener(type,e=>{if((type!=='keydown'||e.key==='Enter'||e.key===' ')&&navigationBlocked(e)){e.preventDefault();e.stopImmediatePropagation();}},true);
function setHistoryVisible(visible){
  visible=Boolean(visible);if(visible===historyActive)return;historyActive=visible;historyLifecycleEpoch++;
  if(!visible){
    for(const controller of historyReads)controller.abort();historyReads.clear();
    historyPollSequence++;polling=false;invalidate();sessionsRequest++;pageLoading=accountLoading=sessionsLoading=false;
    pageFailed=Boolean(thread);taskView.pause();syncControls();
  }else{void poll(true);void taskView.refresh();}
}
globalThis.qqHistory={setVisible:setHistoryVisible};
syncControls();window.addEventListener('pagehide',()=>{disposeAssets();taskView.pause();});document.addEventListener('qq-ui-retry',()=>{void poll(true);void taskView.refresh();});document.addEventListener('visibilitychange',()=>{if(!document.hidden){void poll(true);void taskView.refresh();}});if(historyActive)void poll(true);setInterval(poll,10000);setInterval(()=>void taskView.refresh(),10000);
