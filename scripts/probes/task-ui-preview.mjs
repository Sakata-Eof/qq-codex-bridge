import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { History } from '../../src/history/store.mjs';
import { TaskStore } from '../../src/history/task-store.mjs';
import { createHistoryRoutes } from '../../src/http/history-routes.mjs';
import { createTaskRoutes } from '../../src/http/task-routes.mjs';
import { publicDir } from '../../src/paths.mjs';

// An isolated, read-only UI fixture. No production configuration, QQ or Codex is loaded.
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-task-ui-preview-'));
const config = { appId: 'offline-preview', users: ['a', 'b'].map(id => {
  const workspace = path.join(temporary, 'workspace-' + id);
  fs.mkdirSync(workspace);
  return { id: 'demo-' + id, label: '演示账号 ' + id.toUpperCase(), workspace, allowedRoots: [workspace] };
}) };
let tick = 0;
const previewClock = () => new Date(Date.UTC(2026, 9, 16, 8, 0, tick++));
const history = new History(config, temporary), tasks = new TaskStore(history, { clock: previewClock });
const accounts = { userKey: id => id, instances: new Map(), taskTrackingError: new Map() };
const qq = { state: '离线演示：不连接 QQ 或模型' };
function fixture(user, id, title, states) {
  const event = { id, user, chat: user, group: false, text: title, receivedAt: previewClock().toISOString() };
  const task = tasks.ensure(user, event);
  for (const state of states) tasks.record(user, task.id, state);
  return task.id;
}
fixture('demo-a', 'example-complete', '演示：整理项目资料', [
  { stage: 'merging' }, { stage: 'queued' }, { stage: 'preparing' }, { stage: 'starting' },
  { stage: 'running', executionStatus: 'running' }, { stage: 'waiting_approval' }, { stage: 'running' },
  { stage: 'delivering', executionStatus: 'completed', deliveryStatus: 'delivering' },
  { stage: 'completed', executionStatus: 'completed', deliveryStatus: 'sent' },
]);
fixture('demo-a', 'example-uncertain', '演示：执行完成，回复状态待核实', [
  { stage: 'running', executionStatus: 'running' },
  { stage: 'delivering', executionStatus: 'completed', deliveryStatus: 'delivering' },
  { stage: 'uncertain', executionStatus: 'completed', deliveryStatus: 'unknown', code: 'reply_uncertain' },
]);
fixture('demo-b', 'example-failed', '演示：附件准备失败', [
  { stage: 'preparing' }, { stage: 'failed', executionStatus: 'failed', deliveryStatus: 'not_required', code: 'prepare_failed' },
]);
for (const user of config.users) {
  history.record(user.id, { recordId: 'demo-message', kind: 'inbound', messageId: 'demo-message', threadId: 'demo-session', text: '此页面只包含合成演示记录，不执行真实任务。' });
}
function respond(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json;charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
let historyRoutes, taskRoutes;
const assets = new Map([['/history', ['history.html', 'text/html']], ['/history.js', ['history.js', 'text/javascript']], ['/ui-client.js', ['ui-client.js', 'text/javascript']]]);
const server = http.createServer(async (req, res) => {
  try {
    if (req.method !== 'GET') return respond(res, 405, { error: '演示实例只允许读取' });
    if (req.url === '/api/session' || req.url === '/health') return respond(res, 200, { ok: true, mode: 'offline-preview' });
    if (assets.has(req.url)) {
      const [name, type] = assets.get(req.url);
      res.writeHead(200, { 'Content-Type': type + ';charset=utf-8', 'Cache-Control': 'no-store' });
      const content = fs.readFileSync(path.join(publicDir, name));
      return res.end(name === 'history.html' ? content.toString('utf8').replace('<title>QQ Codex · 消息历史</title>', '<title>QQ Codex · 离线任务演示</title>').replace('<h1>QQ Codex · 消息历史</h1>', '<h1>QQ Codex · 离线任务演示</h1>') : content);
    }
    if (await taskRoutes(req, res) || await historyRoutes(req, res)) return;
    respond(res, 404, { error: '演示接口不存在' });
  } catch {
    respond(res, 400, { error: '演示请求无效' });
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
historyRoutes = createHistoryRoutes({ config, accounts, history, qq, base, respond, body: async () => { throw new Error('Read only'); }, exportsRoot: path.join(temporary, 'exports') });
taskRoutes = createTaskRoutes({ config, accounts, tasks, qq, base, respond });
console.log(JSON.stringify({ url: base + '/history', mode: 'offline-preview', productionDataTouched: false, stop: 'Send quit on stdin or Ctrl+C' }));
let closing = false;
function close() {
  if (closing) return;
  closing = true;
  server.closeAllConnections();
  server.close(() => {
    history.close();
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(temporary));
    assert(relative.startsWith('qq-task-ui-preview-') && !relative.includes(path.sep));
    fs.rmSync(temporary, { recursive: true, force: true });
    process.stdin.pause();
  });
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { if (chunk.trim() === 'quit') close(); });
process.on('SIGINT', close);
process.on('SIGTERM', close);
