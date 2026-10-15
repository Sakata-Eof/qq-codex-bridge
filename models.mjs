export class Models {
  constructor(rpc,user,persist,busy=()=>false){this.rpc=rpc;this.user=user;this.persist=persist;this.busy=busy;this.changing=false;}
  async init(){const r=await this.rpc.call('config/read',{includeLayers:false,cwd:this.user.workspace});this.defaults={model:r.config?.model,effort:r.config?.model_reasoning_effort};return this;}
  current(){return {model:this.user.model||this.defaults?.model||null,effort:this.user.reasoningEffort||this.defaults?.effort||null,inherited:!this.user.model};}
  async list(force=false){
    if(!force&&this.catalog&&Date.now()-this.catalogAt<60000)return this.catalog;
    const data=[],seen=new Set();let cursor;
    do{const r=await this.rpc.call('model/list',{limit:100,includeHidden:false,...(cursor?{cursor}:{})});data.push(...r.data);cursor=r.nextCursor;if(cursor&&seen.has(cursor))throw new Error('模型列表游标重复');seen.add(cursor);}while(cursor);
    this.catalog=data.filter(m=>!m.hidden).map(m=>({model:m.model,name:m.displayName,efforts:m.supportedReasoningEfforts.map(x=>x.reasoningEffort),defaultEffort:m.defaultReasoningEffort,inputModalities:m.inputModalities||['text','image']}));this.catalogAt=Date.now();return this.catalog;
  }
  async change(model,effort){
    if(this.changing||this.busy())throw new Error('任务正在执行或发送结果，请结束后再切换模型。');this.changing=true;
    const previous={model:this.user.model,effort:this.user.reasoningEffort};
    try{
      if(model==='default'){if(effort)throw new Error('恢复默认时不需要推理强度');await this.init();delete this.user.model;delete this.user.reasoningEffort;}
      else{const entry=(await this.list()).find(x=>x.model===model);if(!entry)throw new Error('模型不在本机 Codex 列表中，请用 /models 查看。');const target=effort||(entry.efforts.includes(this.current().effort)?this.current().effort:entry.defaultEffort);if(!entry.efforts.includes(target))throw new Error('该模型支持的推理强度：'+entry.efforts.join('、'));this.user.model=entry.model;this.user.reasoningEffort=target;}
      try{this.persist();}catch(err){if(previous.model===undefined)delete this.user.model;else this.user.model=previous.model;if(previous.effort===undefined)delete this.user.reasoningEffort;else this.user.reasoningEffort=previous.effort;throw err;}
      return this.current();
    }finally{this.changing=false;}
  }
  params(){const c=this.current();return {...(c.model?{model:c.model}:{}),...(c.effort?{effort:c.effort}:{})};}
  async validateInput(input){if(input.some(x=>x.type==='localImage'||x.type==='image')){const m=(await this.list()).find(x=>x.model===this.current().model);if(m&&!m.inputModalities.includes('image'))throw new Error('当前模型仅支持文字，请用 /models 切换支持图片的模型后重发。');}}
}
