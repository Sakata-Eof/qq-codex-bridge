import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildRuntimeEnvironment,resolveExecutable,prepareRuntimeEnvironment,discoverWhisperModel } from '../src/core/runtime-environment.mjs';

function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-runtime-env-'));t.after(()=>{assert.equal(path.dirname(root),fs.realpathSync(os.tmpdir()));assert(path.basename(root).startsWith('qq-runtime-env-'));fs.rmSync(root,{recursive:true,force:true});});
  const install=(relative,content='fixture',mode=0o755)=>{const file=path.join(root,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,content,{mode});return file;};return {root,install};
}
test('Windows child PATH has one spelling, starts with its actual Node and retains per-account overrides',()=>{
  const result=buildRuntimeEnvironment({platform:'win32',nodePath:'C:\\node-24\\node.exe',env:{Path:'C:\\Windows\\System32;C:\\tools',PATH:'c:\\TOOLS;.;relative',CODEX_HOME:'old',TOKEN:'secret'},overrides:{CODEX_HOME:'account-A'},registryPaths:['C:\\new tools;%LOCALAPPDATA%\\bin'],extraPaths:['C:\\media']});
  assert.deepEqual(Object.keys(result).filter(key=>key.toLowerCase()==='path'),['PATH']);assert.equal(result.PATH.split(';')[0],'C:\\node-24');assert.equal(result.PATH.toLowerCase().split('c:\\tools').length,2);assert(result.PATH.includes('C:\\new tools'));assert(!result.PATH.split(';').includes('.'));assert(!result.PATH.includes('relative'));assert.equal(result.CODEX_HOME,'account-A');assert.equal(result.TOKEN,'secret');
});
test('an explicit process PATH override replaces inherited entries while still supplying bridge Node',()=>{
  const result=buildRuntimeEnvironment({platform:'win32',nodePath:'C:\\node\\node.exe',env:{Path:'C:\\old'},overrides:{PATH:'C:\\new'},registryPaths:[]});assert(result.PATH.startsWith('C:\\node;C:\\new'));assert(!result.PATH.includes('C:\\old'));
});
test('environment construction does not alter the caller environment and handles POSIX paths',()=>{
  const env={PATH:'/usr/bin:/usr/bin:.:relative',CODEX_HOME:'/account'},result=buildRuntimeEnvironment({env,nodePath:'/opt/node/bin/node',platform:'linux',extraPaths:['/opt/ffmpeg/bin']});assert.equal(env.PATH,'/usr/bin:/usr/bin:.:relative');assert.equal(result.PATH,'/opt/node/bin:/usr/bin:/opt/ffmpeg/bin');
});
test('executable discovery uses explicit directories, ignores empty aliases and preserves missing explicit paths',t=>{
  const f=fixture(t),name=process.platform==='win32'?'ffmpeg.exe':'ffmpeg',binary=f.install('tools/'+name);f.install('aliases/'+name,'');
  const delimiter=path.delimiter,env={[process.platform==='win32'?'Path':'PATH']:[path.join(f.root,'aliases'),path.join(f.root,'tools')].join(delimiter)};
  assert.equal(resolveExecutable('ffmpeg',{env}),binary);assert.equal(resolveExecutable(path.join(f.root,'missing',name),{env}),null);assert.equal(resolveExecutable('./ffmpeg',{env}),null);
});
test('runtime resolution leaves portable configured commands intact and separates optional media readiness',t=>{
  const f=fixture(t),suffix=process.platform==='win32'?'.exe':'',node=f.install('node/node'+suffix),codex=f.install('tools/codex'+suffix),python=f.install('runtime/asr-venv/'+(process.platform==='win32'?'Scripts/python.exe':'bin/python'));
  f.install('tools/ffmpeg'+suffix);f.install('tools/ffprobe'+suffix);const model=path.join(f.root,'model');f.install('model/model.bin');f.install('model/config.json','{}');
  const original={codexBinary:codex,python:'python',ffmpeg:'ffmpeg',ffprobe:'ffprobe',whisperModel:'',adminToken:'DO_NOT_REPORT'},env={[process.platform==='win32'?'Path':'PATH']:path.join(f.root,'tools')};
  const result=prepareRuntimeEnvironment(original,{env,nodePath:node,nodeVersion:'24.0.0',runtime:path.join(f.root,'runtime'),registryPaths:[],probeWhisper:file=>file===python,discoverModel:()=>model});
  assert.equal(result.configuration.python,python);assert.equal(result.configuredCommands.python,'python');assert.equal(result.configuredCommands.ffmpeg,'ffmpeg');assert.equal(result.configuredCommands.whisperModel,'');assert.equal(original.python,'python');assert.equal(result.diagnostics.coreReady,true);assert.equal(result.diagnostics.mediaReady,true);assert(!JSON.stringify(result.diagnostics).includes('DO_NOT_REPORT'));
});
test('POSIX discovery skips non-executable binaries and uses python3 when python is absent',{skip:process.platform==='win32'},t=>{
  const f=fixture(t);
  const nonExecutable=f.install('downloads/codex','fixture',0o644);
  const codex=f.install('tools/codex'),python=f.install('tools/python3');
  const env={PATH:[path.dirname(nonExecutable),path.dirname(codex)].join(path.delimiter)};
  const options={env,registryPaths:[],probeWhisper:()=>false,discoverModel:()=>''};
  const result=prepareRuntimeEnvironment({python:'python'},options);
  assert.equal(resolveExecutable(nonExecutable,{env}),null);
  assert.equal(result.configuration.codexBinary,codex);
  assert.equal(result.configuration.python,python);
  assert.equal(result.configuredCommands.python,'python');
  const missingPython=path.join(f.root,'missing','python');
  const explicit=prepareRuntimeEnvironment({python:missingPython},options);
  assert.equal(explicit.configuration.python,missingPython);
  assert.equal(explicit.diagnostics.tools.python.available,false);
});
test('missing dependencies and unsupported Node are reported without replacing explicit user paths',t=>{
  const f=fixture(t),node=f.install('node'),python=path.join(f.root,'old-machine','python.exe');
  const result=prepareRuntimeEnvironment({codexBinary:path.join(f.root,'missing-codex'),python,ffmpeg:'missing-ffmpeg',ffprobe:'missing-ffprobe'},{nodePath:node,nodeVersion:'20.1.0',env:{},runtime:f.root,registryPaths:[],probeWhisper:()=>{throw new Error('Must not execute a missing Python');},discoverModel:()=>''});
  assert.equal(result.diagnostics.coreReady,false);assert.equal(result.diagnostics.mediaReady,false);assert.equal(result.diagnostics.node.available,false);assert.equal(result.configuration.python,python);assert.equal(result.diagnostics.tools.python.resolvedPath,null);
});
test('Python packages are part of media readiness even when every executable and model exists',t=>{
  const f=fixture(t),suffix=process.platform==='win32'?'.exe':'',tools={};for(const name of ['node','codex','python','ffmpeg','ffprobe'])tools[name]=f.install('tools/'+name+suffix);f.install('model/model.bin');f.install('model/config.json','{}');
  const result=prepareRuntimeEnvironment({codexBinary:tools.codex,python:tools.python,ffmpeg:tools.ffmpeg,ffprobe:tools.ffprobe,whisperModel:path.join(f.root,'model')},{nodePath:tools.node,nodeVersion:'24.2.0',registryPaths:[],probeWhisper:()=>false,discoverModel:()=>''});assert.equal(result.diagnostics.coreReady,true);assert.equal(result.diagnostics.fasterWhisper.available,false);assert.equal(result.diagnostics.mediaReady,false);
});
test('Whisper model discovery is user-relative and ignores incomplete downloads',t=>{
  const f=fixture(t),base='.cache/huggingface/hub/models--Systran--faster-whisper-small/snapshots';f.install(base+'/incomplete/config.json','{}');f.install(base+'/complete/config.json','{}');f.install(base+'/complete/model.bin');assert.equal(discoverWhisperModel({home:f.root}),path.join(f.root,base,'complete'));
});
test('the real Windows command shell can run bare Node with an otherwise empty application PATH',{skip:process.platform!=='win32'},()=>{
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>key.toLowerCase()!=='path'));env.PATH=path.join(process.env.SystemRoot,'System32');const child=buildRuntimeEnvironment({env});
  const powershell=path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');const result=execFileSync(powershell,['-NoProfile','-NonInteractive','-Command','node --version'],{env:child,encoding:'utf8',windowsHide:true});assert.equal(result.trim(),process.version);
});
