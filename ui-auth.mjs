import crypto from 'node:crypto';
const COOKIE='qq_codex_session',AGE=30*86400;
function signature(value,secret){return crypto.createHmac('sha256',secret).update(value).digest('base64url');}
function equal(a,b){const x=Buffer.from(a||''),y=Buffer.from(b||'');return x.length===y.length&&crypto.timingSafeEqual(x,y);}
export function browserCookie(secret,now=Date.now()){
  const data=Buffer.from(JSON.stringify({expires:now+AGE*1000,nonce:crypto.randomBytes(16).toString('hex')})).toString('base64url');
  return `${COOKIE}=${data}.${signature(data,secret)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${AGE}`;
}
export function authorizeUI(req,secret,base,now=Date.now()){
  if(req.headers.authorization)return equal(req.headers.authorization,'Bearer '+secret);
  if(req.headers.origin&&req.headers.origin!==base)return false;
  if(req.headers['sec-fetch-site']==='cross-site')return false;
  if(req.method!=='GET'&&req.headers.origin!==base)return false;
  const value=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(COOKIE+'='))?.slice(COOKIE.length+1);
  if(!value)return false;const [data,sig,...extra]=value.split('.');if(extra.length||!equal(sig,signature(data,secret)))return false;
  try{const p=JSON.parse(Buffer.from(data,'base64url').toString('utf8'));return Number.isFinite(p.expires)&&p.expires>now&&p.expires<=now+AGE*1000;}catch{return false;}
}
