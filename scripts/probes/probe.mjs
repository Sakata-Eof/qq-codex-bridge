import fs from 'node:fs';
import path from 'node:path';
import { probeWorkspaceDir, verificationDir } from '../../src/paths.mjs';
import { CodexRPC } from '../../src/core/codex.mjs';
const root=probeWorkspaceDir;fs.mkdirSync(root,{recursive:true});
async function turn(rpc,id,text,input=[]){
  return new Promise((resolve,reject)=>{
    let answer='',turnId;const timeout=setTimeout(()=>{cleanup();reject(new Error('Live turn timed out'));},180000);
    function cleanup(){clearTimeout(timeout);rpc.off('notification',handler);}
    function handler(m){if(m.params?.threadId!==id)return;const p=m.params;if(m.method==='item/completed'&&p.item?.type==='agentMessage'&&p.item.phase!=='commentary')answer=p.item.text;if(m.method==='turn/completed'){cleanup();p.turn.status==='completed'?resolve(answer):reject(new Error(JSON.stringify(p.turn.error||p.turn.status)));}}
    rpc.on('notification',handler);rpc.call('turn/start',{threadId:id,input:[{type:'text',text},...input]}).then(r=>{turnId=r.turn.id;}).catch(e=>{cleanup();reject(e);});
  });
}
async function account(label){const cwd=path.join(root,label);fs.mkdirSync(cwd,{recursive:true});const rpc=new CodexRPC();await rpc.start();const r=await rpc.call('thread/start',{cwd,sandbox:'workspace-write',approvalPolicy:'never',ephemeral:true,serviceName:'qq-bridge-verification'});return {rpc,id:r.thread.id,cwd,label};}
const report=[];
const a=await account('A'),b=await account('B');
try{
  for(const x of [a,b]){x.rpc.on('request',m=>{x.rpc.reply(m.id,{decision:'decline'});});}
  const result=await Promise.all([turn(a.rpc,a.id,'记住本会话的代号是 ALPHA_7429。只回复这个代号。'),turn(b.rpc,b.id,'记住本会话的代号是 BETA_3168。只回复这个代号。')]);
  report.push({test:'independent processes',passed:a.rpc.child.pid!==b.rpc.child.pid});
  report.push({test:'initial replies',passed:result[0].includes('ALPHA_7429')&&result[1].includes('BETA_3168'),replies:result});
  const recall=await Promise.all([turn(a.rpc,a.id,'刚才告诉你的本会话代号是什么？只回复代号。'),turn(b.rpc,b.id,'刚才告诉你的本会话代号是什么？只回复代号。')]);
  report.push({test:'conversation isolation',passed:recall[0].includes('ALPHA_7429')&&!recall[0].includes('BETA_3168')&&recall[1].includes('BETA_3168')&&!recall[1].includes('ALPHA_7429'),replies:recall});
  if(fs.existsSync(path.join(root,'vision.png'))){const answer=await turn(a.rpc,a.id,'图片中心的 VISION 后面四位数字是什么？只回答四位数字。',[{type:'localImage',path:path.join(root,'vision.png')}]);report.push({test:'live image input',passed:answer.includes('5826'),reply:answer});}
  const written=await turn(a.rpc,a.id,'请在当前目录创建 verification.txt，内容严格为 QQ_CODEX_FILE_OK，然后回复完成。');
  report.push({test:'live file execution',passed:fs.existsSync(path.join(a.cwd,'verification.txt'))&&fs.readFileSync(path.join(a.cwd,'verification.txt'),'utf8').trim()==='QQ_CODEX_FILE_OK',reply:written});
}catch(e){report.push({test:'live probe',passed:false,error:e.message});}
finally{a.rpc.stop();b.rpc.stop();fs.mkdirSync(verificationDir,{recursive:true});fs.writeFileSync(path.join(verificationDir,'verification.json'),JSON.stringify({time:new Date().toISOString(),scope:'Real local Codex, not real QQ delivery',checks:report},null,2));console.log(JSON.stringify(report));}
