import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { resolveCodexBinary } from './codex-binary.mjs';

const pathValues=env=>Object.entries(env).filter(([key])=>key.toLowerCase()==='path').map(([,value])=>String(value||''));
const apiFor=platform=>platform==='win32'?path.win32:path.posix;
const absolute=(value,platform)=>platform==='win32'?/^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/i.test(value):path.posix.isAbsolute(value);

/** Build a process-local PATH; never write user or machine environment settings. */
export function buildRuntimeEnvironment({env=process.env,overrides={},nodePath=process.execPath,extraPaths=[],registryPaths=[],platform=process.platform}={}){
  const api=apiFor(platform),delimiter=platform==='win32'?';':':',merged={...env,...overrides};
  const lookup=new Map(Object.entries(merged).map(([key,value])=>[key.toLowerCase(),String(value)]));
  const expand=value=>platform==='win32'?value.replace(/%([^%]+)%/g,(whole,key)=>lookup.get(key.toLowerCase())??whole):value;
  const overriddenPath=pathValues(overrides);
  const candidates=[api.dirname(nodePath),...(overriddenPath.length?overriddenPath:pathValues(env)),...extraPaths,...registryPaths];
  if(platform==='win32'){
    const windows=lookup.get('systemroot')||'C:\\Windows';
    candidates.push(api.join(windows,'System32'),api.join(windows,'System32','WindowsPowerShell','v1.0'));
  }
  const parts=[],seen=new Set();
  for(const value of candidates.flatMap(value=>String(value||'').split(delimiter))){
    const entry=expand(value.trim().replace(/^"(.*)"$/,'$1'));if(!entry||!absolute(entry,platform))continue;
    const normalized=api.normalize(entry),key=platform==='win32'?normalized.toLowerCase():normalized;
    if(!seen.has(key)){parts.push(normalized);seen.add(key);}
  }
  for(const key of Object.keys(merged))if(key.toLowerCase()==='path')delete merged[key];
  // Use one canonical name across the process and command-executor boundaries.
  merged.PATH=parts.join(delimiter);return merged;
}

/** Registry refresh is read-only and excludes every value except PATH. */
export function readWindowsEnvironmentPaths({env=process.env,platform=process.platform}={}){
  if(platform!=='win32')return [];
  const powershell=path.win32.join(env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const command="[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); @([Environment]::GetEnvironmentVariable('Path','User'),[Environment]::GetEnvironmentVariable('Path','Machine')) | ConvertTo-Json -Compress";
  try{const values=JSON.parse(execFileSync(powershell,['-NoProfile','-NonInteractive','-Command',command],{env,windowsHide:true,timeout:5000,encoding:'utf8',stdio:['ignore','pipe','ignore']}));return Array.isArray(values)?values.filter(value=>typeof value==='string'):[];}catch{return [];}
}

export function resolveExecutable(command,{env=process.env,platform=process.platform,allowWrappers=false}={}){
  if(typeof command!=='string'||!command.trim())return null;
  const api=apiFor(platform),value=command.trim();
  const exists=file=>{
    try{
      const stat=fs.statSync(file);
      if(!stat.isFile()||stat.size===0)return false;
      if(platform!=='win32'&&!(allowWrappers&&/\.(?:js|mjs|cjs)$/i.test(file)))fs.accessSync(file,fs.constants.X_OK);
      return true;
    }catch{return false;}
  };
  if(absolute(value,platform))return exists(value)?api.normalize(value):null;
  // Relative paths are explicit configuration, not invitations to search another program.
  if(/[\\/]/.test(value))return null;
  const suffixes=platform==='win32'&&!api.extname(value)?(allowWrappers?['.exe','.com','.cmd','.bat']:['.exe','.com']):[''];
  for(const directory of pathValues(env).flatMap(value=>value.split(platform==='win32'?';':':'))){
    if(!absolute(directory,platform))continue;
    for(const suffix of suffixes){const file=api.join(directory,value+suffix);if(exists(file))return file;}
  }
  return null;
}

export function discoverWhisperModel({home=os.homedir()}={}){
  const root=path.join(home,'.cache','huggingface','hub','models--Systran--faster-whisper-small','snapshots');
  try{return fs.readdirSync(root,{withFileTypes:true}).filter(item=>item.isDirectory()).map(item=>path.join(root,item.name)).filter(folder=>fs.existsSync(path.join(folder,'model.bin'))&&fs.existsSync(path.join(folder,'config.json'))).sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs)[0]||'';}catch{return '';}
}

export function hasWhisperModule(python){
  if(!python)return false;
  try{return execFileSync(python,['-c','import importlib.util; print("yes" if importlib.util.find_spec("faster_whisper") else "no")'],{windowsHide:true,timeout:5000,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim()==='yes';}catch{return false;}
}

/** Resolve bridge-owned tools once at startup and expose only non-secret diagnostics. */
export function prepareRuntimeEnvironment(config,{env=process.env,runtime='',platform=process.platform,nodePath=process.execPath,nodeVersion=process.versions.node,registryPaths=readWindowsEnvironmentPaths({env,platform}),probeWhisper=hasWhisperModule,discoverModel=discoverWhisperModel}={}){
  const api=apiFor(platform),configuration={...config};
  const configuredCommands=Object.fromEntries(['codexBinary','python','ffmpeg','ffprobe','whisperModel'].filter(key=>config[key]!==undefined).map(key=>[key,config[key]]));
  let environment=buildRuntimeEnvironment({env,nodePath,registryPaths,platform});
  const venv=runtime?api.join(runtime,'asr-venv',platform==='win32'?'Scripts':'bin',platform==='win32'?'python.exe':'python'):'';
  const defaultPython=configuration.python??'python';
  if(['python','python.exe','python3','python3.exe',''].includes(defaultPython)&&venv&&fs.existsSync(venv))configuration.python=venv;
  else configuration.python=defaultPython;
  configuration.codexBinary=resolveCodexBinary(configuration.codexBinary||'codex',{env:environment,platform});
  const tools={};
  for(const [name,key,fallback,required] of [['codex','codexBinary','codex',true],['python','python','python',false],['ffmpeg','ffmpeg','ffmpeg',false],['ffprobe','ffprobe','ffprobe',false]]){
    const command=configuration[key]||fallback;
    let resolvedPath=resolveExecutable(command,{env:environment,platform});
    if(!resolvedPath&&platform!=='win32'&&name==='python'&&command==='python')resolvedPath=resolveExecutable('python3',{env:environment,platform});
    const native=resolvedPath&&(platform!=='win32'||/\.(?:exe|com)$/i.test(resolvedPath));
    tools[name]={available:Boolean(native),required,command,resolvedPath:native?resolvedPath:null,...(resolvedPath&&!native?{reason:'native_executable_required'}:{})};
    if(native)configuration[key]=resolvedPath;
  }
  for(const name of ['git','rg','rtk','npm','npx']){
    const isNpmTool=name==='npm'||name==='npx';
    const command=config.runtimeToolPaths?.[name]||name,resolvedPath=resolveExecutable(command,{env:environment,platform,allowWrappers:platform==='win32'||isNpmTool});
    const tool={available:Boolean(resolvedPath),required:false,command,resolvedPath};
    if(resolvedPath&&isNpmTool&&/\.(?:js|mjs|cjs)$/i.test(resolvedPath))tool.launcher={executable:nodePath,arguments:[resolvedPath]};
    else if(resolvedPath&&platform==='win32'&&!/\.(?:exe|com)$/i.test(resolvedPath)){
      let script;
      if(isNpmTool){
        if(/\.(?:js|mjs|cjs)$/i.test(resolvedPath))script=resolvedPath;
        else if(!config.runtimeToolPaths?.[name]&&api.basename(resolvedPath).toLowerCase()===name+'.cmd'){
          const candidate=api.join(api.dirname(resolvedPath),'node_modules','npm','bin',name==='npm'?'npm-cli.js':'npx-cli.js');if(fs.existsSync(candidate))script=candidate;
        }
      }
      if(script)tool.launcher={executable:nodePath,arguments:[script]};
      else{tool.available=false;tool.reason='wrapper_not_supported';}
    }
    tools[name]=tool;
  }
  environment=buildRuntimeEnvironment({env:environment,nodePath,extraPaths:Object.values(tools).filter(tool=>tool.resolvedPath).map(tool=>api.dirname(tool.resolvedPath)),platform});
  const model=configuration.whisperModel||discoverModel();configuration.whisperModel=model;
  const whisperModel={available:Boolean(model&&fs.existsSync(api.join(model,'model.bin'))&&fs.existsSync(api.join(model,'config.json'))),configuredPath:model||null};
  const fasterWhisper={available:tools.python.available&&probeWhisper(tools.python.resolvedPath)};
  const node={available:Boolean(resolveExecutable(nodePath,{env:environment,platform}))&&Number(nodeVersion.split('.')[0])>=24,path:nodePath,version:nodeVersion,required:true};
  const diagnostics={node,tools,whisperModel,fasterWhisper,coreReady:node.available&&tools.codex.available,mediaReady:tools.python.available&&tools.ffmpeg.available&&tools.ffprobe.available&&whisperModel.available&&fasterWhisper.available};
  return {configuration,configuredCommands,environment,diagnostics};
}

export function applyRuntimeEnvironment(environment){
  const entries=pathValues(environment);for(const key of Object.keys(process.env))if(key.toLowerCase()==='path')delete process.env[key];
  process.env.PATH=entries[0]||'';
}

/** Describe capabilities without depending on the command executor's inherited PATH. */
