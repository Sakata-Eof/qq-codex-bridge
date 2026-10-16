import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { projectRoot, runtimeDir, publicDir, defaultUsersRoot, verificationDir } from './paths.mjs';
import { execFileSync } from 'node:child_process';
import { CodexRPC } from './core/codex.mjs';
import { Accounts } from './core/accounts.mjs';
import { QQ } from './qq/client.mjs';
import { Memory } from './core/memory.mjs';
import { History } from './history/store.mjs';
import { createHistoryRoutes } from './http/history-routes.mjs';
import { syncCommands, syncQuickMenu } from './qq/commands.mjs';
import { authorizeUI, browserCookie } from './http/auth.mjs';
import { ReleaseNotifications } from './ops/release-notifications.mjs';
const dir=projectRoot,runtime=runtimeDir;fs.mkdirSync(runtime,{recursive:true});
const configFile=path.join(runtime,'config.json');
const defaults={appId:'',clientSecret:'',users:[],pairingCodes:[],usersRoot:defaultUsersRoot,sandbox:false,qqProxy:'',codexBinary:'codex',adminToken:crypto.randomBytes(32).toString('hex'),python:'C:\\Users\\32979\\AppData\\Local\\Programs\\Python\\Python310\\python.exe',whisperModel:'C:\\Users\\32979\\.cache\\huggingface\\hub\\models--Systran--faster-whisper-small\\snapshots\\536b0662742c02347bc0e980a01041f333bce120',ffmpeg:'ffmpeg',ffprobe:'ffprobe',bridgeDir:dir};
const config=fs.existsSync(configFile)?{...defaults,...JSON.parse(fs.readFileSync(configFile,'utf8'))}:defaults;
config.rotationTurns ||= 40;config.idleHours ||= 6;
if(!path.isAbsolute(config.codexBinary)||!fs.existsSync(config.codexBinary)){
  const binRoot=path.join(process.env.LOCALAPPDATA,'OpenAI/Codex/bin');
  const candidates=fs.existsSync(binRoot)?fs.readdirSync(binRoot).map(x=>path.join(binRoot,x,'codex.exe')).filter(x=>fs.existsSync(x)).sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs):[];
  if(candidates.length)config.codexBinary=candidates[0];
}
if(fs.existsSync(path.join(runtime,'asr-venv/Scripts/python.exe')))config.python=path.join(runtime,'asr-venv/Scripts/python.exe');
function persist(){fs.writeFileSync(configFile+'.tmp',JSON.stringify(config,null,2),{mode:0o600});fs.renameSync(configFile+'.tmp',configFile);}
persist();
if(process.platform==='win32'){
  const identity=execFileSync('whoami',[],{encoding:'utf8',windowsHide:true}).trim();
  execFileSync('icacls',[runtime,'/inheritance:r','/grant:r',`${identity}:(OI)(CI)F`,'SYSTEM:(OI)(CI)F'],{windowsHide:true,stdio:'ignore'});
}
const logs=[];
function log(text){const line=`${new Date().toISOString()} ${text}`;logs.push(line);if(logs.length>50)logs.shift();fs.appendFileSync(path.join(runtime,'service.log'),line+'\n');console.log(line);}
const qq=new QQ(config,log),history=new History(config,runtime),accounts=new Accounts(config,qq,runtime,persist,log,history);
const releases=new ReleaseNotifications({file:path.join(runtime,'release-notifications.json'),users:()=>config.users,enabled:config.releaseNotificationsEnabled===true,
  send:(user,text)=>qq.sendAnnouncement(user,text),
  record:(user,entry)=>history.record(user.id,{kind:entry.status==='sent'?'outbound':'error',messageId:`release:${entry.releaseId}`,...entry})});
let draining=false;
for(const user of config.users)history.importCodex(user.id);
let commandsState={ok:false,message:'等待 QQ 连接'},commandsFlight;
async function synchronizeCommands(){
  if(commandsFlight)return commandsFlight;
  commandsFlight=(async()=>{try{const panel=await syncCommands(qq),quickMenu=await syncQuickMenu(qq);commandsState={...panel,quickMenu};fs.mkdirSync(verificationDir,{recursive:true});fs.writeFileSync(path.join(verificationDir,'verification-commands.json'),JSON.stringify(commandsState,null,2));log(`QQ 指令面板和快捷菜单已同步并回读验证：${commandsState.count} 项，${commandsState.action}`);return commandsState;}catch(err){commandsState={ok:false,message:err.message,time:new Date().toISOString()};log(`QQ 指令面板同步失败：${err.message}`);throw err;}})();
  try{return await commandsFlight;}finally{commandsFlight=null;}
}
qq.on('ready',()=>{void synchronizeCommands().catch(()=>{});});
qq.on('announcementSent',({format})=>log(`发布通知已使用 ${format==='markdown'?'Markdown':'纯文本'} 格式发送`));
qq.on('sent',({event,text,file,sequence,keyboard,format,renderedText})=>history.record(event.user,{kind:'outbound',messageId:event.id,threadId:event.historyThreadId,text,sequence,file,format,renderedText,buttons:keyboard?.content.rows.flatMap(row=>row.buttons.map(b=>b.render_data.label))}));
const globalMemory=new Memory(path.join(runtime,'global-memory.json'),path.join(runtime,'unused-private-memory.json'));
let codexState='正在检查';
async function checkCodex(){const rpc=new CodexRPC(config.codexBinary);try{await rpc.start();const r=await rpc.call('account/read',{refreshToken:false});codexState=r.account?'已登录；每个 QQ 账号独立启动 Codex 进程':'Codex 尚未登录';log(codexState);}catch(e){codexState=e.message;log(`Codex 检查失败：${e.message}`);}finally{rpc.stop();}}
qq.on('message',e=>{void accounts.handle(e).catch(err=>{log(`指令处理失败：${err.message}`);if(config.users.some(u=>u.id===e.user)){history.record(e.user,{kind:'error',messageId:e.id,threadId:e.historyThreadId,text:err.message});void qq.send(e,`任务处理失败：${err.message}`).catch(()=>{});}});});
const host='127.0.0.1',port=Number(process.env.QQ_CODEX_PORT||17329),base=`http://${host}:${port}`;
const html=fs.readFileSync(path.join(publicDir,'setup.html')),js=fs.readFileSync(path.join(publicDir,'setup.js'));
const historyHTML=fs.readFileSync(path.join(publicDir,'history.html')),historyJS=fs.readFileSync(path.join(publicDir,'history.js'));
const uiClient=fs.readFileSync(path.join(publicDir,'ui-client.js'));
function respond(res,code,data){res.writeHead(code,{'Content-Type':'application/json;charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
async function body(req){let text='';for await(const chunk of req){text+=chunk;if(text.length>8192)throw new Error('请求过长');}return JSON.parse(text||'{}');}
const historyRoutes=createHistoryRoutes({config,accounts,history,qq,base,respond,body});
const server=http.createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  if(req.headers.host!==`${host}:${port}`||(req.headers.origin&&req.headers.origin!==base)){respond(res,403,{error:'仅允许本机访问'});return;}
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Content-Security-Policy',"default-src 'self'; style-src 'unsafe-inline'; img-src 'self' blob:; media-src 'self' blob:; frame-ancestors 'none'; form-action 'self'");
  if(req.method==='GET'&&req.url==='/'){res.setHeader('Content-Type','text/html;charset=utf-8');res.end(html);return;}
  if(req.method==='GET'&&req.url==='/setup.js'){res.setHeader('Content-Type','text/javascript;charset=utf-8');res.end(js);return;}
  if(req.method==='GET'&&req.url==='/history'){res.setHeader('Content-Type','text/html;charset=utf-8');res.end(historyHTML);return;}
  if(req.method==='GET'&&req.url==='/history.js'){res.setHeader('Content-Type','text/javascript;charset=utf-8');res.end(historyJS);return;}
  if(req.method==='GET'&&req.url==='/ui-client.js'){res.setHeader('Content-Type','text/javascript;charset=utf-8');res.end(uiClient);return;}
  if(req.method==='GET'&&req.url==='/health'){respond(res,200,{ok:true});return;}
  if(!authorizeUI(req,config.adminToken,base)){respond(res,403,{error:'本机页面未登录或登录已失效，请运行 Start.ps1 重新验证'});return;}
  try{
    if(req.url==='/api/session'&&['GET','POST'].includes(req.method)){if(req.method==='POST')res.setHeader('Set-Cookie',browserCookie(config.adminToken));respond(res,200,{ok:true});return;}
    if(req.method==='POST'&&req.url==='/api/releases'){
      if(draining)throw new Error('服务正在停机，未发送通知');
      const input=await body(req);if(!/^[a-zA-Z0-9._-]{1,80}$/.test(input.id||'')||typeof input.text!=='string'||!input.text.trim()||input.text.length>1400)throw new Error('通知需要稳定版本 id 和 1–1400 字的正文');
      const counts=await releases.broadcast(input);log(`发布通知完成：发送 ${counts.sent}，失败 ${counts.failed}，待核实 ${counts.unknown}，已跳过 ${counts.skipped}`);respond(res,200,{ok:true,...counts});return;
    }
    if(req.method==='GET'&&req.url.startsWith('/api/models?')){
      const user=config.users.find(x=>x.id===new URL(req.url,base).searchParams.get('user'));if(!user)throw new Error('账号不存在');const x=await accounts.get(user);respond(res,200,{current:x.models.current(),models:await x.models.list(true)});return;
    }
    if(req.method==='POST'&&req.url==='/api/model'){
      const input=await body(req),user=config.users.find(x=>x.id===input.user);if(!user)throw new Error('账号不存在');const x=await accounts.get(user);respond(res,200,{ok:true,current:await x.models.change(input.model,input.effort)});return;
    }
    if(req.method==='POST'&&req.url==='/api/commands/sync'){respond(res,200,await synchronizeCommands());return;}
    if(await historyRoutes(req,res))return;
    if(req.method==='GET'&&req.url==='/api/status'){
      respond(res,200,{appId:config.appId,secretConfigured:Boolean(config.clientSecret),pairingCodes:config.pairingCodes.filter(p=>p.expires>Date.now()).map(p=>({label:p.label,command:`/pair ${p.pin}`})),sandbox:config.sandbox,qq:qq.state,codex:codexState,commands:commandsState,logs,users:accounts.status(),globalMemory:globalMemory.read(globalMemory.globalFile).map(x=>x.text).join('\n'),rotationTurns:config.rotationTurns,idleHours:config.idleHours,multimodal:'图片直接输入；语音 QQ ASR 或本地 whisper；视频抽样画面与音轨；文件读取与富媒体返回'});return;
    }
    if(req.method==='POST'&&req.url==='/api/config'){
      if(accounts.busy()||releases.busy())throw new Error('任务执行或发布通知中，暂不能更改配置');
      const input=await body(req);
      if(!/^\d+$/.test(input.appId||'')||input.appId==='1903912458')throw new Error('请填写新机器人的 AppID，勿使用 Hermes 现有 AppID');
      if(config.appId&&input.appId!==config.appId&&config.users.length)throw new Error('已有账号绑定，切换 AppID 前需要重建绑定配置');
      if(!input.clientSecret&&!config.clientSecret)throw new Error('需要 AppSecret／ClientSecret');
      await qq.stop();config.appId=input.appId;if(input.clientSecret)config.clientSecret=input.clientSecret;config.sandbox=Boolean(input.sandbox);persist();
      qq.access=null;qq.expires=0;qq.session=null;qq.seq=null;qq.counts.clear();qq.start();respond(res,200,{ok:true});return;
    }
    if(req.method==='POST'&&req.url==='/api/pair'){
      const input=await body(req);if(!config.appId)throw new Error('请先保存机器人凭据');
      config.pairingCodes=config.pairingCodes.filter(p=>p.expires>Date.now());if(config.pairingCodes.length>=20)throw new Error('有效配对码过多');
      config.pairingCodes.push({label:String(input.label||'QQ 账号').slice(0,50),pin:crypto.randomBytes(12).toString('hex'),expires:Date.now()+3600000});persist();respond(res,200,{ok:true});return;
    }
    if(req.method==='POST'&&req.url==='/api/memory'){
      const input=await body(req);if(String(input.text||'').length>4000)throw new Error('全局记忆最多 4000 字符');globalMemory.write(globalMemory.globalFile,input.text?[{id:'global',text:input.text}]:[]);respond(res,200,{ok:true});return;
    }
    if(req.method==='POST'&&req.url==='/api/lifecycle'){
      if(accounts.busy())throw new Error('任务执行中，暂不能调整会话策略');const input=await body(req);
      if(!Number.isInteger(input.rotationTurns)||input.rotationTurns<5||input.rotationTurns>200||input.idleHours<1||input.idleHours>72)throw new Error('轮数范围 5–200，空闲时间范围 1–72 小时');
      config.rotationTurns=input.rotationTurns;config.idleHours=Number(input.idleHours);persist();for(const x of accounts.instances.values()){x.bridge.config.rotationTurns=config.rotationTurns;x.bridge.config.idleHours=config.idleHours;}respond(res,200,{ok:true});return;
    }
    if(req.method==='POST'&&req.url==='/api/shutdown'){if(accounts.busy()||history.exportsActive||releases.busy())throw new Error('任务执行、历史导出或发布通知中，暂不能停止服务');draining=true;respond(res,200,{ok:true});setTimeout(()=>void close(),100);return;}
    if(req.method==='POST'&&req.url==='/api/reconnect'){if(accounts.busy())throw new Error('任务执行中，不能重新连接');accounts.stop();accounts.instances.clear();await checkCodex();respond(res,200,{ok:true});return;}
    if(req.method==='POST'&&req.url==='/api/user'){
      const input=await body(req),user=config.users.find(x=>x.id===input.id);if(!user)throw new Error('账号不存在');if(accounts.busy())throw new Error('任务执行中不能更改目录');
      const workspace=fs.realpathSync(input.workspace);if(!path.isAbsolute(workspace)||!fs.statSync(workspace).isDirectory())throw new Error('需要现有目录的绝对路径');
      for(const other of config.users.filter(x=>x!==user)){for(const root of other.allowedRoots){const rel=path.relative(root,workspace),inverse=path.relative(workspace,root);if(rel===''||(!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel))||(!inverse.startsWith('..'+path.sep)&&inverse!=='..'&&!path.isAbsolute(inverse)))throw new Error('该目录与其他账号目录重叠，无法分配');}}
      user.workspace=workspace;user.allowedRoots=[workspace];persist();accounts.instances.get(user.id)?.rpc.stop();accounts.instances.delete(user.id);respond(res,200,{ok:true});return;
    }
    respond(res,404,{error:'未找到接口'});
  }catch(e){respond(res,400,{error:e.message});}
});
server.listen(port,host,()=>{fs.writeFileSync(path.join(runtime,'setup-url.txt'),`${base}/#${config.adminToken}`,{mode:0o600});fs.writeFileSync(path.join(runtime,'pid.txt'),String(process.pid));log(`本机配置服务 ${base}`);});
await checkCodex();qq.start();
let closing=false;
async function close(){if(closing)return;closing=true;await qq.stop();accounts.stop();history.close();server.close(()=>process.exit(0));server.closeAllConnections();setTimeout(()=>process.exit(0),2000).unref();}
process.on('SIGINT',close);process.on('SIGTERM',close);
