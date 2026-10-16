export const TASK_STAGE_LABELS=Object.freeze({
  received:'已接收',merging:'等待合并消息',queued:'等待处理',preparing:'准备附件',starting:'启动任务',running:'执行中',
  waiting_approval:'等待审批',waiting_input:'等待回答',supplemented:'已补充到当前任务',delivering:'投递结果',
  completed:'已完成',failed:'处理失败',interrupted:'已中断',cancelled:'已取消',uncertain:'状态待确认'
});
export const TASK_EXECUTION_LABELS=Object.freeze({pending:'尚未执行',running:'执行中',awaiting_parent:'等待主任务',completed:'执行完成',failed:'执行失败',interrupted:'执行中断',cancelled:'已取消',unknown:'执行状态待确认'});
export const TASK_DELIVERY_LABELS=Object.freeze({pending:'尚未投递',delivering:'投递中',sent:'已投递',partial:'部分投递',failed:'投递失败',unknown:'投递状态待确认',not_required:'无需投递'});
export const TASK_CODE_LABELS=Object.freeze({
  service_restart:'服务重启，状态需要确认',attachment_limit:'附件数量超出限制',handler_failed:'消息处理失败',initialization_failed:'账号初始化失败',
  cancelled_before_submit:'提交前已取消',process_offline:'执行进程离线',model_changing:'正在切换模型',active_turn_unknown:'当前轮次需要确认',
  prepare_failed:'附件准备失败',start_rejected:'启动请求被拒绝',start_uncertain:'启动结果需要确认',supplement_rejected:'补充请求被拒绝',
  supplement_uncertain:'补充结果需要确认',model_failed:'模型执行失败',model_interrupted:'模型执行中断',reply_rejected:'结果投递被拒绝',
  reply_uncertain:'结果投递需要确认',reply_partial:'结果仅部分投递',reply_truncated:'结果已截断投递',attachment_failed:'附件投递失败',attachment_uncertain:'附件投递需要确认',reply_audit_failed:'投递记录保存失败'
});
export const stageLabel=stage=>TASK_STAGE_LABELS[stage]||TASK_STAGE_LABELS.uncertain;
export const executionLabel=status=>TASK_EXECUTION_LABELS[status]||TASK_EXECUTION_LABELS.unknown;
export const deliveryLabel=status=>TASK_DELIVERY_LABELS[status]||TASK_DELIVERY_LABELS.unknown;
