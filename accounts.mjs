import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { CodexRPC } from './codex.mjs';
import { Bridge } from './bridge.mjs';
import { Media } from './media.mjs';
import { Memory } from './memory.mjs';
import { Models } from './models.mjs';
import { MessageBatches } from './message-batches.mjs';
export class Accounts {
  constructor(config,qq,runtime,persist,log,history=null){this.config=config;this.qq=qq;this.runtime=runtime;this.persist=persist;this.log=log;this.history=history;this.instances=new Map();this.starting=new Map();}
  userKey(id){return crypto.createHash('sha256').update(this.config.appId+':'+id).digest('hex').slice(0,24);}
  async get(user){
    if(this.instances.has(user.id)){const existing=this.instances.get(user.id);if(existing.rpc.child?.exitCode===null&&!existing.rpc.child.killed)return existing;this.instances.delete(user.id);}
    if(this.starting.has(user.id))return this.starting.get(user.id);
    const promise=(async()=>{
      const stateDir=path.join(this.runtime,'users',this.userKey(user.id));fs.mkdirSync(stateDir,{recursive:true});
      const home=path.join(stateDir,'codex-home');fs.mkdirSync(home,{recursive:true});
      const original=process.env.CODEX_HOME||path.join(os.homedir(),'.codex');
      for(const file of ['auth.json','config.toml','AGENTS.md']){const source=path.join(original,file),target=path.join(home,file);if(fs.existsSync(source)&&(!fs.existsSync(target)||file==='auth.json'))fs.copyFileSync(source,target);}
      // Migrate only this account's already-recorded thread, never other desktop or QQ histories.
      const sessionFile=path.join(stateDir,'sessions.json'),legacy=path.join(original,'sessions');
      if(fs.existsSync(sessionFile)&&fs.existsSync(legacy)){
        const ids=Object.values(JSON.parse(fs.readFileSync(sessionFile,'utf8'))).map(s=>s.threadId).filter(Boolean);
        for(const relative of fs.readdirSync(legacy,{recursive:true})){if(!ids.some(id=>relative.endsWith(id+'.jsonl')))continue;const target=path.join(home,'sessions',relative);if(!fs.existsSync(target)){fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(path.join(legacy,relative),target);}}
      }
      const rpc=new CodexRPC(this.config.codexBinary,{CODEX_HOME:home});await rpc.start();
      const userConfig={...this.config,ownerOpenId:user.id,codexHome:home,workspace:user.workspace,allowedRoots:user.allowedRoots,allowedGroups:user.allowedGroups||[]};
      this.history?.importCodex(user.id);
      const media=new Media(this.config,this.qq);media.onMedia=(e,files,text)=>this.history?.record(user.id,{kind:'assets',messageId:e.id,threadId:e.historyThreadId,files,text});
      const bridge=new Bridge(userConfig,rpc,(e,text,buttons)=>buttons?.length?this.qq.sendButtons(e,text,buttons):this.qq.send(e,text),this.persist,path.join(stateDir,'sessions.json'),this.log,media,new Memory(path.join(this.runtime,'global-memory.json'),path.join(stateDir,'private-memory.json')));
      const batches=new MessageBatches({delayMs:this.config.messageMergeMs??3000,maxWaitMs:10000,handle:e=>bridge.handle(e),onError:async(e,err)=>{
        this.log(`消息处理失败：${err.message}`);
        this.history?.record(user.id,{kind:'error',messageId:e.id,threadId:e.historyThreadId,text:err.message});
        await bridge.say(e,`消息处理失败：${err.message}`);
      }});
      bridge.pendingFor=e=>batches.pendingFor(e);bridge.cancelPending=e=>batches.cancel(e);
      rpc.on('offline',()=>batches.cancelAll());
      bridge.onResult=(e,result)=>this.history?.record(user.id,{kind:result.status==='failed'?'error':'result',messageId:e.id,...result});
      const models=new Models(rpc,user,this.persist,()=>batches.busy()||bridge.inputTasks>0||bridge.mediaTransfers>0||[...bridge.sessions.values()].some(s=>s.active||s.busy||s.delivering));
      try{await models.init();}catch(err){rpc.stop();throw err;}bridge.models=models;
      bridge.onSession=(e,s)=>{for(const source of e.sourceEvents||[e]){source.historyThreadId=s.threadId;this.history?.bindMessage(user.id,source.id,s.threadId,e.text.replace(/^\/codex\s+/,'')||e.attachments?.[0]?.filename||'多模态对话');}};
      const seenFile=path.join(stateDir,'seen.json');if(fs.existsSync(seenFile))bridge.seen=new Map(JSON.parse(fs.readFileSync(seenFile,'utf8')));
      bridge.persistSeen=seen=>{fs.writeFileSync(seenFile+'.tmp',JSON.stringify([...seen]),{mode:0o600});fs.renameSync(seenFile+'.tmp',seenFile);};
      const instance={rpc,bridge,user,models,batches};this.instances.set(user.id,instance);return instance;
    })();
    this.starting.set(user.id,promise);try{return await promise;}finally{this.starting.delete(user.id);}
  }
  async handle(e){
    let user=this.config.users.find(u=>u.id===e.user);
    if(!user){
      if(e.group||!e.text.startsWith('/pair '))return;
      const pin=e.text.slice(6).trim();
      const code=this.config.pairingCodes.find(p=>{const a=Buffer.from(pin),b=Buffer.from(p.pin);return p.expires>Date.now()&&a.length===b.length&&crypto.timingSafeEqual(a,b);});
      if(!code)return;if(this.config.users.length>=20)throw new Error('授权账号上限为 20');
      const workspace=path.join(this.config.usersRoot,this.userKey(e.user));fs.mkdirSync(workspace,{recursive:true});
      user={id:e.user,label:code.label,workspace,allowedRoots:[workspace],allowedGroups:[]};this.config.users.push(user);this.config.pairingCodes=this.config.pairingCodes.filter(p=>p!==code);this.persist();
      await this.qq.send(e,'已绑定独立账号。直接发送文字、图片、语音、视频或文件即可使用。/help 查看指令。');return;
    }
    if(e.group&&!(user.allowedGroups||[]).includes(e.chat))return;
    if(this.history&&!this.history.hasInbound(user.id,e.id))this.history.record(user.id,{kind:'inbound',messageId:e.id,text:e.text,chat:e.chat,group:e.group,attachments:(e.attachments||[]).map(a=>({filename:a.filename||'',type:a.content_type||'',size:a.size||0,host:a.url?new URL(a.url.startsWith('//')?'https:'+a.url:a.url).hostname:''}))});
    const {bridge,batches}=await this.get(user);e.historyThreadId=bridge.sessions.get(bridge.key(e))?.threadId;
    if(e.historyThreadId)this.history?.bindMessage(user.id,e.id,e.historyThreadId);
    if(bridge.seen.has(e.id))return;
    if(batches&&(!e.text.startsWith('/')||e.text.startsWith('/codex ')))await batches.push(e);
    else await bridge.handle(e);
  }
  busy(){return this.starting.size>0||[...this.instances.values()].some(x=>x.batches?.busy()||x.models?.changing||x.bridge.inputTasks>0||x.bridge.mediaTransfers>0||[...x.bridge.sessions.values()].some(s=>s.active||s.busy||s.delivering));}
  status(){return this.config.users.map(user=>{const instance=this.instances.get(user.id);return {id:user.id,label:user.label,workspace:user.workspace,model:instance?.models.current()||{model:user.model||null,effort:user.reasoningEffort||null,inherited:!user.model},process:instance?.rpc.child?.pid||null,sessions:instance?[...instance.bridge.sessions.values()].map(s=>({cwd:s.cwd,threadId:s.threadId,status:s.status,last:s.last,model:s.model,effort:s.effort})):[]};});}
  stop(){for(const x of this.instances.values()){x.batches?.cancelAll();x.rpc.stop();}}
}
