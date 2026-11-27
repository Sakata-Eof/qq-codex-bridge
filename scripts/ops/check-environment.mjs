import fs from 'node:fs';
import path from 'node:path';
import { prepareRuntimeEnvironment } from '../../src/core/runtime-environment.mjs';
import { runtimeDir } from '../../src/paths.mjs';

const file=path.join(runtimeDir,'config.json');
const configured=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{};
const {diagnostics}=prepareRuntimeEnvironment({codexBinary:'codex',python:'python',ffmpeg:'ffmpeg',ffprobe:'ffprobe',whisperModel:'',...configured},{runtime:runtimeDir});
console.log(JSON.stringify(diagnostics,null,2));
if(!diagnostics.coreReady||process.argv.includes('--media')&&!diagnostics.mediaReady)process.exitCode=1;
