export function parseMessage(type, d) {
  if (!['C2C_MESSAGE_CREATE','GROUP_AT_MESSAGE_CREATE'].includes(type) || !d.id) return null;
  const group = type === 'GROUP_AT_MESSAGE_CREATE';
  const user = group ? d.author?.member_openid : d.author?.user_openid;
  const chat = group ? d.group_openid : user;
  if (!user || !chat) return null;
  return { id: String(d.id), user: String(user), chat: String(chat), group,
    attachments: Array.isArray(d.attachments)?d.attachments:[],
    quoted: Array.isArray(d.msg_elements)?d.msg_elements.filter(x=>x.author?.user_openid===user || x.author?.member_openid===user):[],
    text: String(d.content || '').replace(/<@!?\d+>/g, '').trim() };
}
