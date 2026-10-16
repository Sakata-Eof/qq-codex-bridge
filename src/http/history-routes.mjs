import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { exportsDir } from '../paths.mjs';
import { within } from '../shared/path-security.mjs';

/** History endpoints run only after the application's local-origin and UI checks. */
export function createHistoryRoutes({config,accounts,history,qq,base,respond,body,exportsRoot=exportsDir}) {
  return async function historyRoutes(req,res) {
    if(req.method==='POST'&&req.url==='/api/export'){
      const input=await body(req),user=config.users.find(x=>x.id===input.user);if(!user)throw new Error('账号不存在');
      const folder=path.join(exportsRoot,accounts.userKey(user.id));fs.mkdirSync(folder,{recursive:true});
      const file=path.join(folder,`history-${new Date().toISOString().replace(/[:.]/g,'-')}-${crypto.randomBytes(3).toString('hex')}.json`);
      const count=await history.exportJSON(user.id,file,input.thread);respond(res,200,{file,count});return true;
    }
    if(req.method==='GET'&&req.url==='/api/history/accounts'){
      respond(res,200,{qq:qq.state,storage:'SQLite',users:config.users.map(u=>({id:u.id,label:u.label}))});return true;
    }
    if(req.method==='GET'&&req.url.startsWith('/api/history/sessions?')){
      const query=new URL(req.url,base).searchParams,user=config.users.find(x=>x.id===query.get('user'));if(!user)throw new Error('账号不存在');
      respond(res,200,history.sessions(user.id,{before:query.get('before')||'',limit:query.get('limit')||30}));return true;
    }
    if(req.method==='POST'&&req.url==='/api/history/title'){
      const input=await body(req),user=config.users.find(x=>x.id===input.user);if(!user)throw new Error('账号不存在');
      respond(res,200,history.rename(user.id,input.thread,input.title));return true;
    }
    if(req.method==='GET'&&req.url.startsWith('/api/history/updates?')){
      const query=new URL(req.url,base).searchParams,user=config.users.find(x=>x.id===query.get('user'));if(!user)throw new Error('账号不存在');
      respond(res,200,history.updates(user.id,query.get('thread'),Number(query.get('after')||0)));return true;
    }
    if(req.method==='GET'&&req.url.startsWith('/api/history?')){
      const query=new URL(req.url,base).searchParams,user=config.users.find(x=>x.id===query.get('user'));if(!user)throw new Error('账号不存在');
      respond(res,200,history.page(user.id,{thread:query.has('thread')?query.get('thread'):undefined,q:query.get('q')||'',before:query.get('before')||'',limit:query.get('limit')||30}));return true;
    }
    if(req.method==='GET'&&req.url.startsWith('/api/asset?')){
      const query=new URL(req.url,base).searchParams,user=config.users.find(x=>x.id===query.get('user')),file=query.get('file');
      if(!user||!file||!path.isAbsolute(file)||!fs.existsSync(file)||!fs.statSync(file).isFile()||!user.allowedRoots.some(root=>within(root,file)))throw new Error('文件不属于当前账号目录');
      const mime={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.mp4':'video/mp4','.wav':'audio/wav','.mp3':'audio/mpeg'}[path.extname(file).toLowerCase()]||'application/octet-stream';
      res.setHeader('Content-Length',fs.statSync(file).size);
      res.setHeader('Content-Type',mime);res.setHeader('Content-Disposition',`inline; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`);
      fs.createReadStream(file).pipe(res);return true;
    }
    return false;
  };
}
