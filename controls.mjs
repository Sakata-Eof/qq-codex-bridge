export function button(e,id,label,data,confirm=false){
  // C2C user_openid is not accepted as a client keyboard user ID. Authorize
  // the resulting message in Bridge.handle; approvals also require nonce+turn.
  return {id,render_data:{label:label.slice(0,10),visited_label:label.slice(0,10),style:confirm?4:0},action:{type:2,data,enter:!e.group,reply:true,permission:{type:2},...(confirm?{modal:{content:'请阅读请求内容，确认执行本次操作？',confirm_text:'确认',cancel_text:'取消'}}:{})}};
}
export function menu(e){return [
  [button(e,'status','查看状态','/status'),button(e,'context','上下文','/context'),button(e,'result','最近结果','/result')],
  [button(e,'new','新会话','/new',true),button(e,'stop','停止任务','/stop',true),button(e,'models','模型选择','/models')]
];}
export function requestButtons(e,id,q){
  if(q.method.includes('requestApproval')){
    const row=[];if(!q.params.availableDecisions||q.params.availableDecisions.includes('accept'))row.push(button(e,'approve-'+id,'同意本次',`/approve ${id} ${q.nonce}`,true));
    row.push(button(e,'deny-'+id,'拒绝',`/deny ${id} ${q.nonce}`));return [row];
  }
  return (q.params.questions||[]).slice(0,5).map((question,qi)=>(question.options||[]).slice(0,5).map((option,oi)=>button(e,`pick-${id}-${qi}-${oi}`,`${qi+1}.${option.label}`,`/pick ${id} ${q.nonce} ${qi} ${oi}`))).filter(row=>row.length);
}
export function markdownText(text){return String(text).replace(/[<>&]/g,c=>({'<':'＜','>':'＞','&':'＆'}[c])).replace(/([\\`*_{}\[\]()#+!|])/g,'\\$1');}
