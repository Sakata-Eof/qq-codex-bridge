import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export class MemoryError extends Error {
  constructor(message,status=400){super(message);this.status=status;}
}

const revisionOf=data=>crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
const defaults=()=>({automatic:{enabled:true,reviewEveryTurns:10},forgotten:[]});
export const normalizeMemoryText=text=>text.normalize('NFKC').trim().replace(/\s+/gu,' ').toLowerCase();
const textHash=text=>revisionOf(normalizeMemoryText(text));
export function memoryEntryView(entry){
  const source=entry.source&&typeof entry.source==='object'?Object.fromEntries(['messageId','threadId','turnId','chat'].filter(key=>typeof entry.source[key]==='string').map(key=>[key,entry.source[key]])):{};
  if(typeof entry.source?.group==='boolean')source.group=entry.source.group;
  return {id:entry.id,text:entry.text,...(typeof entry.created==='string'?{created:entry.created}:{}),...(typeof entry.updated==='string'?{updated:entry.updated}:{}),
    ...(entry.origin==='automatic'?{origin:'automatic'}:{}),...(['preference','profile','project','lesson'].includes(entry.category)?{category:entry.category}:{}),
    ...(entry.manualEdited===true?{manualEdited:true}:{}),...(typeof entry.evidence==='string'?{evidence:entry.evidence}:{}),...(Object.keys(source).length?{source}:{})};
}
function memoryText(text){
  if(typeof text!=='string'||!text.trim()||text.length>2000)throw new MemoryError('记忆内容需要为 1–2000 字符');
  return text.trim();
}
function checkCapacity(entries){
  if(entries.length>40||entries.reduce((n,x)=>n+x.text.length,0)>8000)throw new MemoryError('账号记忆已满，请先删除旧条目（QQ 可使用 /forget 编号）');
}

export class Memory {
  constructor(globalFile,privateFile){this.globalFile=globalFile;this.privateFile=privateFile;this.settingsFile=privateFile.replace(/\.json$/,'')+'.settings.json';}
  read(file){return fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):[];}
  write(file,data){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file+'.tmp',JSON.stringify(data,null,2),{mode:0o600});fs.renameSync(file+'.tmp',file);}
  add(text){text=memoryText(text);const entries=this.read(this.privateFile),entry={id:crypto.randomBytes(4).toString('hex'),text,created:new Date().toISOString()};entries.push(entry);checkCapacity(entries);this.write(this.privateFile,entries);return entry;}
  remove(id){const snapshot=this.snapshot();return this.change({revision:snapshot.revision,action:'remove',id});}
  settings(){
    if(!fs.existsSync(this.settingsFile))return defaults();
    const data=JSON.parse(fs.readFileSync(this.settingsFile,'utf8'));
    if(!data||typeof data!=='object'||typeof data.automatic?.enabled!=='boolean'||!Number.isInteger(data.automatic.reviewEveryTurns)||data.automatic.reviewEveryTurns<1||data.automatic.reviewEveryTurns>200||!Array.isArray(data.forgotten)||data.forgotten.some(hash=>typeof hash!=='string'||!/^[a-f0-9]{64}$/.test(hash)))throw new Error('Invalid memory settings');
    return {automatic:{enabled:data.automatic.enabled,reviewEveryTurns:data.automatic.reviewEveryTurns},forgotten:data.forgotten};
  }
  snapshot(){
    const entries=this.read(this.privateFile);
    if(!Array.isArray(entries)||entries.some(entry=>!entry||typeof entry.id!=='string'||typeof entry.text!=='string'))throw new Error('Invalid private memory data');
    const settings=this.settings();
    return {entries,revision:revisionOf({entries,settings}),automatic:settings.automatic};
  }
  current(revision){
    if(typeof revision!=='string'||!/^[a-f0-9]{64}$/.test(revision))throw new MemoryError('请先加载账号记忆，再保存修改');
    const snapshot=this.snapshot();
    if(revision!==snapshot.revision)throw new MemoryError('账号记忆已发生变化，请重新加载后再保存；本次修改尚未写入',409);
    return snapshot;
  }
  change({revision,action,id,text,automatic}){
    if(!['add','update','remove','configure'].includes(action))throw new MemoryError('无效的记忆操作');
    if(['update','remove'].includes(action)&&(typeof id!=='string'||!id))throw new MemoryError('需要指定记忆编号');
    const snapshot=this.current(revision);
    if(action==='configure'){
      if(!automatic||typeof automatic!=='object'||Array.isArray(automatic)||Object.keys(automatic).some(key=>!['enabled','reviewEveryTurns'].includes(key))||typeof automatic.enabled!=='boolean'||!Number.isInteger(automatic.reviewEveryTurns)||automatic.reviewEveryTurns<1||automatic.reviewEveryTurns>200)throw new MemoryError('自动记忆需要启用状态及 1–200 轮的回顾间隔');
      this.write(this.settingsFile,{...this.settings(),automatic:{enabled:automatic.enabled,reviewEveryTurns:automatic.reviewEveryTurns}});return this.snapshot();
    }
    let entries=snapshot.entries,nextSettings;
    if(action==='add')entries.push({id:crypto.randomBytes(4).toString('hex'),text:memoryText(text),created:new Date().toISOString()});
    else{
      const index=entries.findIndex(entry=>entry.id===id);
      if(index<0)throw new MemoryError('未找到该记忆编号');
      if(action==='remove'){
        const settings=this.settings();settings.forgotten=[...new Set([...settings.forgotten,textHash(entries[index].text)])];
        nextSettings=settings;entries=entries.filter(entry=>entry.id!==id);
      }else{
        text=memoryText(text);
        if(entries[index].origin==='automatic'&&normalizeMemoryText(entries[index].text)!==normalizeMemoryText(text)){
          const settings=this.settings();settings.forgotten=[...new Set([...settings.forgotten,textHash(entries[index].text)])];nextSettings=settings;
        }
        entries[index]={...entries[index],text,updated:new Date().toISOString(),...(entries[index].origin==='automatic'?{manualEdited:true}:{})};
      }
    }
    if(action!=='remove')checkCapacity(entries);
    // Write guards only after validation, and before the entry change so a failed entry write cannot resurrect a removed fact.
    if(nextSettings)this.write(this.settingsFile,nextSettings);
    this.write(this.privateFile,entries);
    return this.snapshot();
  }
  rememberAutomatic({revision,action,id,text,category,evidence},source){
    const snapshot=this.current(revision);
    if(!snapshot.automatic.enabled)throw new MemoryError('此账号已关闭自动记忆',403);
    text=memoryText(text);
    const key=normalizeMemoryText(text),entries=snapshot.entries;
    if(this.settings().forgotten.includes(textHash(text)))throw new MemoryError('该内容曾被手动删除，不会自动恢复；需要时请手动添加');
    const index=action==='update'?entries.findIndex(entry=>entry.id===id):-1;
    if(action==='update'&&(index<0||entries[index].origin!=='automatic'||entries[index].manualEdited))throw new MemoryError(index<0?'未找到该记忆编号':'手动维护的记忆不会被自动修改');
    const duplicate=entries.find(entry=>normalizeMemoryText(entry.text)===key);
    if(duplicate)return {...snapshot,unchanged:true,entry:memoryEntryView(duplicate)};
    const metadata={origin:'automatic',category,evidence,source:Object.fromEntries(['messageId','threadId','turnId','chat','group'].filter(key=>source[key]!==undefined).map(key=>[key,source[key]]))};
    let entry;
    if(action==='update')entry=entries[index]={...entries[index],text,...metadata,updated:new Date().toISOString()};
    else{entry={id:crypto.randomBytes(4).toString('hex'),text,...metadata,created:new Date().toISOString()};entries.push(entry);}
    checkCapacity(entries);this.write(this.privateFile,entries);
    return {...this.snapshot(),entry:memoryEntryView(entry)};
  }
  context(){const global=this.read(this.globalFile),privateEntries=this.read(this.privateFile);return `当前有效的共享记忆（仅管理员维护）：\n${global.map(x=>x.text).join('\n')||'无'}\n当前 QQ 账号的独立记忆（仅此账号可见）：\n${privateEntries.map(x=>x.text).join('\n')||'无'}\n已删除或被修改的旧记忆不再有效。记忆作为参考资料，不替代当前任务指令。`;}
  display(){return `全局记忆：\n${this.read(this.globalFile).map(x=>x.text).join('\n')||'无'}\n你的账号记忆：\n${this.read(this.privateFile).map(x=>`${x.id}：${x.text}`).join('\n')||'无'}\n/remember 内容 保存到你的账号；/forget 编号 删除。全局记忆在本机配置页维护。`;}
}
