const $=id=>document.getElementById(id);
const api=(url,body)=>qqUI.request(url,body,null,url.startsWith('/api/models?')||body?60000:10000);
let initial=true,refreshing=false,hasData=false,refreshError='';
async function refresh(){if(refreshing)return;refreshing=true;try{
  const s=await api('/api/status');if(initial){$('appId').value=s.appId;$('sandbox').checked=s.sandbox;$('globalMemory').value=s.globalMemory||'';$('rotationTurns').value=s.rotationTurns||40;$('idleHours').value=s.idleHours||6;initial=false;}
  hasData=true;if(refreshError&&$('notice').textContent===refreshError)$('notice').textContent='';refreshError='';$('connectionState').textContent='页面已连接 · '+new Date().toLocaleTimeString('zh-CN');$('status').textContent=`QQ：${s.qq}\nCodex：${s.codex}\n授权账号：${s.users.length}\n${s.multimodal}`;
  $('commands').textContent=s.commands?.ok?`已同步 ${s.commands.count} 个指令${s.commands.quickMenu?.ok?'，底部菜单：'+s.commands.quickMenu.groups.join('、'):''}；保留 ${s.commands.preservedPanels} 个其他面板；最近核对 ${new Date(s.commands.time).toLocaleString('zh-CN')}`:(s.commands?.message||'等待同步…');
  $('pair').replaceChildren(...s.pairingCodes.map(p=>{const pre=document.createElement('pre');pre.textContent=`${p.label}\n${p.command}`;return pre;}));
  $('logs').textContent=s.logs.join('\n');
  const signatures=s.users.map(u=>u.id+u.workspace).join('|');
  if($('results').dataset.signature!==signatures){$('results').dataset.signature=signatures;$('results').replaceChildren(...s.users.map(u=>{
    const div=document.createElement('div');div.className='result';const title=document.createElement('h3');title.textContent=u.label;
    const input=document.createElement('input');input.value=u.workspace;const button=document.createElement('button');button.textContent='分配该账号的项目目录';button.onclick=async()=>{try{await api('/api/user',{id:u.id,workspace:input.value});await refresh();}catch(e){$('notice').textContent=e.message;}};
    const pre=document.createElement('pre');pre.id='user-'+u.id;
    const modelLine=document.createElement('p');modelLine.id='model-'+u.id;
    const loadModels=document.createElement('button');loadModels.textContent='查看／切换此账号模型';
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
}catch(e){$('connectionState').textContent=e.auth?'页面未登录，无法读取数据':'页面连接中断，正在重试';if(!hasData){$('status').textContent=e.auth?'未登录，请从本机启动脚本验证后查看':'读取失败，正在重试';$('commands').textContent='暂未获取指令状态';}refreshError=e.message;$('notice').textContent=e.message;}finally{refreshing=false;}}
$('form').onsubmit=async e=>{e.preventDefault();try{await api('/api/config',{appId:$('appId').value.trim(),clientSecret:$('clientSecret').value.trim(),sandbox:$('sandbox').checked});$('clientSecret').value='';$('notice').textContent='已保存，正在连接 QQ。';await refresh();}catch(e){$('notice').textContent=e.message;}};
$('reconnect').onclick=async()=>{try{await api('/api/reconnect',{});await refresh();}catch(e){$('notice').textContent=e.message;}};
$('pairButton').onclick=async()=>{try{await api('/api/pair',{label:$('userLabel').value});await refresh();}catch(e){$('notice').textContent=e.message;}};
$('saveMemory').onclick=async()=>{try{await api('/api/memory',{text:$('globalMemory').value});$('notice').textContent='全局记忆已保存，下次任务起加载。';}catch(e){$('notice').textContent=e.message;}};
$('saveLifecycle').onclick=async()=>{try{await api('/api/lifecycle',{rotationTurns:Number($('rotationTurns').value),idleHours:Number($('idleHours').value)});$('notice').textContent='会话策略已保存。';}catch(e){$('notice').textContent=e.message;}};
$('syncCommands').onclick=async()=>{const b=$('syncCommands');b.disabled=true;try{const s=await api('/api/commands/sync',{});$('notice').textContent=`QQ 已回读核对 ${s.count} 个指令。`;await refresh();}catch(e){$('notice').textContent=e.message;}finally{b.disabled=false;}};
document.addEventListener('qq-ui-retry',()=>void refresh());document.addEventListener('visibilitychange',()=>{if(!document.hidden)void refresh();});void refresh();setInterval(()=>{if(!document.hidden)void refresh();},5000);
