export async function readJSONBody(req,limit=8192){
  req.setEncoding('utf8');
  let text='';
  for await(const chunk of req){
    text+=chunk;
    if(text.length>limit)throw new Error('请求过长');
  }
  return JSON.parse(text||'{}');
}
