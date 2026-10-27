import { MemoryError, memoryEntryView } from './memory.mjs';

export const MEMORY_TOOL_NAME='qq_memory';
const categories=['preference','profile','project','lesson'];
const argumentKeys=['action','revision','id','text','category','evidence'];
export const memoryToolSpec={
  type:'function',name:MEMORY_TOOL_NAME,
  description:'读取和维护当前 QQ 账号的长期独立记忆。先 list 获取 revision；只保存有当前对话证据的稳定偏好、背景或已验证经验。不会访问其他账号或全局记忆，也不能自动删除或改写手工条目。',
  inputSchema:{type:'object',additionalProperties:false,properties:{
    action:{type:'string',enum:['list','remember','update']},revision:{type:'string'},id:{type:'string'},text:{type:'string',maxLength:2000},category:{type:'string',enum:categories},evidence:{type:'string',description:'来自当前用户原话的精确片段；经验条目也可引用已验证的任务结果。'}
  },required:['action']}
};
const result=(success,data)=>({success,contentItems:[{type:'inputText',text:JSON.stringify(data)}]});
const publicSnapshot=snapshot=>({revision:snapshot.revision,automatic:snapshot.automatic,entries:snapshot.entries.map(memoryEntryView),...(snapshot.entry?{entry:snapshot.entry}:{}),...(snapshot.unchanged?{unchanged:true}:{})});
export function runMemoryTool(memory,args,source){
  try{
    if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(key=>!argumentKeys.includes(key))||!['list','remember','update'].includes(args.action))throw new MemoryError('无效的账号记忆操作');
    if(args.action==='list')return result(true,publicSnapshot(memory.snapshot()));
    if(!source||['messageId','threadId','turnId'].some(key=>typeof source[key]!=='string'||!source[key])||source.chat!==undefined&&typeof source.chat!=='string'||source.group!==undefined&&typeof source.group!=='boolean')throw new MemoryError('缺少当前任务的记忆来源，未保存');
    if(!categories.includes(args.category)||typeof args.evidence!=='string'||!args.evidence.trim()||args.evidence.length>2000)throw new MemoryError('自动记忆需要类别和当前对话中的原文证据');
    const evidence=args.evidence.trim();
    const fromUser=typeof source.userText==='string'&&source.userText.includes(evidence);
    const fromValidatedResult=args.category==='lesson'&&source.validatedOutcome===true&&typeof source.assistantText==='string'&&source.assistantText.includes(evidence);
    if(!fromUser&&!fromValidatedResult)throw new MemoryError('记忆证据不属于当前用户原话或已验证结果，未保存');
    if(typeof args.text!=='string'||/-----BEGIN [A-Z ]*(?:PRIVATE KEY|SECRET)|(?:api[_ -]?key|password|token|密码|密钥|验证码)\s*[:=：]\s*\S+/iu.test(args.text+'\n'+evidence))throw new MemoryError('自动记忆不保存凭据、密钥或验证码');
    if(args.action==='update'&&(typeof args.id!=='string'||!args.id))throw new MemoryError('更新自动记忆需要现有条目编号');
    return result(true,publicSnapshot(memory.rememberAutomatic({...args,evidence},source)));
  }catch(error){
    return result(false,{error:error instanceof MemoryError?error.message:'账号记忆暂时不可用，请重新读取后再试',...(error instanceof MemoryError?{status:error.status}:{})});
  }
}
