import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [id,file,...flags]=process.argv.slice(2),dir=path.dirname(fileURLToPath(import.meta.url));
if(!id||!file||flags.some(flag=>flag!=='--preview'))throw new Error('用法：node notify-release.mjs 发布id 正文.txt [--preview]');
const config=JSON.parse(fs.readFileSync(path.join(dir,'runtime/config.json'),'utf8'));
const text=fs.readFileSync(path.resolve(file),'utf8').trim();
if(!/^[a-zA-Z0-9._-]{1,80}$/.test(id)||!text||text.length>1400)throw new Error('通知需要稳定版本 id 和 1–1400 字的正文');
if(flags.includes('--preview'))console.log(JSON.stringify({id,text,recipients:config.users.length,enabled:config.releaseNotificationsEnabled===true},null,2));
else{
  if(config.releaseNotificationsEnabled!==true)throw new Error('发布通知未启用');
  const response=await fetch(`http://127.0.0.1:${Number(process.env.QQ_CODEX_PORT||17329)}/api/releases`,{method:'POST',headers:{Authorization:'Bearer '+config.adminToken,'Content-Type':'application/json'},body:JSON.stringify({id,text}),signal:AbortSignal.timeout(600000)});
  const result=await response.json();console.log(JSON.stringify(result));
  if(!response.ok||result.failed||result.unknown||result.storageErrors||result.recordErrors)process.exitCode=1;
}
