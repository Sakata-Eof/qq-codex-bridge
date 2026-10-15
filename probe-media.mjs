import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Media } from './media.mjs';
import { CodexRPC } from './codex.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run=promisify(execFile),dir=path.dirname(fileURLToPath(import.meta.url)),root=path.resolve(dir,'../../work/probe');
const config=JSON.parse(fs.readFileSync(path.join(dir,'runtime/config.json'),'utf8')),media=new Media(config,{}),report=[];
media.download=async(url,target)=>{const f=url.includes('video')?'video.mp4':url.includes('image')?'vision.png':'speech.wav';fs.copyFileSync(path.join(root,f),target);return target;};
const cwd=path.join(root,'media');fs.mkdirSync(cwd,{recursive:true});
const event=(id,attachments,text='')=>({user:'probe',chat:'probe',group:false,id,text,attachments});
const imageInput=await media.prepare(event('image-test',[{content_type:'image/png',filename:'photo.png',url:'https://a.qpic.cn/image'}],'读取图片中央文字'),cwd);
report.push({test:'image pipeline creates model image input',passed:imageInput.some(x=>x.type==='localImage'&&fs.existsSync(x.path))});
const voiceInput=await media.prepare(event('voice-test',[{content_type:'voice',filename:'recording.wav',voice_wav_url:'https://a.qq.com/speech',url:'https://a.qq.com/speech'}]),cwd);
report.push({test:'real local speech transcription',passed:voiceInput[0].text.includes('红色苹果'),transcript:voiceInput[0].text});
await run(config.ffmpeg,['-v','error','-y','-loop','1','-i',path.join(root,'vision.png'),'-i',path.join(root,'speech.wav'),'-c:v','libx264','-shortest','-t','30','-pix_fmt','yuv420p','-c:a','aac',path.join(root,'video.mp4')],{windowsHide:true,timeout:60000});
const videoInput=await media.prepare(event('video-test',[{content_type:'video/mp4',filename:'video.mp4',url:'https://a.qq.com/video'}]),cwd);
report.push({test:'video frames and speech pipeline',passed:videoInput.filter(x=>x.type==='localImage').length>0&&/红色苹果|紅色蘋果/.test(videoInput[0].text),transcript:videoInput[0].text});
const home=path.join(root,'isolated-codex-home');fs.mkdirSync(home,{recursive:true});
for(const file of ['auth.json','config.toml'])fs.copyFileSync(path.join(process.env.USERPROFILE,'.codex',file),path.join(home,file));
const rpc=new CodexRPC(config.codexBinary,{CODEX_HOME:home});await rpc.start();
try{
  const t=await rpc.call('thread/start',{cwd,sandbox:'workspace-write',approvalPolicy:'never',ephemeral:true});
  const answer=await new Promise((resolve,reject)=>{
    let text='';const timer=setTimeout(()=>reject(new Error('Live image turn timeout')),180000);
    rpc.on('notification',m=>{if(m.params?.threadId!==t.thread.id)return;const p=m.params;if(m.method==='item/completed'&&p.item?.type==='agentMessage'&&p.item.phase!=='commentary')text=p.item.text;if(m.method==='turn/completed'){clearTimeout(timer);p.turn.status==='completed'?resolve(text):reject(new Error(p.turn.error?.message||p.turn.status));}});
    void rpc.call('turn/start',{threadId:t.thread.id,input:[{type:'text',text:'图片中心 VISION 后面四位数字是什么？只回答四位数字。'},...imageInput.filter(x=>x.type==='localImage')]}).catch(reject);
  });
  report.push({test:'live Codex vision with isolated home',passed:answer.includes('5826'),reply:answer});
}catch(e){report.push({test:'live Codex vision',passed:false,error:e.message});}
finally{rpc.stop();fs.writeFileSync(path.join(dir,'verification-media.json'),JSON.stringify({time:new Date().toISOString(),scope:'Real local media and Codex; QQ download/upload is pending live verification',checks:report},null,2));console.log(JSON.stringify(report));}
