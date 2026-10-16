import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
export const UNASSIGNED='__unassigned__';
const cursor=row=>Buffer.from(JSON.stringify([row.time,row.id])).toString('base64url');
export class History {
  constructor(config,runtime){
    this.config=config;this.runtime=runtime;fs.mkdirSync(runtime,{recursive:true});this.databaseFile=path.join(runtime,'history.sqlite');
    this.db=new DatabaseSync(this.databaseFile,{timeout:3000});this.statements=new Map();
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS threads(user TEXT NOT NULL,thread_id TEXT NOT NULL,title TEXT NOT NULL,created_at TEXT NOT NULL,last_at TEXT NOT NULL,message_count INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(user,thread_id));
      CREATE INDEX IF NOT EXISTS threads_recent ON threads(user,last_at DESC,thread_id);
      CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY,user TEXT NOT NULL,record_id TEXT NOT NULL,time TEXT NOT NULL,thread_id TEXT NOT NULL,kind TEXT NOT NULL,message_id TEXT,text TEXT NOT NULL,payload TEXT NOT NULL,UNIQUE(user,record_id));
      CREATE INDEX IF NOT EXISTS messages_thread_time ON messages(user,thread_id,time DESC,id DESC);
      CREATE INDEX IF NOT EXISTS messages_user_time ON messages(user,time DESC,id DESC);
      CREATE INDEX IF NOT EXISTS messages_thread_seq ON messages(user,thread_id,id);
      CREATE INDEX IF NOT EXISTS messages_event ON messages(user,message_id,kind);
      CREATE TABLE IF NOT EXISTS imports(user TEXT NOT NULL,file TEXT NOT NULL,size INTEGER NOT NULL,mtime REAL NOT NULL,PRIMARY KEY(user,file));
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(text,content='messages',content_rowid='id',tokenize='trigram');
      CREATE TRIGGER IF NOT EXISTS message_insert AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid,text) VALUES(new.id,new.text);
        UPDATE threads SET message_count=message_count+1,created_at=min(created_at,new.time),last_at=max(last_at,new.time) WHERE user=new.user AND thread_id=new.thread_id;
      END;
      CREATE TRIGGER IF NOT EXISTS message_move AFTER UPDATE OF thread_id ON messages WHEN old.thread_id<>new.thread_id BEGIN
        UPDATE threads SET message_count=message_count-1,last_at=coalesce((SELECT max(time) FROM messages WHERE user=old.user AND thread_id=old.thread_id),last_at) WHERE user=old.user AND thread_id=old.thread_id;
        UPDATE threads SET message_count=message_count+1,created_at=min(created_at,new.time),last_at=max(last_at,new.time) WHERE user=new.user AND thread_id=new.thread_id;
      END;`);
    for(const user of config.users||[])this.migrateLegacy(user.id);
  }
  stmt(sql){if(!this.statements.has(sql))this.statements.set(sql,this.db.prepare(sql));return this.statements.get(sql);}
  transaction(fn){if(this.db.isTransaction)return fn();this.db.exec('BEGIN IMMEDIATE');try{const value=fn();this.db.exec('COMMIT');return value;}catch(err){this.db.exec('ROLLBACK');throw err;}}
  folder(user){return path.join(this.runtime,'users',crypto.createHash('sha256').update(this.config.appId+':'+user).digest('hex').slice(0,24));}
  title(text){return String(text||'').replace(/^\/codex\s+/,'').replace(/\s+/g,' ').trim().slice(0,80);}
  ensureThread(user,thread,time=new Date().toISOString(),title=''){
    this.stmt('INSERT OR IGNORE INTO threads(user,thread_id,title,created_at,last_at) VALUES(?,?,?,?,?)').run(user,thread,thread===UNASSIGNED?'未关联会话的控制消息':this.title(title)||'未命名会话',time,time);
    if(title&&thread!==UNASSIGNED)this.stmt("UPDATE threads SET title=? WHERE user=? AND thread_id=? AND title='未命名会话'").run(this.title(title),user,thread);
  }
  record(user,entry){
    const row={time:new Date().toISOString(),recordId:crypto.randomBytes(8).toString('hex'),...entry};if(this.config.historyResetBefore&&row.time<=this.config.historyResetBefore)return null;
    const thread=row.threadId||UNASSIGNED,title=row.kind==='inbound'&&!String(row.text||'').startsWith('/')?row.text:'';
    this.transaction(()=>{this.ensureThread(user,thread,row.time,title);this.stmt('INSERT OR IGNORE INTO messages(user,record_id,time,thread_id,kind,message_id,text,payload) VALUES(?,?,?,?,?,?,?,?)').run(user,row.recordId,row.time,thread,row.kind||'unknown',row.messageId||null,String(row.text||''),JSON.stringify({...row,threadId:thread}));});return row.recordId;
  }
  hasInbound(user,messageId){return Boolean(this.stmt("SELECT 1 FROM messages WHERE user=? AND message_id=? AND kind='inbound' LIMIT 1").get(user,messageId));}
  bindMessage(user,messageId,thread,title=''){
    if(!thread||!messageId)return;this.transaction(()=>{this.ensureThread(user,thread,undefined,title);this.stmt("UPDATE messages SET thread_id=?,payload=json_set(payload,'$.threadId',?) WHERE user=? AND message_id=? AND thread_id<>?").run(thread,thread,user,messageId,thread);});
  }
  read(user){return this.stmt('SELECT payload FROM messages WHERE user=? ORDER BY id').all(user).map(x=>JSON.parse(x.payload));}
  migrateLegacy(user){
    const file=path.join(this.folder(user),'messages.jsonl');if(!fs.existsSync(file)||this.unchanged(user,file))return;
    const entries=fs.readFileSync(file,'utf8').split('\n').filter(Boolean).flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}}),threads=new Map(entries.filter(x=>x.messageId&&x.threadId).map(x=>[x.messageId,x.threadId]));
    this.transaction(()=>{for(const entry of entries){const imported=entry.thread?.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.jsonl$/i)?.[1];this.record(user,{...entry,threadId:entry.threadId||threads.get(entry.messageId)||imported||UNASSIGNED});}this.markImported(user,file);});
  }
  unchanged(user,file){const stat=fs.statSync(file),known=this.stmt('SELECT size,mtime FROM imports WHERE user=? AND file=?').get(user,file);return known?.size===stat.size&&known?.mtime===stat.mtimeMs;}
  markImported(user,file){const stat=fs.statSync(file);this.stmt('INSERT INTO imports(user,file,size,mtime) VALUES(?,?,?,?) ON CONFLICT(user,file) DO UPDATE SET size=excluded.size,mtime=excluded.mtime').run(user,file,stat.size,stat.mtimeMs);}
  importCodex(user){
    const folder=path.join(this.folder(user),'codex-home/sessions');if(!fs.existsSync(folder))return;
    const cutoff=this.stmt("SELECT min(time) AS time FROM messages WHERE user=? AND kind='inbound' AND json_extract(payload,'$.source') IS NOT 'codex-import'").get(user).time;
    for(const relative of fs.readdirSync(folder,{recursive:true}).filter(x=>x.endsWith('.jsonl'))){
      const file=path.join(folder,relative);if(this.unchanged(user,file))continue;const lines=fs.readFileSync(file,'utf8').split('\n'),thread=relative.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.jsonl$/i)?.[1]||'codex:'+relative;
      this.transaction(()=>{for(let i=0;i<lines.length;i++){let record;try{record=JSON.parse(lines[i]);}catch{continue;}
        const p=record.payload,item=p?.type==='item_completed'?p.item:null,kind=item?.type==='UserMessage'?'user_message':item?.type==='AgentMessage'?'agent_message':p?.type;
        if(record.type!=='event_msg'||!['user_message','agent_message'].includes(kind)||cutoff&&record.timestamp>=cutoff||this.config.historyResetBefore&&record.timestamp<=this.config.historyResetBefore)continue;
        const phase=item?.phase||p.phase;if(kind==='agent_message'&&phase&&phase!=='final_answer')continue;
        const text=item?(item.content||[]).filter(x=>['text','Text'].includes(x.type)).map(x=>x.text||'').join('\n'):p.message||'';
        this.record(user,{recordId:'codex:'+relative+':'+i,time:record.timestamp,kind:kind==='user_message'?'inbound':'outbound',text,source:'codex-import',thread:path.basename(relative),threadId:thread});
      }this.markImported(user,file);});
    }
  }
  sessions(user,{before='',limit=30}={}){
    limit=Math.max(1,Math.min(100,Number(limit)||30));const params=[user];let where='user=? AND message_count>0';
    if(before){const [time,id]=this.decode(before);where+=' AND (last_at<? OR (last_at=? AND thread_id>?))';params.push(time,time,String(id));}
    const rows=this.stmt(`SELECT thread_id AS id,title,created_at AS createdAt,last_at AS lastAt,message_count AS count FROM threads WHERE ${where} ORDER BY last_at DESC,thread_id LIMIT ?`).all(...params,limit+1),hasMore=rows.length>limit;rows.length=Math.min(rows.length,limit);const last=rows.at(-1);
    return {sessions:rows,next:hasMore?Buffer.from(JSON.stringify([last.lastAt,last.id])).toString('base64url'):null};
  }
  rename(user,thread,title){title=this.title(title);if(!title)throw new Error('标题不能为空');if(thread===UNASSIGNED)throw new Error('控制消息分组不能重命名');const result=this.stmt('UPDATE threads SET title=? WHERE user=? AND thread_id=? AND message_count>0').run(title,user,thread);if(!result.changes)throw new Error('会话不存在');return {ok:true,title};}
  decode(value){try{const parsed=JSON.parse(Buffer.from(value,'base64url').toString('utf8'));if(!Array.isArray(parsed)||parsed.length!==2||typeof parsed[0]!=='string'||!['number','string'].includes(typeof parsed[1]))throw new Error();return parsed;}catch{throw new Error('分页游标无效');}}
  criteria(user,thread,q=''){
    const params=[user],where=['m.user=?'];if(thread!==undefined&&thread!==null){where.push('m.thread_id=?');params.push(thread);}
    if(q){if(Array.from(q).length>=3){where.push('m.id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)');params.push('"'+q.replace(/"/g,'""')+'"');}where.push('instr(m.text,?)>0');params.push(q);}return {where:where.join(' AND '),params};
  }
  page(user,{thread,q='',before='',limit=30}={}){
    q=String(q).slice(0,200);limit=Math.max(1,Math.min(100,Number(limit)||30));const filter=this.criteria(user,thread,q),params=[...filter.params];let where=filter.where;
    if(before){const [time,id]=this.decode(before);if(!Number.isSafeInteger(id))throw new Error('分页游标无效');where+=' AND (m.time,m.id)<(?,?)';params.push(time,id);}
    const rows=this.stmt(`SELECT m.id,m.time,m.payload FROM messages m WHERE ${where} ORDER BY m.time DESC,m.id DESC LIMIT ?`).all(...params,limit+1),hasMore=rows.length>limit;rows.length=Math.min(limit,rows.length);
    const total=q||thread===undefined?this.stmt(`SELECT count(*) AS total FROM messages m WHERE ${filter.where}`).get(...filter.params).total:(this.stmt('SELECT message_count AS total FROM threads WHERE user=? AND thread_id=?').get(user,thread)?.total||0);
    const watermark=this.watermark(user,thread),next=hasMore?cursor(rows.at(-1)):null;return {total,records:rows.reverse().map(x=>this.presentation(user,JSON.parse(x.payload))),next,watermark,limit};
  }
  presentation(user,record){
    if(!record.messageId||!record.threadId||!record.text)return record;
    if(record.kind==='result'){
      // Look up this event first; a thread/time scan grows with the whole conversation.
      const sent=this.stmt("SELECT payload FROM messages INDEXED BY messages_event WHERE user=? AND message_id=? AND thread_id=? AND kind='outbound' AND time>=? ORDER BY time,id").all(user,record.messageId,record.threadId,record.time).map(x=>JSON.parse(x.payload)).filter(x=>!x.file&&!x.buttons?.length);
      const exact=sent.find(x=>x.text===record.text);
      if(exact)return {...record,mergedInto:exact.recordId};
      const marker='\n（结果较长，完整内容保存在本机配置页。）';
      if(sent.some(x=>{const text=String(x.text||''),part=text.endsWith(marker)?text.slice(0,-marker.length):text;return part&&record.text.startsWith(part)&&part.length<record.text.length;}))return {...record,partialDelivery:true};
    }else if(record.kind==='outbound'&&!record.file&&!record.buttons?.length){
      const result=this.stmt("SELECT payload FROM messages INDEXED BY messages_event WHERE user=? AND message_id=? AND thread_id=? AND kind='result' AND text=? AND time<=? ORDER BY time DESC,id DESC LIMIT 1").get(user,record.messageId,record.threadId,record.text,record.time);
      if(result){const r=JSON.parse(result.payload);return {...record,taskResult:{status:r.status,turnId:r.turnId,completedAt:r.time}};}
    }
    return record;
  }
  watermark(user,thread){return this.stmt('SELECT max(id) AS seq FROM messages WHERE user=?'+(thread!==undefined?' AND thread_id=?':'')).get(...(thread!==undefined?[user,thread]:[user])).seq||0;}
  updates(user,thread,after){if(!Number.isSafeInteger(after)||after<0)throw new Error('消息水位无效');const row=this.stmt('SELECT count(*) AS count,max(id) AS watermark FROM messages WHERE user=? AND thread_id=? AND id>?').get(user,thread,after);return {count:row.count,watermark:row.watermark||after};}
  async exportJSON(user,file,thread){
    this.exportsActive=(this.exportsActive||0)+1;
    const filter=this.criteria(user,thread),max=this.watermark(user,thread),stream=fs.createWriteStream(file,{mode:0o600});let failure,count=0,lastTime='',lastId=0;stream.on('error',err=>{failure=err;});const done=once(stream,'finish');done.catch(()=>{});const write=async text=>{if(failure)throw failure;if(!stream.write(text))await once(stream,'drain');};
    try{await write('[\n');for(;;){const rows=this.stmt(`SELECT m.id,m.time,m.payload FROM messages m WHERE ${filter.where} AND m.id<=? AND (m.time,m.id)>(?,?) ORDER BY m.time,m.id LIMIT 500`).all(...filter.params,max,lastTime,lastId);if(!rows.length)break;for(const row of rows){await write((count?',\n':'')+row.payload);count++;}lastTime=rows.at(-1).time;lastId=rows.at(-1).id;await new Promise(resolve=>setImmediate(resolve));}await write('\n]\n');stream.end();await done;return count;}catch(err){stream.destroy();throw err;}finally{this.exportsActive--;}
  }
  close(){this.db.close();}
}
