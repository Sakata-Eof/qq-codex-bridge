import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { CodexRPC } from '../../src/core/codex.mjs';
import { Bridge } from '../../src/core/bridge.mjs';
import { Memory } from '../../src/core/memory.mjs';
import { MemoryReview } from '../../src/core/memory-review.mjs';
import { memorySkillFile, verificationDir } from '../../src/paths.mjs';

// Real inference, synthetic conversations only. Never connects to QQ or a paired account.
export async function probeMemoryLearning({reviewOnly=false}={}){
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'qq-memory-learning-probe-')),home=path.join(folder,'codex-home'),workspace=path.join(folder,'work');
  fs.mkdirSync(workspace,{recursive:true});fs.mkdirSync(home,{recursive:true});
  const original=process.env.CODEX_HOME||path.join(os.homedir(),'.codex');
  for(const file of ['auth.json','config.toml'])if(fs.existsSync(path.join(original,file)))fs.copyFileSync(path.join(original,file),path.join(home,file));
  const skillPath=path.join(home,'skills','qq-memory-learning','SKILL.md');fs.mkdirSync(path.dirname(skillPath),{recursive:true});fs.copyFileSync(memorySkillFile,skillPath);
  const memory=new Memory(path.join(folder,'global.json'),path.join(folder,'A','private-memory.json')),other=new Memory(path.join(folder,'global.json'),path.join(folder,'B','private-memory.json'));
  const rpc=new CodexRPC('codex',{CODEX_HOME:home}),messages=[],events=[];
  const report={time:new Date().toISOString(),scope:'Real local Codex with synthetic isolated account storage; no QQ delivery',checks:[],rpcFailures:[]};
  const call=rpc.call.bind(rpc);rpc.call=async(method,...args)=>{try{return await call(method,...args);}catch(error){report.rpcFailures.push({method,error:error.message});throw error;}};
  let review;
  try{
    await rpc.start();
    const bridge=new Bridge({ownerOpenId:'probe-A',workspace,allowedRoots:[workspace],allowedGroups:[],memorySkillPath:skillPath},rpc,async(event,text)=>messages.push({messageId:event.id,text}),()=>{},path.join(folder,'A','sessions.json'),()=>{},null,memory);
    fs.mkdirSync(path.dirname(bridge.stateFile),{recursive:true});
    review=new MemoryReview({rpc,memory,cwd:workspace,skillPath,modelParams:()=>({}),isIdle:()=>true,log:()=>{},timeoutMs:150000});bridge.memoryReview=review;
    rpc.on('notification',event=>events.push({method:event.method,threadId:event.params?.threadId,itemType:event.params?.item?.type}));
    if(!reviewOnly){const completed=new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Main synthetic task timed out')),150000);
      const onNotification=event=>{if(event.method==='turn/completed'&&event.params?.threadId===[...bridge.sessions.values()][0]?.threadId){clearTimeout(timer);rpc.off('notification',onNotification);resolve(event.params.turn.status);}};
      rpc.on('notification',onNotification);
    });
    await bridge.handle({id:'preference-turn',user:'probe-A',chat:'probe-A',group:false,text:'我的长期偏好是用简洁中文交流，涉及操作时先给结论再说明验证结果。现在请回答 2 加 3 等于几，不需要创建文件。'});
    const status=await completed;
    await [...bridge.sessions.values()][0].deliveryPromise;
    const initial=memory.snapshot();
    report.checks.push({test:'normal conversation stores automatic preference',passed:status==='completed'&&initial.entries.some(entry=>entry.origin==='automatic'&&entry.category==='preference'&&entry.source?.messageId==='preference-turn')});
    }
    const mainThread=[...bridge.sessions.values()][0]?.threadId;
    review.record({messageId:'legacy-completed-turn',threadId:'legacy-synthetic-thread',turnId:'legacy-synthetic-turn',chat:'probe-A',group:false,userText:'我的主要学习语言是 TypeScript，之后的学习示例优先用 TypeScript。',assistantText:'好的，之后的学习示例会优先用 TypeScript。',validatedOutcome:false});
    const reviewCompleted=await review.flush({force:true}),after=memory.snapshot();
    report.checks.push({test:'periodic review extracts from completed legacy conversation',passed:reviewCompleted&&after.entries.some(entry=>entry.source?.messageId==='legacy-completed-turn'&&/TypeScript/i.test(entry.text))});
    report.checks.push({test:'review does not deliver a QQ task result',passed:messages.length===(reviewOnly?0:1)&&messages.every(message=>message.messageId==='preference-turn')});
    report.checks.push({test:'other account remains empty',passed:other.snapshot().entries.length===0});
    const workerEvents=events.filter(event=>event.threadId&&event.threadId!==mainThread);
    report.checks.push({test:'review uses no shell file-change or external MCP tools',passed:workerEvents.length>0&&!workerEvents.some(event=>['commandExecution','fileChange','mcpToolCall'].includes(event.itemType))});
    report.checks.push({test:'worker exits and records status',passed:!review.busy&&review.status().lastAttempt?.status==='completed'});
  }catch(error){report.checks.push({test:'live probe execution',passed:false,error:error.message});}
  finally{
    review?.stop();rpc.stop();
    // Remove only the credential copy this probe created, retaining ignored diagnostic artifacts.
    const authCopy=path.join(home,'auth.json');if(fs.existsSync(authCopy))fs.unlinkSync(authCopy);
    fs.mkdirSync(verificationDir,{recursive:true});fs.writeFileSync(path.join(verificationDir,'memory-learning.json'),JSON.stringify(report,null,2));
  }
  return report;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const report=await probeMemoryLearning({reviewOnly:process.argv.includes('--review-only')});console.log(JSON.stringify({...report,rpcFailures:report.rpcFailures.map(failure=>({method:failure.method}))}));if(report.checks.some(check=>!check.passed))process.exitCode=1;
}
