const RECEIPT_TTL_MS=86400000;
const RECEIPT_LIMIT=10000;
const MAX_ATTACHMENTS=8;

const array=value=>Array.isArray(value)?value:[];
const sessionKey=e=>JSON.stringify([Boolean(e.group),String(e.chat),String(e.user)]);
const attachmentCount=e=>array(e.attachments).length+array(e.quoted).reduce((n,q)=>n+array(q.attachments).length,0);

/** Collect consecutive QQ messages without starting another model task per attachment. */
export class MessageBatches {
  constructor({delayMs=3000,maxWaitMs=10000,handle,onError=async()=>{},observer=null}={}) {
    if(typeof handle!=='function'||typeof onError!=='function')throw new TypeError('MessageBatches requires handle and onError functions');
    if(!Number.isFinite(delayMs)||delayMs<0||!Number.isFinite(maxWaitMs)||maxWaitMs<0)throw new TypeError('Message batch delays must be finite non-negative numbers');
    this.delayMs=delayMs;this.maxWaitMs=maxWaitMs;this.handle=handle;this.onError=onError;this.observer=observer;
    this.pending=new Map();this.running=new Set();this.receipts=new Map();this.serial=0;
  }
  pendingFor(e) {return this.pending.get(sessionKey(e))?.entries.length||0;}
  busy() {return this.pending.size>0||this.running.size>0;}
  observe(e,details) {
    try {const id=this.observer?.(e,details);if(typeof id==='string')e.taskId=id;}catch{/* Diagnostic storage cannot change input delivery. */}
    return e.taskId;
  }
  push(e) {
    const key=sessionKey(e),now=Date.now();
    this.pruneReceipts(now);
    const receiptKey=e.id==null?null:JSON.stringify([key,String(e.id)]);
    if(receiptKey!==null&&this.receipts.has(receiptKey))return this.receipts.get(receiptKey).promise;
    let resolve;
    const receipt={promise:new Promise(done=>{resolve=done;}),resolve:()=>resolve(),time:now,settled:false};
    if(receiptKey!==null)this.receipts.set(receiptKey,receipt);
    let batch=this.pending.get(key);
    const count=attachmentCount(e);
    if(count+(batch?.attachmentCount||0)>MAX_ATTACHMENTS){
      const err=new Error('连续消息合计最多处理 8 个附件；这条消息未加入已有批次，请减少附件后重发。');
      err.code='ATTACHMENT_LIMIT';
      this.observe(e,{stage:'received'});
      this.observe(e,{stage:'failed',code:'attachment_limit',executionStatus:'failed',deliveryStatus:'not_required'});
      this.running.add(receipt);
      void this.report(e,err).finally(()=>{this.running.delete(receipt);this.settle(receipt);});
      return receipt.promise;
    }
    if(!batch){batch={entries:[],attachmentCount:0,startedAt:now,timer:null};this.pending.set(key,batch);this.observe(e,{stage:'received'});batch.taskId=e.taskId;}
    else if(batch.taskId)e.taskId=batch.taskId;
    batch.entries.push({event:e,receipt,serial:this.serial++});batch.attachmentCount+=count;
    this.observe(e,{stage:'merging'});batch.taskId=e.taskId||batch.taskId;
    if(batch.taskId)for(const entry of batch.entries)entry.event.taskId=batch.taskId;
    clearTimeout(batch.timer);
    const deadline=Math.min(now+this.delayMs,batch.startedAt+this.maxWaitMs);
    batch.timer=setTimeout(()=>{void this.flush(key,batch);},Math.max(0,deadline-now));
    return receipt.promise;
  }
  cancel(e) {
    const key=sessionKey(e),batch=this.pending.get(key);
    if(!batch)return [];
    this.pending.delete(key);clearTimeout(batch.timer);
    this.observe(batch.entries.at(-1).event,{stage:'cancelled',code:'cancelled_before_submit',executionStatus:'cancelled',deliveryStatus:'not_required'});
    for(const entry of batch.entries)this.settle(entry.receipt);
    return batch.entries.map(entry=>entry.event);
  }
  cancelAll() {
    const entries=[];
    for(const batch of this.pending.values()){
      this.observe(batch.entries.at(-1).event,{stage:'cancelled',code:'cancelled_before_submit',executionStatus:'cancelled',deliveryStatus:'not_required'});
      clearTimeout(batch.timer);entries.push(...batch.entries);
      for(const entry of batch.entries)this.settle(entry.receipt);
    }
    this.pending.clear();
    return entries.sort((a,b)=>a.serial-b.serial).map(entry=>entry.event);
  }
  async flush(key,batch) {
    if(this.pending.get(key)!==batch)return;
    // Detach before calling user code: later messages always form another batch.
    this.pending.delete(key);clearTimeout(batch.timer);this.running.add(batch);
    const events=batch.entries.map(entry=>entry.event);
    const combined={...events.at(-1),sourceEvents:events,
      text:events.map(e=>String(e.text||'').replace(/^\/codex(?:\s+|$)/,'').trim()).filter(Boolean).join('\n'),
      attachments:events.flatMap(e=>array(e.attachments)),quoted:events.flatMap(e=>array(e.quoted))};
    this.observe(combined,{stage:'queued'});
    try {await this.handle(combined);}
    catch(err) {this.observe(combined,{stage:'failed',code:'handler_failed',executionStatus:'failed',deliveryStatus:'not_required'});await this.report(combined,err);}
    finally {this.running.delete(batch);for(const entry of batch.entries)this.settle(entry.receipt);}
  }
  async report(e,err) {
    // Error delivery is best effort, and must never retry the original task.
    try {await this.onError(e,err);}catch{}
  }
  settle(receipt) {receipt.settled=true;receipt.resolve();}
  pruneReceipts(now) {
    for(const [key,receipt] of this.receipts){
      if(receipt.settled&&(now-receipt.time>RECEIPT_TTL_MS||this.receipts.size>=RECEIPT_LIMIT))this.receipts.delete(key);
    }
  }
}
