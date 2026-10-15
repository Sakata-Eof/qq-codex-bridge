const qqUI=(()=>{
  let token=location.hash.slice(1),authenticated=false,authFlight=null;
  try{token ||= sessionStorage.getItem('qq-codex-admin-token')||'';}catch{}
  history.replaceState(null,'',location.pathname);
  const banner=document.createElement('div');banner.id='connectionNotice';banner.hidden=true;banner.setAttribute('role','status');banner.style.cssText='grid-column:1 / -1;padding:14px;margin:12px;border:1px solid #c39067;background:#fff5e9;border-radius:8px;color:#513b28';
  const message=document.createElement('span'),retry=document.createElement('button');retry.textContent='重试连接';retry.style.margin='0 0 0 12px';banner.append(message,retry);(document.querySelector('main')||document.body).prepend(banner);
  const authMessage='本机页面尚未登录或登录已失效。请按 Win 搜索“Codex QQ 控制台”打开并验证；验证后，新标签页和历史页可直接打开。';
  function show(e){banner.hidden=false;message.textContent=e.auth?authMessage:e.message;}
  async function raw(url,body,signal,timeout=10000,authToken='',blob=false){
    const controller=new AbortController(),cancel=()=>controller.abort();if(signal?.aborted)cancel();else signal?.addEventListener('abort',cancel,{once:true});
    let timedOut=false;const timer=setTimeout(()=>{timedOut=true;controller.abort();},timeout);
    try{const r=await fetch(url,{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',headers:{...(authToken?{Authorization:'Bearer '+authToken}:{}),...(body?{'Content-Type':'application/json'}:{})},signal:controller.signal,...(body?{body:JSON.stringify(body)}:{})});
      if(r.status===403){const e=new Error(authMessage);e.auth=true;throw e;}
      if(blob){if(!r.ok)throw new Error(`附件读取失败：HTTP ${r.status}`);return await r.blob();}const data=await r.json();if(!r.ok)throw new Error(data.error||`HTTP ${r.status}`);return data;
    }catch(e){if(timedOut)throw new Error(body?'操作请求超时，结果尚未确认，请先查看状态，勿重复提交。':'读取超时，将自动重试；已加载的数据仍保留。');if(e.name==='TypeError')throw new Error('无法连接本机服务，将自动重试；请确认服务已启动。');throw e;}finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);}
  }
  async function ensureAuth(){
    if(authenticated)return;if(authFlight)return authFlight;
    authFlight=(async()=>{if(token){try{await raw('/api/session',{},null,10000,token);authenticated=true;token='';try{sessionStorage.removeItem('qq-codex-admin-token');}catch{}return;}catch(e){if(!e.auth)throw e;token='';try{sessionStorage.removeItem('qq-codex-admin-token');}catch{}}}await raw('/api/session');authenticated=true;})();
    try{await authFlight;}finally{authFlight=null;}
  }
  async function request(url,body,signal,timeout,blob=false){
    try{await ensureAuth();const d=await raw(url,body,signal,timeout,'',blob);banner.hidden=true;return d;}catch(e){if(e.auth)authenticated=false;if(e.name!=='AbortError')show(e);throw e;}
  }
  retry.onclick=()=>{document.dispatchEvent(new Event('qq-ui-retry'));};
  window.addEventListener('error',()=>show(new Error('页面脚本出错，请刷新页面重试；若仍失败，请查看本机服务记录。')));
  window.addEventListener('unhandledrejection',e=>{if(e.reason?.name!=='AbortError')show(e.reason instanceof Error?e.reason:new Error('页面请求异常，请重试。'));});
  return {request,show,asset:(url,signal)=>request(url,null,signal,60000,true),read:key=>{try{return sessionStorage.getItem(key);}catch{return null;}},write:(key,value)=>{try{sessionStorage.setItem(key,value);}catch{}}};
})();
