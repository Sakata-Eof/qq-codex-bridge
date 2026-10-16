import { TASK_CODE_LABELS } from '../core/task-stages.mjs';

const text=(value,max=256)=>typeof value==='string'?value.slice(0,max):'';
const count=value=>Number.isSafeInteger(value)&&value>=0?value:0;
const listLimit=value=>Math.min(30,Math.max(1,Number.isInteger(Number(value))&&Number(value)>0?Number(value):10));

// Keep the HTTP boundary independent of storage internals and raw runtime errors.
function taskDTO(task,events=false){
  const result={};
  for(const key of ['id','user','chat','title','stage','stageLabel','executionStatus','executionLabel','deliveryStatus','deliveryLabel','threadId','turnId','parentTaskId','createdAt','updatedAt'])result[key]=text(task[key],key==='title'?160:256);
  result.group=Boolean(task.group);result.eventCount=count(task.eventCount);
  result.sourceIds=Array.isArray(task.sourceIds)?task.sourceIds.slice(0,100).map(value=>text(value)).filter(Boolean):[];
  if(events)result.events=(Array.isArray(task.events)?task.events:[]).filter(event=>!event.user||event.user===task.user).slice(-100).map(event=>{
    const code=Object.hasOwn(TASK_CODE_LABELS,event.code)?event.code:'';
    return {stage:text(event.stage),label:text(event.label),code,codeLabel:code?TASK_CODE_LABELS[code]:'',createdAt:text(event.createdAt||event.time)};
  });
  return result;
}

function qqSummary(value){
  const state=String(value||'');
  if(/^QQ 在线（(?:READY|RESUMED)）$/.test(state)||['READY','RESUMED'].includes(state))return {state:'online',label:'QQ 已连接'};
  if(state==='正在连接')return {state:'connecting',label:'QQ 正在连接'};
  if(state==='未配置')return {state:'unconfigured',label:'QQ 未配置'};
  if(state==='已停止')return {state:'stopped',label:'QQ 已停止'};
  return {state:'unavailable',label:'QQ 连接异常或尚未就绪'};
}

function diagnosticDTO(user,accounts,qq,latest,extra){
  const instance=accounts.instances?.get(user.id),child=instance?.rpc?.child;
  const process=accounts.starting?.has(user.id)?{state:'starting',label:'账号进程正在启动'}:
    !instance?{state:'not_started',label:'账号进程未启动'}:
    child?.exitCode===null&&!child.killed?{state:'running',label:'账号进程运行中'}:{state:'stopped',label:'账号进程已停止'};
  const problems=[];
  if(latest?.executionStatus==='failed')problems.push('最近任务执行失败，请查看任务阶段');
  if(latest?.executionStatus==='unknown')problems.push('最近任务执行结果不明确，请先核对，勿重复提交');
  if(['failed','partial','unknown'].includes(latest?.deliveryStatus))problems.push(latest.deliveryStatus==='unknown'?'最近结果投递状态不明确，请先核对 QQ 收件，勿重复提交':'最近结果尚未完整投递');
  const degraded=accounts.taskTrackingError?.get?.(user.id)===true||accounts.taskTrackingError===true||extra?.taskRecordingUnavailable===true;
  if(degraded)problems.push('部分任务阶段未能保存');
  return {user:user.id,qq:qqSummary(qq.state),process,tracking:{state:degraded?'degraded':'ok',label:degraded?'部分任务阶段未能保存':'任务记录正常'},model:{state:'unchecked',label:'模型调用未验证；进程或网页可用不代表模型可用'},
    activity:latest?{stage:text(latest.stage),stageLabel:text(latest.stageLabel),executionStatus:text(latest.executionStatus),executionLabel:text(latest.executionLabel),deliveryStatus:text(latest.deliveryStatus),deliveryLabel:text(latest.deliveryLabel),updatedAt:text(latest.updatedAt)}:null,problems};
}

/** Mounted only after the application's Host, Origin and UI authorization checks. */
export function createTaskRoutes({config,tasks,accounts,qq,base,respond,diagnostics}){
  return async function taskRoutes(req,res){
    if(req.method!=='GET')return false;
    const url=new URL(req.url,base),pathname=url.pathname;
    if(pathname!=='/api/tasks'&&pathname!=='/api/diagnostics'&&!/^\/api\/tasks\/[^/]+$/.test(pathname))return false;
    const ids=url.searchParams.getAll('user'),user=ids.length===1?config.users.find(item=>item.id===ids[0]):null;
    if(!user){respond(res,400,{error:'需要指定已绑定账号'});return true;}
    try{
      if(pathname==='/api/tasks'){
        const options={limit:listLimit(url.searchParams.get('limit'))};
        if(url.searchParams.has('thread'))options.thread=url.searchParams.get('thread');
        const rows=await tasks.list(user.id,options);
        respond(res,200,{tasks:rows.filter(task=>task.user===user.id).slice(0,options.limit).map(task=>taskDTO(task))});return true;
      }
      if(pathname==='/api/diagnostics'){
        const rows=await tasks.list(user.id,{limit:1}),latest=rows.find(task=>task.user===user.id);
        const extra=typeof diagnostics==='function'?await diagnostics(user.id):null;
        respond(res,200,diagnosticDTO(user,accounts,qq,latest,extra));return true;
      }
      let id;try{id=decodeURIComponent(pathname.slice('/api/tasks/'.length));}catch{}
      const task=id?await tasks.get(user.id,id,{limit:100}):null;
      if(!task||task.user!==user.id){respond(res,404,{error:'任务不存在'});return true;}
      respond(res,200,{task:taskDTO(task,true)});return true;
    }catch{
      // Never send database paths, RPC errors, config or raw logs to the browser.
      respond(res,503,{error:'任务状态暂时不可用，请稍后重试'});return true;
    }
  };
}
