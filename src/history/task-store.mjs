import crypto from 'node:crypto';
import {TASK_STAGE_LABELS,TASK_EXECUTION_LABELS,TASK_DELIVERY_LABELS,TASK_CODE_LABELS,stageLabel,executionLabel,deliveryLabel} from '../core/task-stages.mjs';

const terminal=new Set(['completed','failed','interrupted','cancelled','unknown']);
const finalDelivery=new Set(['sent','partial','failed','unknown','not_required']);
const stages=Object.keys(TASK_STAGE_LABELS),executions=Object.keys(TASK_EXECUTION_LABELS),deliveries=Object.keys(TASK_DELIVERY_LABELS);
const controlledLabels=new Set([...Object.values(TASK_STAGE_LABELS),...Object.values(TASK_EXECUTION_LABELS),...Object.values(TASK_DELIVERY_LABELS),...Object.values(TASK_CODE_LABELS)]);
const defaultExecution=stage=>({running:'running',waiting_approval:'running',waiting_input:'running',supplemented:'awaiting_parent',delivering:'completed',completed:'completed',failed:'failed',interrupted:'interrupted',cancelled:'cancelled',uncertain:'unknown'}[stage]||'pending');
const text=value=>String(value??'');
const validId=(value,name)=>{const result=text(value);if(!result||result.length>512)throw new TypeError(`${name}无效`);return result;};
const timestamp=value=>{const date=new Date(value);return Number.isFinite(date.getTime())?date.toISOString():null;};
const limit=(value,fallback,max)=>Math.max(1,Math.min(max,Math.trunc(Number(value)||fallback)));

/** An account-scoped task journal sharing History's connection without changing messages. */
export class TaskStore {
  constructor(history,{clock=()=>new Date()}={}){
    this.history=history;this.clock=clock;
    history.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks(user TEXT NOT NULL,id TEXT NOT NULL,chat TEXT NOT NULL,is_group INTEGER NOT NULL,title TEXT NOT NULL,stage TEXT NOT NULL,execution_status TEXT NOT NULL,delivery_status TEXT NOT NULL,thread_id TEXT,turn_id TEXT,parent_task_id TEXT,follow_parent INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(user,id),FOREIGN KEY(user,parent_task_id) REFERENCES tasks(user,id));
      CREATE INDEX IF NOT EXISTS tasks_recent ON tasks(user,updated_at DESC,id);
      CREATE INDEX IF NOT EXISTS tasks_thread ON tasks(user,thread_id,updated_at DESC,id);
      CREATE INDEX IF NOT EXISTS tasks_chat ON tasks(user,chat,is_group,updated_at DESC,id);
      CREATE INDEX IF NOT EXISTS tasks_parent ON tasks(user,parent_task_id,follow_parent);
      CREATE TABLE IF NOT EXISTS task_events(seq INTEGER PRIMARY KEY,user TEXT NOT NULL,id TEXT NOT NULL,task_id TEXT NOT NULL,time TEXT NOT NULL,stage TEXT NOT NULL,label TEXT NOT NULL,code TEXT NOT NULL,execution_status TEXT NOT NULL,delivery_status TEXT NOT NULL,UNIQUE(user,id),FOREIGN KEY(user,task_id) REFERENCES tasks(user,id));
      CREATE INDEX IF NOT EXISTS task_events_task ON task_events(user,task_id,seq);
      CREATE TABLE IF NOT EXISTS task_sources(user TEXT NOT NULL,chat TEXT NOT NULL,is_group INTEGER NOT NULL,source_id TEXT NOT NULL,task_id TEXT NOT NULL,PRIMARY KEY(user,chat,is_group,source_id),FOREIGN KEY(user,task_id) REFERENCES tasks(user,id));
      CREATE INDEX IF NOT EXISTS task_sources_task ON task_sources(user,task_id);
    `);
  }
  stmt(sql){return this.history.stmt(sql);}
  configuredUsers(){return new Set((this.history.config.users||[]).map(user=>text(user.id)).filter(Boolean));}
  now(){const value=timestamp(this.clock());if(!value)throw new TypeError('任务时钟无效');return value;}
  row(user,id){return this.stmt('SELECT * FROM tasks WHERE user=? AND id=?').get(user,id);}
  ensure(user,event){
    user=validId(user,'账号');if(!this.configuredUsers().has(user))throw new Error('账号未配置');if(!event||typeof event!=='object')throw new TypeError('任务消息无效');
    const chat=validId(event.chat??user,'聊天'),group=Boolean(event.group),sources=Array.isArray(event.sourceEvents)&&event.sourceEvents.length?event.sourceEvents:[event];
    for(const source of [event,...sources]){
      if(source.user!=null&&text(source.user)!==user||source.chat!=null&&text(source.chat)!==chat||Boolean(source.group)!==group)throw new Error('任务源消息不属于同一账号和聊天');
    }
    const task=this.history.transaction(()=>{
      let row;
      const explicit=[event,...sources].map(source=>source.taskId).filter(Boolean).map(String);
      for(const id of new Set(explicit)){
        const found=this.row(user,id);if(!found||found.chat!==chat||Boolean(found.is_group)!==group)throw new Error('任务不存在或不属于当前聊天');
        if(row&&row.id!==found.id)throw new Error('任务源消息已关联不同任务');row=found;
      }
      const ids=[...new Set(sources.filter(source=>source.id!=null).map(source=>validId(source.id,'源消息标识')))];
      for(const id of ids){
        const found=this.stmt('SELECT t.* FROM task_sources s JOIN tasks t ON t.user=s.user AND t.id=s.task_id WHERE s.user=? AND s.chat=? AND s.is_group=? AND s.source_id=?').get(user,chat,Number(group),id);
        if(found&&row&&row.id!==found.id)throw new Error('任务源消息已关联不同任务');if(found)row=found;
      }
      if(!row){
        const times=[event,...sources].filter(source=>source.receivedAt!=null).map(source=>timestamp(source.receivedAt)).filter(Boolean),time=times.sort()[0]||this.now();
        const title=text(event.text||sources.find(source=>source.text)?.text).replace(/^\/codex\s+/,'').replace(/\s+/g,' ').trim().slice(0,80)||'含附件或补充内容的任务';
        const id=crypto.randomUUID();this.stmt('INSERT INTO tasks(user,id,chat,is_group,title,stage,execution_status,delivery_status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(user,id,chat,Number(group),title,'received','pending','pending',time,time);row=this.row(user,id);this.append(row,'','');
      }
      for(const id of ids)this.stmt('INSERT OR IGNORE INTO task_sources(user,chat,is_group,source_id,task_id) VALUES(?,?,?,?,?)').run(user,chat,Number(group),id,row.id);
      return this.dto(row);
    });
    for(const source of [event,...sources])source.taskId=task.id;
    return task;
  }
  record(user,id,entry){
    user=validId(user,'账号');id=validId(id,'任务标识');if(!entry||!stages.includes(entry.stage))throw new TypeError('任务阶段无效');
    if(entry.executionStatus!==undefined&&!executions.includes(entry.executionStatus))throw new TypeError('任务执行状态无效');
    if(entry.deliveryStatus!==undefined&&!deliveries.includes(entry.deliveryStatus))throw new TypeError('任务投递状态无效');
    const row=this.row(user,id);if(!row)return null;
    const desired=entry.executionStatus??defaultExecution(entry.stage);
    // A delayed running/approval notification cannot revive a finished or uncertain task.
    // Only an actual notification tied to this same thread/turn can resolve uncertainty.
    const confirmed=row.execution_status==='unknown'&&entry.confirmed===true&&row.thread_id&&entry.threadId===row.thread_id&&entry.turnId&&(!row.turn_id||entry.turnId===row.turn_id)&&['running','completed','failed','interrupted'].includes(desired);
    if(terminal.has(row.execution_status)&&!confirmed&&(desired!==row.execution_status||(!terminal.has(defaultExecution(entry.stage))&&entry.stage!=='delivering')))return this.dto(row);
    const execution=terminal.has(row.execution_status)&&!confirmed?row.execution_status:desired;
    const delivery=entry.deliveryStatus??(entry.stage==='delivering'?'delivering':row.delivery_status);
    let parent=row.parent_task_id;
    if(entry.parentTaskId!==undefined&&entry.parentTaskId!==null){
      const candidate=this.row(user,validId(entry.parentTaskId,'父任务标识'));
      if(!candidate||candidate.id===id||candidate.chat!==row.chat||candidate.is_group!==row.is_group)throw new Error('父任务不存在或不属于当前聊天');
      if(parent&&parent!==candidate.id)throw new Error('补充任务不能更换父任务');
      let ancestor=candidate;while(ancestor){if(ancestor.id===id)throw new Error('任务不能循环关联');ancestor=ancestor.parent_task_id?this.row(user,ancestor.parent_task_id):null;}
      parent=candidate.id;
    }
    const next={...row,stage:entry.stage,execution_status:execution,delivery_status:delivery,parent_task_id:parent,
      thread_id:entry.threadId===undefined?row.thread_id:this.optionalId(entry.threadId),turn_id:entry.turnId===undefined?row.turn_id:this.optionalId(entry.turnId),
      follow_parent:entry.stage==='supplemented'&&execution==='awaiting_parent'&&parent?1:0};
    const code=Object.hasOwn(TASK_CODE_LABELS,entry.code)?entry.code:'',label=controlledLabels.has(entry.label)?entry.label:stageLabel(next.stage);
    // Keep frequent duplicate tool notifications out of SQLite's write transaction entirely.
    if(this.sameState(row,next)&&this.sameEvent(next,label,code))return this.dto(row);
    return this.history.transaction(()=>{
      next.updated_at=this.later(row);
      this.save(next);this.append(next,label,code);this.propagate(next);
      if(next.follow_parent)this.follow(next,this.row(user,parent));
      return this.dto(this.row(user,id));
    });
  }
  optionalId(value){return value==null||value===''?null:validId(value,'关联标识');}
  later(row){return [row.updated_at,this.now()].sort().at(-1);}
  save(row){
    this.stmt('UPDATE tasks SET stage=?,execution_status=?,delivery_status=?,thread_id=?,turn_id=?,parent_task_id=?,follow_parent=?,updated_at=? WHERE user=? AND id=?').run(row.stage,row.execution_status,row.delivery_status,row.thread_id,row.turn_id,row.parent_task_id,row.follow_parent,row.updated_at,row.user,row.id);
  }
  sameState(first,second){return ['stage','execution_status','delivery_status','thread_id','turn_id','parent_task_id','follow_parent'].every(key=>first[key]===second[key]);}
  sameEvent(row,label,code){
    const previous=this.stmt('SELECT stage,label,code,execution_status,delivery_status FROM task_events WHERE user=? AND task_id=? ORDER BY seq DESC LIMIT 1').get(row.user,row.id);
    return Boolean(previous&&previous.stage===row.stage&&previous.label===label&&previous.code===code&&previous.execution_status===row.execution_status&&previous.delivery_status===row.delivery_status);
  }
  append(row,label,code){
    label=label||stageLabel(row.stage);
    if(this.sameEvent(row,label,code))return;
    this.stmt('INSERT INTO task_events(user,id,task_id,time,stage,label,code,execution_status,delivery_status) VALUES(?,?,?,?,?,?,?,?,?)').run(row.user,crypto.randomUUID(),row.id,row.updated_at,row.stage,label,code,row.execution_status,row.delivery_status);
  }
  propagate(parent){
    const children=this.stmt('SELECT * FROM tasks WHERE user=? AND parent_task_id=? AND follow_parent=1').all(parent.user,parent.id);
    for(const child of children)this.follow(child,parent);
  }
  follow(child,parent){
    if(!parent||!child.follow_parent)return;
    let stage='supplemented',execution='awaiting_parent',delivery='pending';
    if(terminal.has(parent.execution_status)){
      execution=parent.execution_status;delivery=parent.delivery_status;
      stage=execution==='unknown'?'uncertain':execution;
      if(execution==='completed'&&parent.stage==='delivering')stage='delivering';
      if(parent.stage==='uncertain')stage='uncertain';
    }
    const next={...child,stage,execution_status:execution,delivery_status:delivery,thread_id:parent.thread_id||child.thread_id,turn_id:parent.turn_id||child.turn_id,updated_at:this.later(child)};
    this.save(next);this.append(next,stageLabel(stage),'');this.propagate(next);
  }
  list(user,{limit:requested=10,thread,chat,group}={}){
    user=validId(user,'账号');const where=['user=?'],params=[user];
    if(thread!==undefined){where.push('thread_id=?');params.push(text(thread));}
    if(chat!==undefined){where.push('chat=?');params.push(text(chat));}
    if(group!==undefined){where.push('is_group=?');params.push(Number(Boolean(group)));}
    return this.stmt(`SELECT * FROM tasks WHERE ${where.join(' AND ')} ORDER BY updated_at DESC,created_at DESC,id DESC LIMIT ?`).all(...params,limit(requested,10,100)).map(row=>this.dto(row));
  }
  get(user,id,{limit:requested=100}={}){
    user=validId(user,'账号');id=validId(id,'任务标识');const row=this.row(user,id);if(!row)return null;
    const events=this.stmt('SELECT * FROM (SELECT * FROM task_events WHERE user=? AND task_id=? ORDER BY seq DESC LIMIT ?) ORDER BY seq').all(user,id,limit(requested,100,500)).map(event=>({id:event.id,user:event.user,taskId:event.task_id,time:event.time,stage:event.stage,stageLabel:stageLabel(event.stage),label:event.label,code:event.code,codeLabel:TASK_CODE_LABELS[event.code]||'',executionStatus:event.execution_status,executionLabel:executionLabel(event.execution_status),deliveryStatus:event.delivery_status,deliveryLabel:deliveryLabel(event.delivery_status)}));
    return {...this.dto(row),events};
  }
  dto(row){
    return {id:row.id,user:row.user,chat:row.chat,group:Boolean(row.is_group),title:row.title,stage:row.stage,stageLabel:stageLabel(row.stage),executionStatus:row.execution_status,executionLabel:executionLabel(row.execution_status),deliveryStatus:row.delivery_status,deliveryLabel:deliveryLabel(row.delivery_status),threadId:row.thread_id,turnId:row.turn_id,parentTaskId:row.parent_task_id,createdAt:row.created_at,updatedAt:row.updated_at,
      sourceIds:this.stmt('SELECT source_id FROM task_sources WHERE user=? AND task_id=? ORDER BY rowid').all(row.user,row.id).map(source=>source.source_id),eventCount:this.stmt('SELECT count(*) AS count FROM task_events WHERE user=? AND task_id=?').get(row.user,row.id).count};
  }
  recoverPending(){
    let count=0;
    this.history.transaction(()=>{for(const user of this.configuredUsers()){
      const rows=this.stmt('SELECT * FROM tasks WHERE user=?').all(user);
      for(const row of rows){
        if(terminal.has(row.execution_status)&&finalDelivery.has(row.delivery_status))continue;
        if(row.stage==='uncertain'&&row.delivery_status==='unknown')continue;
        const next={...row,stage:'uncertain',execution_status:terminal.has(row.execution_status)?row.execution_status:'unknown',delivery_status:finalDelivery.has(row.delivery_status)?row.delivery_status:'unknown',follow_parent:0,updated_at:this.later(row)};
        this.save(next);this.append(next,stageLabel(next.stage),'service_restart');count++;
      }
    }});return count;
  }
  summary(user,{chat,group}={}){
    const tasks=this.list(user,{limit:3,chat,group});if(!tasks.length)return '最近任务：暂无记录。';
    return '最近任务：\n'+tasks.map(task=>`${task.id.slice(0,8)} · ${task.stageLabel} · ${task.executionLabel} · ${task.deliveryLabel}`).join('\n');
  }
}
