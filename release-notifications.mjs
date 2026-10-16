import fs from 'node:fs';
import path from 'node:path';

const STATUSES=new Set(['attempted','sent','failed','unknown']);
const time=()=>new Date().toISOString();
const errorDetails=err=>({message:String(err?.message||err||'未知发送错误'),...(err?.code!=null?{code:String(err.code)}:{}),...(Number.isFinite(Number(err?.status))?{httpStatus:Number(err.status)}:{})});
function definiteFailure(err) {
  if(typeof err?.definite==='boolean')return err.definite;
  const status=Number(err?.status),code=Number(err?.code);
  if(status>=400&&status<500)return true;
  return (!Number.isFinite(status)||(status>=200&&status<300))&&Number.isFinite(code)&&code!==0;
}
function platformId(response) {
  const value=response?.platformMessageId??response?.id??response?.message_id??response?.data?.id??response?.data?.message_id;
  return typeof value==='string'&&value.trim()?value:typeof value==='number'&&Number.isFinite(value)?String(value):null;
}

/** Durable, at-most-once release notices for currently paired private recipients. */
export class ReleaseNotifications {
  constructor({file,users,send,record=async()=>{},enabled=true}={}) {
    if(typeof file!=='string'||!file||typeof users!=='function'||typeof send!=='function'||typeof record!=='function')throw new TypeError('ReleaseNotifications requires file, users, send and record');
    this.file=path.resolve(file);this.users=users;this.send=send;this.record=record;this.enabled=enabled;this.queues=new Map();this.dirty=false;
    this.data=fs.existsSync(this.file)?JSON.parse(fs.readFileSync(this.file,'utf8')):{version:1,releases:[]};
    this.validateState();
  }
  validateState() {
    if(this.data?.version!==1||!Array.isArray(this.data.releases))throw new Error('发布通知记录格式无效；为避免重复发送，已停止通知');
    const ids=new Set();
    for(const release of this.data.releases){
      if(typeof release?.id!=='string'||!release.id||typeof release.text!=='string'||!Array.isArray(release.recipients)||ids.has(release.id))throw new Error('发布通知记录损坏；为避免重复发送，已停止通知');
      ids.add(release.id);const users=new Set();
      for(const entry of release.recipients){
        if(typeof entry?.userId!=='string'||!entry.userId||!STATUSES.has(entry.status)||users.has(entry.userId))throw new Error('发布通知接收记录损坏；为避免重复发送，已停止通知');
        users.add(entry.userId);
      }
    }
  }
  persist() {
    try{
      fs.mkdirSync(path.dirname(this.file),{recursive:true});
      fs.writeFileSync(this.file+'.tmp',JSON.stringify(this.data,null,2),{mode:0o600,flush:true});
      fs.renameSync(this.file+'.tmp',this.file);this.dirty=false;
    }catch(err){this.dirty=true;throw err;}
  }
  busy() {return this.queues.size>0;}
  async broadcast({id,text}={}) {
    if(!this.enabled)throw new Error('发布通知已禁用，未发送任何消息');
    if(typeof id!=='string'||!id.trim()||typeof text!=='string'||!text.trim())throw new TypeError('发布通知需要稳定的非空 id 和 text');
    const previous=this.queues.get(id)||Promise.resolve();
    const next=previous.catch(()=>{}).then(()=>this.run(id,text));this.queues.set(id,next);
    try{return await next;}finally{if(this.queues.get(id)===next)this.queues.delete(id);}
  }
  async run(id,text) {
    if(!this.enabled)throw new Error('发布通知已禁用，未发送任何消息');
    let release=this.data.releases.find(item=>item.id===id);
    if(release&&release.text!==text)throw new Error('此发布 id 已用于不同的通知内容，未发送任何消息');
    const configured=this.users();
    if(!Array.isArray(configured))throw new TypeError('发布通知账号列表无效');
    const recipients=new Map();
    for(const user of configured){
      if(typeof user?.id!=='string'||!user.id)throw new TypeError('发布通知账号标识无效');
      if(!recipients.has(user.id))recipients.set(user.id,user);
    }
    const counts={recipients:recipients.size,attempted:0,sent:0,failed:0,unknown:0,skipped:0,storageErrors:0,recordErrors:0};
    if(!release){
      release={id,text,createdAt:time(),recipients:[]};this.data.releases.push(release);
      try{this.persist();}catch(err){this.data.releases.splice(this.data.releases.indexOf(release),1);throw this.storageError(err,counts);}
    }else if(this.dirty){try{this.persist();}catch(err){throw this.storageError(err,counts);}}
    for(const user of recipients.values()){
      if(!this.enabled)throw new Error('发布通知已禁用，已停止后续发送');
      // Configuration may change while a previous recipient's network call is pending.
      if(!this.users().some(current=>current.id===user.id)){counts.skipped++;continue;}
      if(release.recipients.some(entry=>entry.userId===user.id)){counts.skipped++;continue;}
      const entry={userId:user.id,status:'attempted',attemptedAt:time()};release.recipients.push(entry);
      // Persist the attempt BEFORE send: a crash or lost platform response must not resend.
      try{this.persist();}catch(err){release.recipients.splice(release.recipients.indexOf(entry),1);throw this.storageError(err,counts);}
      counts.attempted++;
      try{
        const response=await this.send(user,text),messageId=platformId(response);
        if(messageId){entry.status='sent';entry.platformMessageId=messageId;}
        else{entry.status='unknown';entry.error={message:'平台响应未包含消息 ID，投递结果待核实',code:'MISSING_MESSAGE_ID'};}
      }catch(err){entry.status=definiteFailure(err)?'failed':'unknown';entry.error=errorDetails(err);}
      entry.completedAt=time();counts[entry.status]++;
      try{this.persist();}catch(err){counts.storageErrors++;entry.storageError=errorDetails(err);}
      const historyEntry={releaseId:id,text,status:entry.status,attemptedAt:entry.attemptedAt,completedAt:entry.completedAt,...(entry.platformMessageId?{platformMessageId:entry.platformMessageId}:{}),...(entry.error?{error:entry.error}:{}),...(entry.storageError?{storageError:entry.storageError}:{})};
      try{await this.record(user,historyEntry);}
      catch(err){
        counts.recordErrors++;entry.recordError=errorDetails(err);
        try{this.persist();}catch{counts.storageErrors++;}
      }
    }
    return counts;
  }
  storageError(err,counts) {
    const failure=new Error('发布通知记录无法安全保存，已停止后续发送',{cause:err});
    failure.code='NOTIFICATION_PERSIST_FAILED';failure.counts={...counts,storageErrors:counts.storageErrors+1};return failure;
  }
}
