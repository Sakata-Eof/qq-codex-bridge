export const COMMANDS=[
  ['/model','查看或切换当前账号模型'],['/models','打开模型选择按钮'],
  ['/help','查看全部指令'],['/buttons','打开按钮菜单'],['/status','查看任务状态'],['/context','查看上下文和压缩'],['/result','取回最近结果'],['/stop','停止当前任务'],['/new','开始独立新会话'],
  ['/memory','查看全局和个人记忆'],['/remember','后接内容，保存个人记忆'],['/forget','后接编号，删除个人记忆'],['/project','后接绝对路径，切换项目'],['/file','后接绝对路径，发送文件'],['/voice','后接文字，生成语音'],['/media-test','测试文件图片音频回传'],['/approve','后接编号，同意本次审批'],['/deny','后接编号，拒绝审批'],['/answer','后接编号和回答，多题用 |']
];
const HIDDEN_COMMANDS=new Set(['/file','/voice','/media-test','/forget','/approve','/deny','/answer']);
export const PUBLIC_COMMANDS=COMMANDS.filter(([name])=>!HIDDEN_COMMANDS.has(name));
export const HELP='直接在 QQ 发送文字、图片、语音、视频或文件即可调用本机 Codex。需要回传时可以说“把生成的文件发给我”或“用语音回复”。\n'+PUBLIC_COMMANDS.map(([name,desc])=>`${name} ${desc}`).join('\n')+'\n审批或询问出现时点击相应按钮。每个账号使用独立的会话、审批和工作目录。';
export const COMMAND_USAGE={
  '/file':'请在指令后填写你项目内文件的绝对路径：\n/file C:\\你的项目\\文件名.png\n也可以直接告诉 Codex“把刚生成的文件发给我”。',
  '/send':'请在 /send 后填写你项目内文件的绝对路径；它与 /file 用法相同。',
  '/voice':'请在指令后写要朗读的文字，例如：\n/voice 你好，这是语音回复。',
  '/project':'请在 /project 后填写属于你账号的项目目录绝对路径。',
  '/remember':'请在 /remember 后写要保存的个人记忆，例如：\n/remember 回复时先给结论。',
  '/forget':'请先用 /memory 查看记忆编号，再发送 /forget 编号。',
  '/approve':'审批出现后，请点击“同意本次”，或发送 /approve 审批编号。',
  '/deny':'审批出现后，请点击“拒绝”，或发送 /deny 审批编号。',
  '/answer':'询问出现后，请点击选项，或发送 /answer 编号 回答；多题用 | 分隔。'
};
export const PANEL_REMARK='qq-codex-bridge:commands:v1';
export const QUICK_MENU=[
  {type:'menu',name:'Codex',sub_menu_items:[['帮助','/help'],['模型选择','/models'],['任务状态','/status'],['上下文','/context'],['最近结果','/result']].map(([name,send_message])=>({type:'send_message',name,send_message}))},
  {type:'menu',name:'会话记忆',sub_menu_items:[['停止任务','/stop'],['新会话','/new'],['切换项目','/project '],['查看记忆','/memory'],['保存记忆','/remember ']].map(([name,send_message])=>({type:'send_message',name,send_message}))}
];
const RETIRED_MENU=[
  {type:'menu',name:'Codex',sub_menu_items:[['帮助','/help'],['按钮菜单','/buttons'],['任务状态','/status'],['上下文','/context'],['最近结果','/result']].map(([name,send_message])=>({type:'send_message',name,send_message}))},
  {type:'menu',name:'文件音频',sub_menu_items:[['发送文件','/file '],['生成语音','/voice '],['回传测试','/media-test'],['删除记忆','/forget ']].map(([name,send_message])=>({type:'send_message',name,send_message}))}
];
export async function syncQuickMenu(qq){
  const raw=await qq.api('/v2/menu'),current=raw.data||raw,original=current.menu?.items||[];if(!Array.isArray(original))throw new Error('QQ 快捷菜单格式异常');
  const existing=original.filter(item=>!RETIRED_MENU.some(x=>menuSignature(x)===menuSignature(item)));
  const additions=QUICK_MENU.filter(item=>!existing.some(x=>menuSignature(x)===menuSignature(item)));
  if(additions.some(item=>existing.some(x=>x.name===item.name)))throw new Error('已有同名快捷菜单，保留原配置；请在本机整理同名项');
  if(existing.length+additions.length>10)throw new Error('保留原菜单后超过 QQ 10 项上限，未覆盖');
  const changed=additions.length||existing.length!==original.length;
  if(changed)await qq.api('/v2/menu',{menu:{items:[...existing,...additions]}},'PUT');
  const after=await qq.api('/v2/menu'),actual=(after.data||after).menu?.items||[];
  if(QUICK_MENU.some(item=>!actual.some(x=>menuSignature(x)===menuSignature(item))))throw new Error('QQ 快捷菜单回读校验失败');
  if(actual.some(item=>RETIRED_MENU.some(x=>menuSignature(x)===menuSignature(item))))throw new Error('QQ 底部旧媒体菜单仍未移除');
  return {ok:true,action:changed?'updated':'unchanged',groups:QUICK_MENU.map(x=>x.name),preserved:existing.filter(item=>!QUICK_MENU.some(x=>menuSignature(x)===menuSignature(item))).length};
}
function menuSignature(item){return JSON.stringify({type:item.type,name:item.name,send_message:(item.send_message||'').trim(),sub_menu_items:item.sub_menu_items?.map(x=>({type:x.type,name:x.name,send_message:(x.send_message||'').trim(),link:x.link||''})),link:item.link||'',switch:item.switch});}
export async function syncCommands(qq){
  const records=[];let cursor='';const seen=new Set();
  do{
    const page=await qq.api('/v2/panels?'+new URLSearchParams({scope:'c2c',limit:'50',...(cursor?{cursor}:{})}));
    const data=page.data||page;const entries=data.records===undefined&&data.is_end===true?[]:data.records;if(!Array.isArray(entries))throw new Error('QQ 指令面板列表格式异常');records.push(...entries);
    if(data.is_end||!data.next_cursor)break;cursor=data.next_cursor;if(seen.has(cursor))throw new Error('QQ 面板分页游标重复');seen.add(cursor);
  }while(records.length<1000);
  const owned=records.filter(x=>x.panel?.remark===PANEL_REMARK&&x.scope==='c2c');
  if(owned.length>1)throw new Error('存在多个 Codex 指令面板，需要在本机整理后再同步');
  let current=owned[0];
  if(current){const detail=await qq.api('/v2/panels/'+encodeURIComponent(current.panel_id));current=detail.data||detail;if(current.scope!=='c2c'||current.target_type!=='all'||current.panel?.remark!==PANEL_REMARK)throw new Error('Codex 面板配置已改变，未覆盖');}
  // QQ canonicalizes command names by removing the leading slash on write.
  const names=new Set(COMMANDS.map(([name])=>name.slice(1)));
  const custom=(current?.panel?.items||[]).filter(item=>item.type!=='command'||!names.has(String(item.name).replace(/^\//,'')));
  const items=[...PUBLIC_COMMANDS.map(([name,desc])=>({type:'command',name:name.slice(1),desc,only_admin:false})),...custom];
  if(items.length>20)throw new Error('保留自定义条目后超过 QQ 单面板 20 项上限，未覆盖');
  const panel={items,remark:PANEL_REMARK};let action='unchanged',id=current?.panel_id;
  if(!current){const created=await qq.api('/v2/panels',{scope:'c2c',target_type:'all',panel});id=(created.data||created).panel_id;if(!id)throw new Error('QQ 创建响应未返回面板 ID；请重新查询，勿盲目重复创建');action='created';}
  else if(JSON.stringify((current.panel.items||[]).map(normalizeItem))!==JSON.stringify(items.map(normalizeItem))){await qq.api('/v2/panels/'+encodeURIComponent(id),{panel},'PUT');action='updated';}
  const result=await qq.api('/v2/panels/'+encodeURIComponent(id)),verified=result.data||result;
  if(verified.scope!=='c2c'||verified.target_type!=='all'||verified.panel?.remark!==PANEL_REMARK||PUBLIC_COMMANDS.some(([name])=>!verified.panel.items?.some(item=>item.type==='command'&&String(item.name).replace(/^\//,'')===name.slice(1)))||verified.panel.items?.some(item=>item.type==='command'&&HIDDEN_COMMANDS.has('/'+String(item.name).replace(/^\//,''))))throw new Error('QQ 回读面板未通过指令核对');
  return {ok:true,action,panelId:id,count:PUBLIC_COMMANDS.length,custom:custom.length,preservedPanels:records.length-owned.length,time:new Date().toISOString()};
}
function normalizeItem(item){return {type:item.type,name:item.type==='command'?String(item.name||'').replace(/^\//,''):item.name||'',desc:item.desc||'',only_admin:Boolean(item.only_admin),link:item.link||''};}
