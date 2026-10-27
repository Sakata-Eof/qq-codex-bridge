import { MemoryError, memoryEntryView } from '../core/memory.mjs';

function memoryDTO(user,snapshot){
  return {user:user.id,revision:snapshot.revision,automatic:snapshot.automatic,entries:snapshot.entries.map(memoryEntryView)};
}

/** Mounted only after the application's Host, Origin and UI authorization checks. */
export function createMemoryRoutes({config,accounts,base,respond,body}){
  return async function memoryRoutes(req,res){
    const url=new URL(req.url,base);
    if(url.pathname!=='/api/memory/private')return false;
    if(!['GET','POST'].includes(req.method)){respond(res,405,{error:'不支持的请求方法'});return true;}
    let input,user;
    if(req.method==='POST'){
      try{input=await body(req);}catch{respond(res,400,{error:'无效的记忆请求'});return true;}
      if(!input||typeof input!=='object'||Array.isArray(input)){respond(res,400,{error:'无效的记忆请求'});return true;}
      user=typeof input.user==='string'?config.users.find(item=>item.id===input.user):null;
    }else{
      const ids=url.searchParams.getAll('user');
      user=ids.length===1?config.users.find(item=>item.id===ids[0]):null;
    }
    if(!user){respond(res,400,{error:'需要指定已绑定账号'});return true;}
    try{
      // All reads, revision checks and writes after request parsing are synchronous.
      // QQ /remember and /forget therefore cannot interleave with an HTTP mutation.
      const memory=accounts.memory(user);
      const snapshot=req.method==='GET'?memory.snapshot():memory.change(input);
      respond(res,200,{...(req.method==='POST'?{ok:true}:{}),...memoryDTO(user,snapshot)});return true;
    }catch(error){
      if(error instanceof MemoryError)respond(res,error.status,{error:error.message});
      else respond(res,503,{error:'账号记忆暂时不可用，请稍后重新加载'});
      return true;
    }
  };
}
