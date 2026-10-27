import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { QQ } from '../src/qq/client.mjs';

const MiB=1024*1024,origin='https://file.qq.com';
const event=()=>({id:'file-source',user:'owner',chat:'owner',group:false});
const md5=bytes=>crypto.createHash('md5').update(bytes).digest('hex');

async function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-file-'));
  const previous=getGlobalDispatcher(),agent=new MockAgent();agent.disableNetConnect();setGlobalDispatcher(agent);
  t.after(async()=>{setGlobalDispatcher(previous);await agent.close();fs.rmSync(root,{recursive:true,force:true});});
  const qq=new QQ({},()=>{}),calls=[],sent=[],file=path.join(root,'output.bin');
  qq.on('sent',entry=>sent.push(entry));
  return {qq,calls,sent,file,agent,pool:agent.get(origin)};
}

function writePattern(file,size){
  const full=crypto.createHash('md5'),sha1=crypto.createHash('sha1'),first=crypto.createHash('md5'),fd=fs.openSync(file,'w');
  try{for(let offset=0;offset<size;offset+=MiB){
    const bytes=Buffer.alloc(Math.min(MiB,size-offset),Math.floor(offset/MiB)%251);
    fs.writeSync(fd,bytes);full.update(bytes);sha1.update(bytes);
    if(offset<10002432)first.update(bytes.subarray(0,10002432-offset));
  }}finally{fs.closeSync(fd);}
  return {md5:full.digest('hex'),sha1:sha1.digest('hex'),md5_10m:first.digest('hex')};
}

function mockFileWithCloseFailure(t,file,data,failure){
  const close=t.mock.fn(async()=>{throw failure;});
  t.mock.method(fs.promises,'open',async(target,mode)=>{
    assert.equal(target,file);assert.equal(mode,'r');
    return {stat:async()=>({size:data.length}),createReadStream:()=>Readable.from([data]),close,
      read:async(buffer,offset,length,position)=>({bytesRead:data.copy(buffer,offset,position,position+length),buffer})};
  });
  return close;
}

test('files above 50 MiB upload every byte in QQ-provided parts with exact hashes and a short final part',async t=>{
  const f=await fixture(t),size=51*MiB+123,block=8*MiB+37,expected=writePattern(f.file,size),uploads=[];
  const parts=Array.from({length:Math.ceil(size/block)},(_,index)=>({index,block_size:block,presigned_url:`${origin}/large/${index}`}));
  for(const part of parts){
    f.pool.intercept({path:`/large/${part.index}`,method:'PUT'}).reply(options=>{
      const bytes=Buffer.from(options.body),start=part.index*block;
      assert.equal(bytes.length,Math.min(block,size-start));
      for(let offset=0;offset<bytes.length;){
        const position=start+offset,length=Math.min(bytes.length-offset,MiB-position%MiB);
        assert.deepEqual(bytes.subarray(offset,offset+length),Buffer.alloc(length,Math.floor(position/MiB)%251));offset+=length;
      }
      uploads.push({size:bytes.length,md5:md5(bytes)});return {statusCode:200,data:''};
    });
  }
  f.qq.api=async(endpoint,body)=>{
    f.calls.push({endpoint,body});
    if(endpoint.endsWith('/upload_prepare')){assert.deepEqual(body,{file_type:4,file_size:String(size),file_name:'output.bin',...expected});return {data:{upload_id:'large-upload',parts}};}
    if(endpoint.endsWith('/upload_part_finish')){const upload=uploads[body.part_index];assert.deepEqual(body,{upload_id:'large-upload',part_index:uploads.length-1,block_size:String(upload.size),md5:upload.md5});return {};}
    if(endpoint.endsWith('/files')){assert.equal(uploads.reduce((total,x)=>total+x.size,0),size);assert.equal(body.srv_send_msg,false);return {data:{file_info:'uploaded-large-file'}};}
    assert.equal(endpoint,'/v2/users/owner/messages');assert.deepEqual(body,{msg_type:7,media:{file_info:'uploaded-large-file'},msg_id:'file-source',msg_seq:1});return {id:'delivered'};
  };
  assert.deepEqual(await f.qq.sendFile(event(),f.file),{acceptedParts:1,totalParts:1,truncated:false});
  assert.equal(uploads.length,parts.length);assert(uploads.at(-1).size<block);
  assert.equal(f.calls.filter(x=>x.endpoint.endsWith('/messages')).length,1);assert.equal(f.sent.length,1);
  f.agent.assertNoPendingInterceptors();
});

test('a QQ upload rejection retains the original error and never retries or posts a message',async t=>{
  const f=await fixture(t),failure=Object.assign(new Error('QQ HTTP 400 业务错误 40094001'),{status:400,code:40094001});fs.writeFileSync(f.file,'platform decides');
  f.qq.api=async(endpoint,body)=>{f.calls.push({endpoint,body});throw failure;};
  await assert.rejects(f.qq.sendFile(event(),f.file),err=>err===failure&&err.definite===true&&err.uncertain===false&&err.acceptedParts===0);
  assert.equal(f.calls.length,1);assert.match(f.calls[0].endpoint,/\/upload_prepare$/);assert.equal(f.sent.length,0);assert.equal(f.qq.counts.size,0);
});

test('a message timeout after file upload stays uncertain without a second delivery attempt',async t=>{
  const f=await fixture(t),data=Buffer.from('small upload'),failure=Object.assign(new Error('message timeout'),{code:'UND_ERR_HEADERS_TIMEOUT'});fs.writeFileSync(f.file,data);
  f.pool.intercept({path:'/timeout',method:'PUT'}).reply(200,'');
  f.qq.api=async(endpoint,body)=>{
    f.calls.push({endpoint,body});
    if(endpoint.endsWith('/upload_prepare'))return {upload_id:'timeout-upload',parts:[{index:0,block_size:data.length,presigned_url:origin+'/timeout'}]};
    if(endpoint.endsWith('/upload_part_finish'))return {};
    if(endpoint.endsWith('/files'))return {file_info:'timeout-file'};
    throw failure;
  };
  await assert.rejects(f.qq.sendFile(event(),f.file),err=>err===failure&&err.uncertain===true&&err.accepted===false&&err.acceptedParts===0);
  assert.equal(f.calls.filter(x=>x.endpoint.endsWith('/messages')).length,1);assert.equal(f.qq.counts.get('file-source'),1);assert.equal(f.sent.length,0);
  f.agent.assertNoPendingInterceptors();
});

test('empty files fail before any QQ API call',async t=>{
  const f=await fixture(t);fs.writeFileSync(f.file,'');f.qq.api=async(...args)=>{f.calls.push(args);return {};};
  await assert.rejects(f.qq.sendFile(event(),f.file),err=>/不能发送空文件/.test(err.message)&&err.definite===true&&err.uncertain===false);
  assert.equal(f.calls.length,0);assert.equal(f.sent.length,0);
});

test('an incomplete QQ part list cannot publish or send a partial file',async t=>{
  const f=await fixture(t);fs.writeFileSync(f.file,'incomplete upload');f.pool.intercept({path:'/incomplete',method:'PUT'}).reply(200,'');
  f.qq.api=async(endpoint,body)=>{f.calls.push({endpoint,body});if(endpoint.endsWith('/upload_prepare'))return {upload_id:'incomplete-upload',parts:[{index:0,block_size:4,presigned_url:origin+'/incomplete'}]};return {};};
  await assert.rejects(f.qq.sendFile(event(),f.file),err=>/分片未覆盖整个文件/.test(err.message)&&err.definite===true&&err.uncertain===false);
  assert.deepEqual(f.calls.map(x=>x.endpoint.split('/').at(-1)),['upload_prepare','upload_part_finish']);assert.equal(f.sent.length,0);assert.equal(f.qq.counts.size,0);
  f.agent.assertNoPendingInterceptors();
});

test('a file close failure after part upload prevents registration and message delivery',async t=>{
  const f=await fixture(t),data=Buffer.from('close must finish before delivery'),failure=Object.assign(new Error('file close failed'),{code:'EIO'});
  const close=mockFileWithCloseFailure(t,f.file,data,failure);
  f.pool.intercept({path:'/close-failure',method:'PUT'}).reply(options=>{
    assert.deepEqual(Buffer.from(options.body),data);return {statusCode:200,data:''};
  });
  f.qq.api=async(endpoint,body)=>{
    f.calls.push({endpoint,body});
    if(endpoint.endsWith('/upload_prepare'))return {upload_id:'close-upload',parts:[{index:0,block_size:data.length,presigned_url:origin+'/close-failure'}]};
    return {};
  };
  await assert.rejects(f.qq.sendFile(event(),f.file),err=>err===failure&&err.definite===true&&err.uncertain===false&&err.acceptedParts===0);
  assert.equal(close.mock.callCount(),1);assert.deepEqual(f.calls.map(x=>x.endpoint.split('/').at(-1)),['upload_prepare','upload_part_finish']);
  assert.equal(f.sent.length,0);assert.equal(f.qq.counts.size,0);f.agent.assertNoPendingInterceptors();
});

test('a cleanup close failure cannot replace the original QQ upload rejection or its status',async t=>{
  const f=await fixture(t),failure=Object.assign(new Error('QQ HTTP 413 业务错误 40094001'),{status:413,code:40094001});
  const closeFailure=Object.assign(new Error('cleanup close failed'),{code:'EIO'}),close=mockFileWithCloseFailure(t,f.file,Buffer.from('platform rejection first'),closeFailure);
  f.qq.api=async(endpoint,body)=>{f.calls.push({endpoint,body});throw failure;};
  await assert.rejects(f.qq.sendFile(event(),f.file),err=>err===failure&&err.status===413&&err.code===40094001&&err.definite===true&&err.uncertain===false&&err.acceptedParts===0);
  assert.equal(close.mock.callCount(),1);assert.equal(f.calls.length,1);assert.match(f.calls[0].endpoint,/\/upload_prepare$/);
  assert.equal(f.sent.length,0);assert.equal(f.qq.counts.size,0);
});
