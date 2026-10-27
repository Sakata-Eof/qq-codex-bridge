import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Media } from '../src/media/processor.mjs';

const MiB=1024*1024,pngHeader=Buffer.from('89504e470d0a1a0a00000000','hex');
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-media-size-'));
  assert.equal(path.dirname(root),path.resolve(os.tmpdir()));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;
}
function response(body,headers={}){return new Response(Readable.toWeb(Readable.from(body)),{headers});}

test('attachment downloads accept more than 50 MiB with and without content length',async t=>{
  const root=fixture(t),chunk=Buffer.alloc(MiB,37),tail=Buffer.from('end');
  for(const advertised of [true,false]){
    const target=path.join(root,advertised?'sized.bin':'streamed.bin');
    const media=new Media({}, {}, {fetch:async()=>response((async function*(){for(let i=0;i<51;i++)yield chunk;yield tail;})(),advertised?{'content-length':String(51*MiB+tail.length)}:{})});
    assert.equal(await media.download('https://qq.com/large.bin',target),target);
    assert.equal(fs.statSync(target).size,51*MiB+tail.length);
    const fd=fs.openSync(target,'r');try{const bytes=Buffer.alloc(tail.length);fs.readSync(fd,bytes,0,bytes.length,51*MiB);assert.deepEqual(bytes,tail);}finally{fs.closeSync(fd);}
  }
  assert.deepEqual(fs.readdirSync(root).sort(),['sized.bin','streamed.bin']);
});

test('failed attachment streams remove temporary data and preserve existing targets',async t=>{
  const root=fixture(t),target=path.join(root,'attachment.bin'),failure=new Error('source stream failed');
  const media=new Media({}, {}, {fetch:async()=>response((async function*(){yield Buffer.alloc(MiB);await new Promise(resolve=>setImmediate(resolve));throw failure;})())});
  await assert.rejects(media.download('https://qq.com/fail.bin',target),err=>err===failure);
  assert.deepEqual(fs.readdirSync(root),[]);
  fs.writeFileSync(target,'previous complete attachment');
  await assert.rejects(media.download('https://qq.com/fail.bin',target),err=>err===failure);
  assert.equal(fs.readFileSync(target,'utf8'),'previous complete attachment');
  assert.deepEqual(fs.readdirSync(root),['attachment.bin']);
});

test('attachment downloads retain trusted URL validation across redirects',async t=>{
  const root=fixture(t),target=path.join(root,'attachment.bin');let calls=0,cancelled=false;
  const media=new Media({}, {}, {fetch:async()=>{calls++;return {status:302,headers:new Headers({location:'https://untrusted.example/private'}),body:{cancel:async()=>{cancelled=true;}}};}});
  await assert.rejects(media.download('https://untrusted.example/file',target),/允许的腾讯媒体域名/);assert.equal(calls,0);
  await assert.rejects(media.download('https://qq.com/redirect',target),/允许的腾讯媒体域名/);assert.equal(calls,1);assert.equal(cancelled,true);
  assert.deepEqual(fs.readdirSync(root),[]);
});

test('attachment metadata above 50 MiB reaches preparation',async t=>{
  const root=fixture(t),media=new Media({}, {});let downloaded;
  media.download=async(url,target)=>{downloaded={url,target};fs.writeFileSync(target,'downloaded');return target;};
  const input=await media.prepare({id:'large-metadata',text:'处理附件',attachments:[{filename:'large.bin',size:51*MiB,content_type:'application/octet-stream',url:'https://qq.com/large.bin'}]},root);
  assert.equal(downloaded.url,'https://qq.com/large.bin');assert.match(input[0].text,/文件附件保存在/);assert.equal(fs.readFileSync(downloaded.target,'utf8'),'downloaded');
});

test('generated image paths accept more than 50 MiB and still enforce account roots',t=>{
  const root=fixture(t),own=path.join(root,'own');fs.mkdirSync(own);const source=path.join(own,'large.png'),foreign=path.join(root,'foreign.png');
  const fd=fs.openSync(source,'w');try{fs.writeSync(fd,pngHeader);fs.ftruncateSync(fd,51*MiB);}finally{fs.closeSync(fd);}
  fs.writeFileSync(foreign,pngHeader);const media=new Media({}, {});
  const result=media.saveGenerated({id:'large-path',savedPath:source},own,[own]);assert.equal(fs.statSync(result).size,51*MiB);
  assert.throws(()=>media.saveGenerated({id:'foreign',savedPath:foreign},own,[own]),/当前账号/);
  assert.throws(()=>media.saveGenerated({id:'relative',savedPath:'large.png'},own,[own]),/当前账号/);
});

test('generated base64 images accept more than the former 70 MiB encoded limit',t=>{
  const root=fixture(t),media=new Media({}, {}),data=Buffer.alloc(53*MiB);pngHeader.copy(data);const encoded=data.toString('base64');assert(encoded.length>70*MiB);
  const result=media.saveGenerated({id:'large-base64',result:'data:image/png;base64,'+encoded},root,[root]);assert.equal(fs.statSync(result).size,data.length);
  const fd=fs.openSync(result,'r');try{const header=Buffer.alloc(12);fs.readSync(fd,header,0,header.length,0);assert.deepEqual(header,pngHeader);}finally{fs.closeSync(fd);}
});

test('generated images retain base64 syntax and image signature validation',t=>{
  const root=fixture(t),media=new Media({}, {});
  for(const result of ['', '==', 'abc=def', 'abc===', 'abc def', '!bad'])assert.equal(media.saveGenerated({id:'invalid',result},root,[root]),null);
  assert.throws(()=>media.saveGenerated({id:'not-image',result:Buffer.from('plain text').toString('base64')},root,[root]),/不是可识别的图片/);
  assert.equal(media.saveGenerated({failure:{message:'generation failed'}},root,[root]),null);
});
