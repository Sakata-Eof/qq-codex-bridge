import WebSocket from 'ws';
import { fetch, ProxyAgent } from 'undici';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { EventEmitter } from 'node:events';
import { parseMessage } from './events.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { safeMediaURL } from './media-url.mjs';
import { markdownText } from './controls.mjs';
import { splitMarkdown } from './markdown.mjs';

const markdownRejected=err=>err.definite!==false&&!(Number(err.status)>=500)&&([22006,304061,40034011,40034029,40034127].includes(Number(err.code))||err.status===403);
const definiteRejection=err=>err.definite===true||(err.definite!==false&&Number(err.status)>=400&&Number(err.status)<500&&Number(err.status)!==408)||markdownRejected(err);
const quotaError=()=>Object.assign(new Error('QQ 当前消息回复次数已用完'),{definite:true});
function deliveryError(err,report){try{Object.assign(err,report);}catch{}return err;}
function splitPlain(value,limit=1300){
  const parts=[];let text=String(value);
  while(text){
    let end=Math.min(limit,text.length);
    if(end<text.length&&/[\uD800-\uDBFF]/.test(text[end-1]))end--;
    if(end<text.length){const prefix=text.slice(0,end),paragraph=prefix.lastIndexOf('\n\n'),line=prefix.lastIndexOf('\n');if(paragraph>=0)end=paragraph+2;else if(line>=0)end=line+1;}
    const source=text.slice(0,end);parts.push({text:source,markdown:source});text=text.slice(end);
  }
  return parts;
}

export class QQ extends EventEmitter {
  constructor(config, log) { super(); this.config=config; this.log=log; this.state='未配置'; this.seq=null; this.session=null; this.counts=new Map(); this.running=false; }
  async json(url, options={}) {
    const dispatcher=this.config.qqProxy ? (this.proxy ||= new ProxyAgent(this.config.qqProxy)) : undefined;
    const response=await fetch(url,{...options,dispatcher,signal:AbortSignal.timeout(20000)});
    let data; try {data=await response.json();} catch {throw Object.assign(new Error(`QQ HTTP ${response.status} 非 JSON 响应`),{status:response.status});}
    if(!response.ok || (data.code && data.code!==0)){const error=new Error(`QQ HTTP ${response.status} 业务错误 ${data.code || 'unknown'}`);error.status=response.status;error.code=data.code;throw error;}
    return data;
  }
  async token() {
    if(this.access && Date.now()<this.expires) return this.access;
    if(this.tokenFlight) return this.tokenFlight;
    this.tokenFlight=(async()=>{
      const data=await this.json('https://api.bot.qq.com/app/getAppAccessToken',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({appId:this.config.appId,clientSecret:this.config.clientSecret})});
      if(!data.access_token) throw new Error('QQ 未返回 access_token');
      this.access=data.access_token; this.expires=Date.now()+Math.max(30,Number(data.expires_in)-60)*1000; return this.access;
    })();
    try{return await this.tokenFlight;}finally{this.tokenFlight=null;}
  }
  async api(endpoint, body, method=body?'POST':'GET') {
    return this.json((this.config.sandbox ? 'https://sandbox.api.sgroup.qq.com' : 'https://api.bot.qq.com')+endpoint,{method,headers:{Authorization:`QQBot ${await this.token()}`,'X-Union-Appid':this.config.appId,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  }
  start() {
    if(this.running || !this.config.appId || !this.config.clientSecret) return;
    this.running=true; this.loopPromise=this.loop();
  }
  async stop() { this.running=false; clearInterval(this.heartbeat); if(this.ws) this.ws.terminate(); if(this.wake) this.wake(); await this.loopPromise; this.state='已停止'; }
  async loop() {
    let failures=0;
    while(this.running) {
      try {
        this.state='正在连接'; const {url}=await this.api('/gateway');
        if(!url || !url.startsWith('wss://')) throw new Error('QQ 网关地址无效');
        await this.connection(url); failures++;
      } catch(e) { this.state=e.message; this.log(e.message); failures++; }
      if(!this.running) break;
      await new Promise(resolve=>{const t=setTimeout(resolve,Math.min(60000,2000*2**Math.min(failures,5)));this.wake=()=>{clearTimeout(t);resolve();};}); this.wake=null;
    }
  }
  connection(url) {
    return new Promise((resolve,reject)=>{
      const ws=this.ws=new WebSocket(url,{handshakeTimeout:20000,...(this.config.qqProxy?{agent:new HttpsProxyAgent(this.config.qqProxy)}:{})});
      let awaitingAck=false;
      const helloDeadline=setTimeout(()=>ws.terminate(),25000);
      ws.on('message', raw=>{
        let p;try{p=JSON.parse(raw.toString());}catch{return;}
        if(p.s!==undefined) this.seq=p.s;
        if(p.op===10) {
          clearTimeout(helloDeadline); clearInterval(this.heartbeat);
          const send=d=>{if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(d));};
          void this.token().then(token=>send(this.session?{op:6,d:{token:`QQBot ${token}`,session_id:this.session,seq:this.seq}}:{op:2,d:{token:`QQBot ${token}`,intents:1<<25,shard:[0,1],properties:{$os:'windows',$browser:'codex-qq',$device:'codex-qq'}}})).catch(()=>ws.terminate());
          this.heartbeat=setInterval(()=>{if(awaitingAck){ws.terminate();return;}awaitingAck=true;send({op:1,d:this.seq});},Math.max(1000,p.d.heartbeat_interval*0.8));
        } else if(p.op===11) awaitingAck=false;
        else if(p.op===1) {if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({op:1,d:this.seq}));}
        else if(p.op===7) ws.close();
        else if(p.op===9) {this.session=null;this.seq=null;ws.close();}
        else if(p.op===0) {
          if(p.t==='READY') {this.session=p.d.session_id;this.state='QQ 在线（READY）';this.log(this.state);this.emit('ready');}
          else if(p.t==='RESUMED') {this.state='QQ 在线（RESUMED）';this.log(this.state);}
          const e=parseMessage(p.t,p.d);if(e)this.emit('message',e);
        }
      });
      ws.once('error',reject);
      ws.once('close',(code)=>{clearTimeout(helloDeadline);clearInterval(this.heartbeat);if([4006,4007,4009,4900].includes(code)){this.session=null;this.seq=null;}if([4004,4013,4014].includes(code)){this.state=`QQ 拒绝接入 (${code})，请检查凭据与订阅权限`;this.log(this.state);}else this.state=`QQ 连接关闭 (${code})`;resolve();});
    });
  }
  async send(e,text,options={}) {
    let plain=options.format==='plain'||this.config.replyFormat==='plain';
    const parts=plain?splitPlain(text):splitMarkdown(String(text),1300),max=(e.group?5:4)-(options.reserve||0);
    const endpoint=`/v2/${e.group?'groups':'users'}/${encodeURIComponent(e.chat)}/messages`;
    if(!parts.length||max<1||(this.counts.get(e.id)||0)>=max)throw deliveryError(quotaError(),{acceptedParts:0,totalParts:parts.length,uncertain:false});
    let acceptedParts=0,wasTruncated=false;
    try{for(let i=0;i<parts.length;i++){
      let accepted=false;
      const post=async asPlain=>{
        const sequence=(this.counts.get(e.id)||0)+1;if(sequence>max)throw quotaError();
        this.counts.set(e.id,sequence);
        const truncated=sequence===max&&i<parts.length-1,notice=truncated?'\n（结果较长，完整内容保存在本机配置页。）':'';
        const source=parts[i].text+notice,rendered=(asPlain?parts[i].text:parts[i].markdown)+notice;
        // A timeout may mean the message arrived. Only a definite rejection permits fallback.
        await this.api(endpoint,{...(asPlain?{msg_type:0,content:rendered}:{msg_type:2,markdown:{content:rendered}}),msg_id:e.id,msg_seq:sequence});
        accepted=true;acceptedParts++;wasTruncated ||= truncated;
        try{this.emit('sent',{event:e,text:source,sequence,format:asPlain?'plain':'markdown',renderedText:rendered});}
        catch(err){throw deliveryError(err,{accepted:true,auditFailed:true,uncertain:false});}
        return truncated;
      };
      let truncated;
      try{truncated=await post(plain);}
      catch(err){
        if(accepted||plain||!markdownRejected(err))throw err;
        this.log(`原生 Markdown 被 QQ 拒绝，改用纯文本：${err.message}`);plain=true;
        const remaining=parts.slice(i).map(part=>part.text).join('');parts.splice(i,parts.length-i,...splitPlain(remaining));
        truncated=await post(true);
      }
      if(truncated)break;
    }}catch(err){throw deliveryError(err,{acceptedParts,totalParts:parts.length,truncated:wasTruncated,uncertain:err.uncertain??(!err.accepted&&!definiteRejection(err))});}
    if(this.counts.size>2000)this.counts.delete(this.counts.keys().next().value);
    return {acceptedParts,totalParts:parts.length,truncated:wasTruncated};
  }
  async sendPlain(e,text,options={}) {return this.send(e,text,{...options,format:'plain'});}
  async sendAnnouncement(user,text) {
    if(typeof user?.id!=='string'||!user.id||typeof text!=='string'||!text.trim()||text.length>1400)throw Object.assign(new Error('主动通知需要接收账号及 1–1400 字的正文'),{definite:true});
    const endpoint=`/v2/users/${encodeURIComponent(user.id)}/messages`;
    const parts=splitMarkdown(text,1500);
    if(parts.length!==1)throw Object.assign(new Error('通知排版后超过单条消息上限'),{definite:true});
    let accepted=false;
    const post=async plain=>{
      const result=await this.api(endpoint,plain?{msg_type:0,content:text}:{msg_type:2,markdown:{content:parts[0].markdown}});
      accepted=true;
      this.emit('announcementSent',{userId:user.id,text,format:plain?'plain':'markdown',renderedText:plain?text:parts[0].markdown});return result;
    };
    if(this.config.replyFormat==='plain')return post(true);
    try{return await post(false);}
    catch(err){if(accepted||!markdownRejected(err))throw err;this.log(`通知 Markdown 被 QQ 拒绝，改用纯文本：${err.message}`);return post(true);}
  }
  async sendButtons(e,text,rows){
    const max=e.group?5:4,n=(this.counts.get(e.id)||0)+1;if(n>max)throw new Error('QQ 当前消息回复次数已用完');
    const endpoint=`/v2/${e.group?'groups':'users'}/${encodeURIComponent(e.chat)}/messages`;
    const keyboard={content:{rows:rows.slice(0,5).map(buttons=>({buttons:buttons.slice(0,5)}))}};
    // Long details are delivered in full as text; the final card carries controls.
    let summary=text;if(text.length>1200){await this.send(e,text,{reserve:1});summary='请先阅读以上完整请求，再选择下方按钮。';}
    const sequence=(this.counts.get(e.id)||0)+1;if(sequence>max)throw new Error('回复次数不足，请使用文字审批指令');this.counts.set(e.id,sequence);
    let accepted=false;
    try{
      await this.api(endpoint,{msg_type:2,markdown:{content:markdownText(summary)},keyboard,msg_id:e.id,msg_seq:sequence});
      accepted=true;
      this.emit('sent',{event:e,text:summary,sequence,keyboard,format:'markdown',renderedText:markdownText(summary)});
    }catch(err){
      // Only a definite format/permission rejection permits a text fallback.
      if(!accepted&&markdownRejected(err)){this.log(`原生按钮被 QQ 拒绝，改用文字：${err.message}`);await this.sendPlain(e,text.length>1200?'请阅读以上完整请求，并使用其中的文字指令提交选择。':text);return;}
      throw err;
    }
  }
  async sendFile(e,file){
    let messageAttempted=false,accepted=false;
    try{
    if((this.counts.get(e.id)||0)>=(e.group?5:4))throw new Error('回复次数已用完，请用 /file 指令重新请求');
    const size=fs.statSync(file).size;if(size>50*1024*1024)throw new Error('发送文件上限 50MB');if(!size)throw new Error('不能发送空文件');
    const data=fs.readFileSync(file),ext=path.extname(file).toLowerCase();
    const type=['.png','.jpg','.jpeg','.webp','.gif','.bmp'].includes(ext)?1:ext==='.mp4'?2:['.mp3','.wav','.silk','.ogg'].includes(ext)?3:4;
    const prefix=`/v2/${e.group?'groups':'users'}/${encodeURIComponent(e.chat)}`;
    const hash=(name,b=data)=>crypto.createHash(name).update(b).digest('hex');
    const raw=await this.api(prefix+'/upload_prepare',{file_type:type,file_size:String(size),file_name:path.basename(file),md5:hash('md5'),sha1:hash('sha1'),md5_10m:hash('md5',data.subarray(0,10002432))});
    const prep=raw.data||raw;
    if(!prep.upload_id||!Array.isArray(prep.parts))throw new Error('QQ 预上传未返回分片列表');
    let offset=0;
    for(const part of prep.parts){
      const block=Number(part.block_size||prep.block_size);if(!Number.isInteger(block)||block<1)throw new Error('QQ 分片大小无效');
      const bytes=data.subarray(offset,Math.min(offset+block,data.length));offset+=bytes.length;
      const url=safeMediaURL(part.presigned_url);
      const r=await fetch(url,{method:'PUT',body:bytes,redirect:'error',signal:AbortSignal.timeout(120000)});
      if(!r.ok)throw new Error(`QQ 分片上传 HTTP ${r.status}`);await r.body?.cancel();
      const deadline=Date.now()+Math.min(120000,Number(prep.upload_config?.retry_timeout||120)*1000);
      for(;;){try{await this.api(prefix+'/upload_part_finish',{upload_id:prep.upload_id,part_index:part.index,block_size:String(bytes.length),md5:hash('md5',bytes)});break;}catch(err){if(!err.message.includes('40093001')||Date.now()>deadline)throw err;await new Promise(r=>setTimeout(r,1000));}}
    }
    if(offset!==data.length)throw new Error('QQ 分片未覆盖整个文件');
    const result=await this.api(prefix+'/files',{file_type:type,upload_id:prep.upload_id,file_name:path.basename(file),srv_send_msg:false});
    const info=result.file_info||result.data?.file_info;if(!info)throw new Error('QQ 文件上传未返回 file_info');
    const n=(this.counts.get(e.id)||0)+1;if(n>(e.group?5:4))throw new Error('回复次数已用完，请用 /file 指令重新请求');this.counts.set(e.id,n);
    messageAttempted=true;await this.api(prefix+'/messages',{msg_type:7,media:{file_info:info},msg_id:e.id,msg_seq:n});accepted=true;
    this.emit('sent',{event:e,file,text:path.basename(file),sequence:n});
    return {acceptedParts:1,totalParts:1,truncated:false};
    }catch(err){throw deliveryError(err,{accepted,acceptedParts:accepted?1:0,totalParts:1,auditFailed:accepted,uncertain:messageAttempted&&!accepted&&!definiteRejection(err),...(!messageAttempted?{definite:true}:{})});}
  }
}
