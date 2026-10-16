export function safeMediaURL(value) {
  const u=new URL(value.startsWith('//')?'https:'+value:value);
  const hosts=['qq.com','qq.com.cn','qpic.cn','gtimg.cn','qlogo.cn','myqcloud.com','qqbot.cn','idqqimg.com'];
  const trusted=u.hostname==='qqbot.ugcimg.cn'||hosts.some(h=>u.hostname===h||u.hostname.endsWith('.'+h));
  if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.port||!trusted)throw new Error(`附件地址不在允许的腾讯媒体域名中 (${u.hostname})`);
  // QQ supplies some legacy CDN URLs as HTTP; fetch the same trusted host over HTTPS.
  u.protocol='https:';
  return u.href;
}
