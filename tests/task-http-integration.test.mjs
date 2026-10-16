import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { History } from '../src/history/store.mjs';
import { TaskStore } from '../src/history/task-store.mjs';
import { createTaskRoutes } from '../src/http/task-routes.mjs';
import { authorizeUI } from '../src/http/auth.mjs';

test('authenticated task HTTP routes serve a real journal with account and diagnostic boundaries', async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-task-http-'));
  const config = { appId: 'test', users: [{ id: 'A' }, { id: 'B' }] };
  const history = new History(config, temporary), tasks = new TaskStore(history);
  const event = user => ({ id: 'same-source', user, chat: user, group: false, text: '任务 ' + user });
  const a = tasks.ensure('A', event('A')), b = tasks.ensure('B', event('B'));
  tasks.record('A', a.id, { stage: 'running', executionStatus: 'running', threadId: 'thread-a', turnId: 'turn-a' });
  tasks.record('A', a.id, { stage: 'uncertain', code: 'reply_uncertain', executionStatus: 'completed', deliveryStatus: 'unknown' });
  tasks.record('B', b.id, { stage: 'preparing' });
  const accounts = { instances: new Map(), taskTrackingError: new Map([['A', true]]) };
  const qq = { state: 'QQ 在线（READY）' }, secret = 'test-only-http-secret';
  const respond = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
  let base, routes, reached = 0;
  const server = http.createServer(async (req, res) => {
    if (req.headers.host !== new URL(base).host || req.headers.origin && req.headers.origin !== base) return respond(res, 403, { error: 'Local only' });
    if (!authorizeUI(req, secret, base)) return respond(res, 403, { error: 'Login required' });
    try { reached++; if (!await routes(req, res)) respond(res, 404, { error: 'Not found' }); }
    catch { respond(res, 400, { error: 'Invalid request' }); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  routes = createTaskRoutes({ config, tasks, accounts, qq, base, respond });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    history.close();
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(temporary));
    assert(relative.startsWith('qq-task-http-') && !relative.includes(path.sep));
    fs.rmSync(temporary, { recursive: true, force: true });
  });
  const request = async (url, headers = { Authorization: 'Bearer ' + secret }) => {
    const response = await fetch(base + url, { headers });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await request('/api/tasks?user=A', {})).status, 403);
  assert.equal((await request('/api/tasks?user=A', { Authorization: 'Bearer ' + secret, Origin: 'https://untrusted.example' })).status, 403);
  assert.equal(reached, 0);
  const list = await request('/api/tasks?user=A');
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.tasks.map(task => task.id), [a.id]);
  assert.equal(list.body.tasks[0].executionStatus, 'completed');
  assert.equal(list.body.tasks[0].deliveryStatus, 'unknown');
  const detail = await request(`/api/tasks/${a.id}?user=A`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.task.events.at(-1).codeLabel, '结果投递需要确认');
  assert(detail.body.task.events.every(event => event.createdAt));
  const foreign = await request(`/api/tasks/${b.id}?user=A`);
  const missing = await request('/api/tasks/absent?user=A');
  assert.deepEqual(foreign, missing);
  assert.equal(foreign.status, 404);
  const diagnosticA = await request('/api/diagnostics?user=A');
  const diagnosticB = await request('/api/diagnostics?user=B');
  assert.equal(diagnosticA.body.tracking.state, 'degraded');
  assert.equal(diagnosticB.body.tracking.state, 'ok');
  assert.equal(diagnosticA.body.process.state, 'not_started');
  assert.equal(diagnosticA.body.model.state, 'unchecked');
  assert.equal(JSON.stringify(diagnosticA.body).includes(secret), false);
});
