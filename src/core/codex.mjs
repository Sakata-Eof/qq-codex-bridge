import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { resolveCodexBinary } from './codex-binary.mjs';

export class CodexRPC extends EventEmitter {
  constructor(binary = 'codex', extraEnv = {}) { super(); this.binary = binary; this.extraEnv=extraEnv; this.pending = new Map(); this.nextId = 1; }
  async start() {
    this.binary = resolveCodexBinary(this.binary);
    this.child = spawn(this.binary, ['app-server', '--stdio'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env:{...process.env,...this.extraEnv} });
    this.child.on('error', e => this.fail(e));
    this.child.on('exit', code => this.fail(new Error(`Codex 已退出 (${code})`)));
    this.child.stderr.on('data', () => {}); // Do not forward raw diagnostics or credentials to QQ.
    createInterface({ input: this.child.stdout }).on('line', line => {
      let msg; try { msg = JSON.parse(line); } catch { return; }
      if (msg.method) this.emit(msg.id !== undefined ? 'request' : 'notification', msg);
      else if (this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id); this.pending.delete(msg.id); clearTimeout(p.timer);
        if(msg.error){const e=new Error(msg.error.message);e.definite=true;p.reject(e);}else p.resolve(msg.result);
      }
    });
    await this.call('initialize', { clientInfo: { name: 'qq_codex_local_bridge', version: '1.0.0' }, capabilities: { experimentalApi: true } });
    this.write({ method: 'initialized', params: {} });
    return this;
  }
  write(msg) {
    if (!this.child || this.child.exitCode !== null || this.child.killed) throw new Error('Codex 进程未运行');
    this.child.stdin.write(JSON.stringify(msg) + '\n');
  }
  call(method, params = {}, timeout = 60000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} 请求超时；请查看状态，勿重复提交任务`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); } catch(e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }
  reply(id, result) { this.write({ id, result }); }
  fail(e) {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(e); }
    this.pending.clear(); this.emit('offline', e);
  }
  stop() { this.child?.kill(); }
}
