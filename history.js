const $=id=>document.getElementById(id);
let user='',thread='',sessions=[],sessionNext=null,pageStack=[''],next=null,watermark=0,generation=0,request=null,polling=false,searchTimer,assets=new Map(),sessionSignature='';
const api=(url,body,signal)=>qqUI.request(url,body,signal,body?60000:10000);
let pageFailed=false,hasPage=false;
function disposeAssets(){for(const asset of assets.values()){asset.controller.abort();if(asset.url)URL.revokeObjectURL(asset.url);}assets.clear();}
function invalidate(){generation++;request?.abort();disposeAssets();$('newMessages').hidden=true;return generation;}
function error(e){if(e.name!=='AbortError'){$('state').textContent=e.auth?'页面未登录，无法读取历史':`读取失败，稍后会重试：${e.message}`;if(!hasPage){$('empty').hidden=false;$('empty').textContent=e.auth?'请先从本机启动脚本验证登录':'消息尚未加载成功，正在重试';$('pageInfo').textContent='未读取到消息数量';}}}
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
  $('messages').replaceChildren();$('empty').hidden=records.length>0;$('empty').textContent=thread?($('search').value?'没有匹配的消息':'这个会话暂无消息'):'请选择会话';
  if(!records.length&&merged)$('empty').textContent='本页的重复结果已合并到对应的发送消息，可翻页查看。';
  const labels={inbound:'收到',outbound:'发送',error:'错误',assets:'附件',result:'任务结果'};
  const nodes=records.map(r=>{const div=document.createElement('article');div.className='message '+r.kind;const meta=document.createElement('div');meta.className='meta';meta.textContent=`${r.taskResult?'发送 · 任务结果':labels[r.kind]||r.kind} · ${new Date(r.time).toLocaleString('zh-CN')}`;if(r.text)meta.append(copyButton(r.text));const text=document.createElement('div');text.className='text';text.textContent=r.text||'';div.append(meta);
    if(r.kind==='result'&&r.partialDelivery){const detail=document.createElement('details'),summary=document.createElement('summary');summary.textContent='查看完整任务结果（发送内容已在列表中）';detail.append(summary,text);div.append(detail);}else div.append(text);
    if(r.kind==='result'&&!r.partialDelivery){const info=document.createElement('div');info.className='status';info.textContent='Codex 已保存结果；尚未找到内容一致的 QQ 发送记录。';div.append(info);}
    if(r.buttons?.length){const info=document.createElement('div');info.className='status';info.textContent='按钮：'+r.buttons.join(' · ');div.append(info);}
    if(r.attachments?.length){const info=document.createElement('div');info.className='status';info.textContent=r.attachments.map(a=>`${a.filename||a.type}${a.size?' · '+Math.round(a.size/1024)+' KB':''}`).join('；');div.append(info);}
    for(const f of r.files||[])preview(f,div,user);if(r.file)preview(r.file,div,user);return div;});$('messages').append(...nodes);return {displayed:records.length,merged};
}
function renderSessions(){
  const sig=JSON.stringify(sessions.map(s=>({id:s.id,title:s.title,count:s.count})))+'|'+thread;if(sig===sessionSignature)return;sessionSignature=sig;
  $('sessions').replaceChildren(...sessions.map(s=>{const b=document.createElement('button');b.className='session'+(s.id===thread?' selected':'');const title=document.createElement('span'),meta=document.createElement('small');title.textContent=s.title;meta.textContent=`${s.count} 条 · ${new Date(s.lastAt).toLocaleDateString('zh-CN')}`;b.append(title,meta);b.onclick=()=>void selectSession(s.id).catch(error);return b;}));
  $('moreSessions').hidden=!sessionNext;const active=sessions.find(s=>s.id===thread);$('sessionTitle').textContent=active?.title||'请选择会话';$('rename').hidden=!active||thread==='__unassigned__';
}
async function loadSessions(older=false){
  if(!user)return;const account=user,epoch=generation;
  try{const d=await api('/api/history/sessions?'+new URLSearchParams({user:account,limit:'30',...(older&&sessionNext?{before:sessionNext}:{})}));if(account!==user||epoch!==generation)return;
    if(older){sessions=[...sessions,...d.sessions];sessionNext=d.next;}else{const olderSessions=sessions.filter(s=>!d.sessions.some(x=>x.id===s.id));sessions=[...d.sessions,...olderSessions];if(!olderSessions.length)sessionNext=d.next;}
    if(!thread&&sessions.length){thread=(sessions.find(s=>s.id===qqUI.read('qq-history-thread:'+user))||sessions.find(s=>s.id!=='__unassigned__')||sessions[0]).id;qqUI.write('qq-history-thread:'+user,thread);renderSessions();await loadPage();}else renderSessions();
  }catch(e){error(e);throw e;}
}
async function selectSession(id){invalidate();hasPage=false;pageFailed=false;thread=id;qqUI.write('qq-history-thread:'+user,id);pageStack=[''];next=null;watermark=0;$('search').value='';$('exported').hidden=true;$('renameForm').hidden=true;renderSessions();await loadPage();}
async function selectAccount(id){invalidate();hasPage=false;pageFailed=false;user=id;qqUI.write('qq-history-user',id);thread='';sessions=[];sessionNext=null;pageStack=[''];next=null;watermark=0;sessionSignature='';$('search').value='';$('messages').replaceChildren();$('empty').hidden=false;$('empty').textContent='正在读取会话…';$('sessionTitle').textContent='请选择会话';$('sessions').replaceChildren();$('renameForm').hidden=true;$('exported').hidden=true;for(const el of $('users').children)el.classList.toggle('selected',el.dataset.id===user);await loadSessions();if(!sessions.length){$('empty').textContent='暂无会话，QQ 发送新任务后会在这里出现';$('pageInfo').textContent='0 条消息';$('newer').disabled=true;$('older').disabled=true;$('rename').hidden=true;}}
async function loadPage(){
  if(!user||!thread)return;const epoch=invalidate(),controller=request=new AbortController();$('older').disabled=true;$('newer').disabled=true;$('loading').hidden=false;
  try{const d=await api('/api/history?'+new URLSearchParams({user,thread,q:$('search').value,limit:$('pageSize').value,...(pageStack.at(-1)?{before:pageStack.at(-1)}:{})}),null,controller.signal);if(epoch!==generation)return;
    pageFailed=false;hasPage=true;next=d.next;watermark=d.watermark;const visible=render(d.records);$('pageInfo').textContent=`第 ${pageStack.length} 页 · 本页 ${visible.displayed} 条 / 共 ${d.total} 条记录${visible.merged?`（合并 ${visible.merged} 条重复结果）`:''}`;$('newer').disabled=pageStack.length===1;$('older').disabled=!next;
  }catch(e){if(epoch===generation&&e.name!=='AbortError'){pageFailed=true;error(e);}}finally{if(epoch===generation)$('loading').hidden=true;}
}
async function poll(force=false){
  if(polling||(!force&&document.hidden))return;polling=true;const retryPage=pageFailed;
  try{const d=await api('/api/history/accounts');$('state').textContent=`${d.qq} · SQLite · 附件点击后加载`;
    const sig=JSON.stringify(d.users);if($('users').dataset.signature!==sig){$('users').dataset.signature=sig;$('users').replaceChildren(...d.users.map(u=>{const b=document.createElement('button');b.className='user'+(u.id===user?' selected':'');b.dataset.id=u.id;b.textContent=u.label;b.onclick=()=>void selectAccount(u.id).catch(error);return b;}));if(!user&&d.users.length)await selectAccount((d.users.find(u=>u.id===qqUI.read('qq-history-user'))||d.users[0]).id);}
    await loadSessions();if(retryPage&&pageFailed&&user&&thread)await loadPage();if(user&&thread){const epoch=generation,d=await api('/api/history/updates?'+new URLSearchParams({user,thread,after:String(watermark)}));if(epoch===generation&&d.count){$('newMessages').hidden=false;$('newMessages').textContent=`有 ${d.count} 条新记录 · 查看最新`;}}
  }catch(e){error(e);}finally{polling=false;}
}
$('search').oninput=()=>{clearTimeout(searchTimer);invalidate();searchTimer=setTimeout(()=>{pageStack=[''];void loadPage();},300);};
$('pageSize').onchange=()=>{pageStack=[''];void loadPage();};$('older').onclick=()=>{if(next){pageStack.push(next);void loadPage();}};$('newer').onclick=()=>{if(pageStack.length>1){pageStack.pop();void loadPage();}};
$('latest').onclick=$('newMessages').onclick=()=>{pageStack=[''];void loadPage();};$('moreSessions').onclick=()=>void loadSessions(true).catch(error);
$('rename').onclick=()=>{$('titleInput').value=sessions.find(s=>s.id===thread)?.title||'';$('renameForm').hidden=false;$('titleInput').focus();};$('cancelRename').onclick=()=>{$('renameForm').hidden=true;};
$('renameForm').onsubmit=async e=>{e.preventDefault();const account=user,id=thread;try{const d=await api('/api/history/title',{user:account,thread:id,title:$('titleInput').value});if(account===user&&id===thread){const s=sessions.find(x=>x.id===id);if(s)s.title=d.title;renderSessions();$('renameForm').hidden=true;}}catch(e){error(e);}};
$('export').onclick=async()=>{if(!user||!thread)return;const account=user,id=thread;$('export').disabled=true;try{const d=await api('/api/export',{user:account,thread:id});if(account===user&&id===thread){$('exported').textContent=`已导出本会话 ${d.count} 条记录：${d.file}`;$('exported').hidden=false;}}catch(e){error(e);}finally{$('export').disabled=false;}};
window.addEventListener('pagehide',disposeAssets);document.addEventListener('qq-ui-retry',()=>void poll(true));document.addEventListener('visibilitychange',()=>{if(!document.hidden)void poll(true);});void poll(true);setInterval(poll,10000);
