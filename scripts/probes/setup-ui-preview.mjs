import fs from 'node:fs';
import http from 'node:http';
import readline from 'node:readline';

// In-memory fixtures only: never load app.mjs, runtime configuration, QQ or Codex.
const publicDirectory = new URL('../../public/', import.meta.url);
const scenarios = new Set(['ready', 'empty', 'error', 'auth', 'long']);
let scenario = 'ready';
let entrySequence = 0;
function fixture(empty = false, long = false) {
  const users = empty ? [] : ['personal', 'work'].map((name, index) => ({
    id: 'demo-' + name,
    label: index ? '工作账号' : '主账号',
    workspace: long ? `C:\\Demo\\projects\\${'示例项目资料与界面改版\\'.repeat(6)}${name}` : `C:\\Demo\\projects\\${name}`,
    process: index ? null : '演示进程 2048',
    model: { model: index ? 'Codex 配置默认' : 'demo-codex', effort: 'high', inherited: Boolean(index) },
    sessions: index ? [] : [{ status: '空闲', cwd: 'C:\\Demo\\projects\\personal', model: 'demo-codex', effort: 'high', last: '演示任务已完成：整理项目目录，生成本地检查清单。' }],
  }));
  const memories = new Map(users.map((user, index) => [user.id, {
    user: user.id,
    revision: 'demo-1',
    automatic: { enabled: index === 0, reviewEveryTurns: 10 },
    entries: index ? [] : [{
      id: 'demo-preference', text: '优先使用中文说明，涉及代码时保留 API 和文件名的原文。', origin: 'manual', category: 'preference', created: '2026-10-27T01:30:00Z',
    }, {
      id: 'demo-lesson', text: long ? '修改界面时先检查加载、失败和恢复状态；保留编辑中的草稿。'.repeat(12) : '修改界面后检查桌面和手机布局，并保留未保存的编辑草稿。',
      origin: 'automatic', category: 'lesson', created: '2026-10-27T02:00:00Z', evidence: '这是虚构的演示依据，只用于检查折叠内容和排版。', source: { messageId: 'demo-message-001' },
    }],
  }]));
  const conversations = new Map(users.map((user, accountIndex) => [user.id, Array.from({ length: long ? 35 : accountIndex ? 2 : 3 }, (_, index) => {
    const id = `${user.id}-session-${index + 1}`;
    const titles = accountIndex ? ['项目文档整理', '每周工作清单'] : ['管理控制台界面优化', '本机环境检查', '图片与文件回传'];
    const messages = [
      { kind: 'inbound', text: accountIndex ? '帮我整理项目的开发文档，让新同事能快速上手。' : '把管理页面和消息历史放到一起，整体看起来更统一。' },
      { kind: 'outbound', text: accountIndex ? '我会先梳理安装、开发和维护入口，再整理成清楚的操作顺序。' : '我会让消息历史沿用控制台导航，统一账号列表、会话和对话区域的样式。搜索、导出与任务阶段仍然保留。' },
      { kind: 'inbound', text: '手机上也要好用，切换账号时不要出现上一位账号的内容。' },
      { kind: 'outbound', text: '已经把检查拆成三部分：\n• 桌面与手机布局\n• 账号与会话切换\n• 加载失败、恢复和过期响应\n\n切换期间会锁定历史导航，读取完成后再恢复操作。' },
      { kind: 'assets', text: '界面草图与检查说明（合成示例）', files: [{ path: `C:\\Demo\\assets\\${user.id}\\layout-preview.svg`, name: 'layout-preview.svg' }, { path: `C:\\Demo\\assets\\${user.id}\\design-notes.txt`, name: 'design-notes.txt' }] },
      { kind: 'error', text: '演示：附件投递状态待核实。请先核对收件结果，勿重复提交。' },
      { kind: 'inbound', text: '先保留草稿，再验证断线恢复，不要自动重新发送。' },
      { kind: 'outbound', text: '已保留未保存内容。接下来检查搜索和分页，再用离线示例验证恢复过程。', taskResult: true },
    ];
    if (long) messages.push(...Array.from({ length: 64 }, (_, row) => ({ kind: row % 2 ? 'outbound' : 'inbound', text: row % 2 ? `检查记录 ${row + 1}：界面元素正常，账号边界与加载状态保持一致。` : `检查清单 ${row + 1}：确认会话、搜索与分页的显示结果。` })));
    const records = messages.map((message, row) => ({ ...message, recordId: `${id}-message-${row + 1}`, user: user.id, threadId: id, sequence: row + 1, time: new Date(Date.UTC(2026, 9, 27 - index, 2, row * 2)).toISOString() }));
    return { id, title: titles[index] || `界面检查与资料整理 ${index + 1}`, createdAt: records[0].time, lastAt: records.at(-1).time, count: records.length, records };
  })]));
  const tasks = new Map(users.map((user, index) => [user.id, [false, true].map((uncertain, order) => ({
    id: `${user.id}-task-${order + 1}`, user: user.id, chat: user.id, title: uncertain ? '附件回传状态核对' : index ? '整理项目开发文档' : '统一控制台与消息历史',
    threadId: `${user.id}-session-1`, group: false, stage: uncertain ? 'uncertain' : 'completed', stageLabel: uncertain ? '状态待确认' : '执行完成',
    executionStatus: 'completed', executionLabel: '已完成', deliveryStatus: uncertain ? 'unknown' : 'sent', deliveryLabel: uncertain ? '待核实' : '已投递',
    createdAt: '2026-10-27T02:00:00.000Z', updatedAt: '2026-10-27T02:04:00.000Z', eventCount: 4, sourceIds: [`${user.id}-message-1`],
    events: [
      { stage: 'queued', label: '等待执行', createdAt: '2026-10-27T02:00:00.000Z' },
      { stage: 'running', label: '正在执行', createdAt: '2026-10-27T02:01:00.000Z' },
      { stage: 'delivering', label: '正在投递', createdAt: '2026-10-27T02:03:00.000Z' },
      { stage: uncertain ? 'uncertain' : 'completed', label: uncertain ? '状态待确认' : '执行完成', code: uncertain ? 'reply_uncertain' : '', codeLabel: uncertain ? '结果投递需要确认' : '', createdAt: '2026-10-27T02:04:00.000Z' },
    ],
  }))]));
  return {
    status: {
      appId: empty ? '' : '1000000000', secretConfigured: !empty, sandbox: false,
      qq: empty ? '未配置' : 'QQ 在线（READY）', codex: '已登录；每个 QQ 账号独立启动 Codex 进程',
      commands: { ok: !empty, count: 14, preservedPanels: 0, time: '2026-10-27T02:00:00Z', quickMenu: { ok: true, groups: ['任务', '会话', '工具'] }, message: '等待 QQ 连接' },
      users, pairingCodes: [], globalMemory: empty ? '' : '使用中文交流。先检查现有状态，再进行修改；完成后说明验证结果。',
      rotationTurns: 40, idleHours: 6,
      multimodal: '图片直接输入；语音转写；视频抽样画面与音轨；文件读取与富媒体返回',
      logs: empty ? [] : [
        '2026-10-27T02:00:00.000Z [演示] 本机管理服务已启动；全部数据为合成示例',
        '2026-10-27T02:00:01.000Z [演示] Codex 登录状态检查完成',
        '2026-10-27T02:00:02.000Z [演示] QQ 网关 READY；未连接真实 QQ',
        '2026-10-27T02:00:03.000Z [演示] 已同步 14 个 QQ 指令',
        ...(long ? Array.from({ length: 20 }, (_, i) => `2026-10-27T02:01:${String(i).padStart(2, '0')}.000Z [演示] 很长的文件路径 C:\\Demo\\${'example-project\\'.repeat(12)}report-${i}.md`) : []),
      ],
    }, memories, conversations, tasks,
  };
}
let data = fixture();
function setScenario(value, reset = false) {
  if (!scenarios.has(value)) throw new Error('场景应为 ready、empty、error、auth 或 long');
  scenario = value;
  if (reset || value === 'empty' || value === 'long') data = fixture(value === 'empty', value === 'long');
}
const requestedScenario = process.argv.find(arg => arg.startsWith('--scenario='))?.split('=')[1];
if (requestedScenario) setScenario(requestedScenario, true);
function respond(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json;charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
async function requestBody(req) {
  let input = '';
  for await (const chunk of req) {
    input += chunk;
    if (input.length > 65536) throw new Error('演示请求过长');
  }
  return JSON.parse(input || '{}');
}
function memoryFor(user) {
  const memory = data.memories.get(user);
  if (!memory) throw new Error('演示账号不存在');
  return memory;
}
function conversationsFor(user) {
  const conversations = data.conversations.get(user);
  if (!conversations) throw new Error('演示账号不存在');
  return conversations;
}
const encodeCursor = (time, id) => Buffer.from(JSON.stringify([time, id])).toString('base64url');
function decodeCursor(value) {
  try {
    const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!Array.isArray(cursor) || cursor.length !== 2 || typeof cursor[0] !== 'string' || !['number', 'string'].includes(typeof cursor[1])) throw new Error();
    return cursor;
  } catch { throw new Error('演示分页游标无效'); }
}
const pageLimit = value => Math.max(1, Math.min(100, Number(value) || 30));
function historyPage(query) {
  const conversations = conversationsFor(query.get('user'));
  const conversation = conversations.find(item => item.id === query.get('thread'));
  const records = conversation?.records || [], search = String(query.get('q') || '').slice(0, 200);
  const matching = records.filter(record => !search || record.text.includes(search));
  const limit = pageLimit(query.get('limit')), before = query.get('before') ? decodeCursor(query.get('before')) : null;
  const rows = matching.filter(record => !before || record.time < before[0] || record.time === before[0] && record.sequence < before[1]).slice().reverse();
  const selected = rows.slice(0, limit), last = selected.at(-1);
  return { records: selected.reverse(), total: matching.length, watermark: records.length, next: rows.length > limit ? encodeCursor(last.time, last.sequence) : null, limit };
}
const assets = new Map([
  ['/', ['setup.html', 'text/html']], ['/history', ['setup.html', 'text/html']], ['/setup.js', ['setup.js', 'text/javascript']], ['/history.js', ['history.js', 'text/javascript']], ['/ui-client.js', ['ui-client.js', 'text/javascript']],
]);
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'unsafe-inline'; img-src 'self' blob:; frame-ancestors 'none'; form-action 'self'");
    if (req.method === 'GET' && assets.has(url.pathname)) {
      if (['/', '/history'].includes(url.pathname) && url.searchParams.has('scenario')) setScenario(url.searchParams.get('scenario'), true);
      const [name, type] = assets.get(url.pathname);
      let content = fs.readFileSync(new URL(name, publicDirectory), 'utf8');
      if (name === 'setup.html') content = content.replace('<!-- HISTORY_WORKSPACE -->', () => fs.readFileSync(new URL('history.html', publicDirectory), 'utf8')).replace(/<title>[^<]*<\/title>/, '<title>QQ Codex · 控制台离线预览</title>');
      res.writeHead(200, { 'Content-Type': `${type};charset=utf-8` });
      return res.end(content);
    }
    if (url.pathname === '/health') return respond(res, 200, { ok: true, mode: 'offline-preview', scenario, productionDataTouched: false });
    if (url.pathname === '/api/session') return respond(res, scenario === 'auth' ? 403 : 200, { ok: scenario !== 'auth' });
    if (url.pathname.startsWith('/api/') && scenario === 'auth') return respond(res, 403, { error: '演示：登录已失效' });
    if (url.pathname.startsWith('/api/') && scenario === 'error') return respond(res, 503, { error: '演示：本机服务暂时不可用；输入 ready 可恢复连接' });
    if (req.method === 'GET' && url.pathname === '/api/status') return respond(res, 200, data.status);
    if (req.method === 'GET' && url.pathname === '/api/history/accounts') return respond(res, 200, { qq: data.status.qq, storage: '离线合成示例', users: data.status.users.map(({ id, label }) => ({ id, label })) });
    if (req.method === 'GET' && url.pathname === '/api/history/sessions') {
      const conversations = conversationsFor(url.searchParams.get('user')), before = url.searchParams.get('before') ? decodeCursor(url.searchParams.get('before')) : null, limit = pageLimit(url.searchParams.get('limit'));
      const rows = conversations.filter(item => !before || item.lastAt < before[0] || item.lastAt === before[0] && item.id > before[1]), selected = rows.slice(0, limit), last = selected.at(-1);
      return respond(res, 200, { sessions: selected.map(({ records, ...item }) => item), next: rows.length > limit ? encodeCursor(last.lastAt, last.id) : null });
    }
    if (req.method === 'GET' && url.pathname === '/api/history') return respond(res, 200, historyPage(url.searchParams));
    if (req.method === 'GET' && url.pathname === '/api/history/updates') {
      const conversation = conversationsFor(url.searchParams.get('user')).find(item => item.id === url.searchParams.get('thread'));
      const after = Number(url.searchParams.get('after') || 0);
      return respond(res, 200, { count: (conversation?.records || []).filter(record => record.sequence > after).length, watermark: conversation?.records.length || after });
    }
    if (req.method === 'GET' && (['/api/tasks', '/api/diagnostics'].includes(url.pathname) || url.pathname.startsWith('/api/tasks/'))) {
      const user = url.searchParams.get('user');conversationsFor(user);
      if (url.pathname === '/api/tasks') return respond(res, 200, { tasks: data.tasks.get(user).filter(task => !url.searchParams.has('thread') || task.threadId === url.searchParams.get('thread')).slice(0, pageLimit(url.searchParams.get('limit'))).map(({ events, ...task }) => task) });
      if (url.pathname === '/api/diagnostics') return respond(res, 200, { user, qq: { label: 'QQ 已连接（离线示例）' }, process: { label: '演示账号进程空闲' }, tracking: { label: '任务记录正常' }, model: { label: '未调用真实模型' }, problems: [] });
      const task = data.tasks.get(user).find(task => task.id === decodeURIComponent(url.pathname.slice('/api/tasks/'.length)));
      return respond(res, task ? 200 : 404, task ? { task } : { error: '演示任务不存在' });
    }
    if (req.method === 'GET' && url.pathname === '/api/asset') {
      const user = url.searchParams.get('user'), file = url.searchParams.get('file');conversationsFor(user);
      const prefix = `C:\\Demo\\assets\\${user}\\`;
      if (file !== prefix + 'layout-preview.svg' && file !== prefix + 'design-notes.txt') throw new Error('不是当前演示账号的合成附件');
      const image = file.endsWith('.svg');
      res.writeHead(200, { 'Content-Type': image ? 'image/svg+xml' : 'text/plain;charset=utf-8' });
      return res.end(image ? '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="300" viewBox="0 0 640 300"><rect width="640" height="300" rx="16" fill="#f3f6fb"/><rect x="20" y="20" width="130" height="260" rx="10" fill="#dfe7fb"/><rect x="175" y="20" width="445" height="42" rx="8" fill="#fff"/><rect x="175" y="82" width="150" height="198" rx="10" fill="#fff"/><rect x="345" y="82" width="275" height="198" rx="10" fill="#fff"/><path d="M365 120h210M365 150h160M365 180h210M365 210h180" stroke="#a8bce9" stroke-width="8" stroke-linecap="round"/></svg>' : '离线合成示例：统一导航、账号与会话边界、搜索分页、失败恢复。未读取真实文件。');
    }
    if (req.method === 'GET' && url.pathname === '/api/memory/private') return respond(res, 200, memoryFor(url.searchParams.get('user')));
    if (req.method === 'GET' && url.pathname === '/api/models') {
      const user = data.status.users.find(user => user.id === url.searchParams.get('user'));
      if (!user) throw new Error('演示账号不存在');
      return respond(res, 200, { current: user.model, models: [
        { model: 'demo-codex', name: 'Codex 演示模型', inputModalities: ['text', 'image'], efforts: ['low', 'medium', 'high'], defaultEffort: 'high' },
        { model: 'demo-text', name: '文字演示模型', inputModalities: ['text'], efforts: ['medium', 'high'], defaultEffort: 'medium' },
      ] });
    }
    if (req.method === 'POST') {
      const input = await requestBody(req);
      if (url.pathname === '/api/history/title') {
        const conversation = conversationsFor(input.user).find(item => item.id === input.thread), title = String(input.title || '').trim().slice(0, 80);
        if (!conversation || !title) throw new Error('需要有效的演示会话与标题');
        conversation.title = title;
        return respond(res, 200, { ok: true, title });
      }
      if (url.pathname === '/api/export') {
        const conversation = conversationsFor(input.user).find(item => item.id === input.thread);
        if (!conversation) throw new Error('演示会话不存在');
        return respond(res, 200, { count: conversation.records.length, file: '离线演示：history-preview.json（仅模拟导出，未写入磁盘）' });
      }
      if (url.pathname === '/api/memory/private') {
        const memory = memoryFor(input.user);
        if (input.revision !== memory.revision) throw new Error('演示记忆已变更，请刷新后重试');
        if (input.action === 'configure') memory.automatic = input.automatic;
        else if (input.action === 'add') memory.entries.push({ id: `demo-new-${++entrySequence}`, text: String(input.text).trim(), origin: 'manual' });
        else if (input.action === 'update') {
          const entry = memory.entries.find(entry => entry.id === input.id);
          if (!entry) throw new Error('演示记忆不存在');
          entry.text = String(input.text).trim(); entry.manualEdited = true;
        } else if (input.action === 'remove') memory.entries = memory.entries.filter(entry => entry.id !== input.id);
        else throw new Error('未知的演示记忆操作');
        memory.revision += '-next';
        return respond(res, 200, memory);
      }
      if (url.pathname === '/api/memory') data.status.globalMemory = input.text;
      else if (url.pathname === '/api/lifecycle') Object.assign(data.status, { rotationTurns: input.rotationTurns, idleHours: input.idleHours });
      else if (url.pathname === '/api/config') Object.assign(data.status, { appId: input.appId, sandbox: input.sandbox, secretConfigured: true, qq: 'QQ 在线（READY）' });
      else if (url.pathname === '/api/reconnect') data.status.codex = '已登录；每个 QQ 账号独立启动 Codex 进程';
      else if (url.pathname === '/api/commands/sync') return respond(res, 200, data.status.commands);
      else if (url.pathname === '/api/pair') data.status.pairingCodes.push({ label: input.label || '演示账号', command: '/pair DEMO-ONLY-DO-NOT-SEND' });
      else if (url.pathname === '/api/user' || url.pathname === '/api/model') {
        const user = data.status.users.find(user => user.id === (input.id || input.user));
        if (!user) throw new Error('演示账号不存在');
        if (url.pathname === '/api/user') user.workspace = input.workspace;
        else user.model = { model: input.model, effort: input.effort || '默认', inherited: input.model === 'default' };
      } else return respond(res, 404, { error: '此接口不在管理页离线演示范围内' });
      return respond(res, 200, { ok: true, mode: 'offline-preview' });
    }
    respond(res, 404, { error: '此页面不在控制台离线演示范围内' });
  } catch (error) {
    respond(res, 400, { error: error.message });
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
console.log(JSON.stringify({ url: base, mode: 'offline-preview', scenario, productionDataTouched: false, scenarios: [...scenarios], controls: 'stdin: ready / empty / error / auth / long / quit; URL: /?scenario=long' }));
const input = readline.createInterface({ input: process.stdin });
let closing = false;
function close() {
  if (closing) return;
  closing = true;
  input.close();
  server.closeAllConnections();
  server.close();
  process.stdin.destroy();
}
input.on('line', line => {
  const command = line.trim();
  if (command === 'quit') return close();
  try { setScenario(command); console.log(JSON.stringify({ scenario, note: '场景已切换，等待页面下一次状态轮询；所有数据仍仅在内存中' })); }
  catch (error) { console.log(error.message); }
});
process.on('SIGINT', close);
process.on('SIGTERM', close);
