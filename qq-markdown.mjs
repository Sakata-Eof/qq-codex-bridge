const escapePath=c=>/[\\`*_[\]{}()#!|<>]/.test(c)?'\\'+c:c;
const localPath=value=>/^(?:[a-z]:[\\/]|\/|\\\\|file:\/\/|\.{1,2}[\\/])/i.test(value);
const characters=(raw,render=c=>c,fenceAfter=null)=>Array.from(raw,c=>({raw:c,markdown:render(c),fenceAfter,breakPriority:0}));

function inlineCodeRanges(line) {
  const ranges=[];
  for(let i=0;i<line.length;){
    if(line[i]!=='`'){i++;continue;}
    let end=i+1;while(line[end]==='`')end++;
    const marker=line.slice(i,end),close=line.indexOf(marker,end);
    if(close<0){i=end;continue;}
    ranges.push([i,close+marker.length]);i=close+marker.length;
  }
  return ranges;
}

function destination(line,start) {
  if(line[start]==='<'){
    const close=line.indexOf('>',start+1);if(close<0)return null;
    let end=close+1;while(/[ \t]/.test(line[end]||'')&&end<line.length)end++;
    return line[end]===')'?{start:start+1,end:close,close:end}:null;
  }
  let depth=1;
  for(let i=start;i<line.length;i++){
    if(line[i]==='(')depth++;
    if(line[i]===')'&&!--depth)return {start,end:i,close:i};
  }
  return null;
}

function proseUnits(line) {
  const overrides=new Map(),protectedRanges=inlineCodeRanges(line),links=/!?\[([^\]\r\n]*)\]\(/g;
  let match;
  while((match=links.exec(line))){
    if(protectedRanges.some(([start,end])=>match.index>=start&&match.index<end))continue;
    const target=destination(line,links.lastIndex);if(!target)continue;
    const value=line.slice(target.start,target.end);if(!localPath(value))continue;
    const bracket=match.index+(line[match.index]==='!'?1:0),labelStart=bracket+1,labelEnd=links.lastIndex-2;
    for(let i=match.index;i<=target.close;){
      const c=String.fromCodePoint(line.codePointAt(i));
      overrides.set(i,i>=labelStart&&i<labelEnd?c:i===labelEnd?'（':i>=target.start&&i<target.end?escapePath(c):i===target.close?'）':'');
      i+=c.length;
    }
    links.lastIndex=target.close+1;
  }
  const units=[];
  for(let i=0;i<line.length;){const c=String.fromCodePoint(line.codePointAt(i));units.push({raw:c,markdown:overrides.has(i)?overrides.get(i):c,fenceAfter:null,breakPriority:0});i+=c.length;}
  return units;
}

function unitsFor(text,limit) {
  const units=[];let fence=null;
  const lines=text.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g)||[];
  for(const line of lines){
    if(!line)continue;
    const body=line.replace(/(?:\r\n|\n|\r)$/,''),match=body.match(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/);
    if(fence&&match&&match[1][0]===fence.marker[0]&&match[1].length>=fence.marker.length&&!match[2].trim()){
      const current=fence;fence=null;
      if(current.enabled)units.push({raw:line,markdown:current.marker+(/\r\n$|[\r\n]$/.test(line)?'\n':''),fenceAfter:null,breakPriority:1});
      else units.push(...characters(line,escapePath));
      continue;
    }
    if(!fence&&match){
      const marker=match[1],enabled=marker.length*2+4<=limit;
      // Huge language metadata is omitted from the wire header, never from source text.
      const info=match[2],full=marker+info+'\n',opener=full.length<=Math.floor(limit/3)?full:marker+'\n';
      fence={marker,opener,enabled};
      if(enabled)units.push({raw:line,markdown:opener,fenceAfter:fence,breakPriority:1});
      else units.push(...characters(line,escapePath,fence));
      continue;
    }
    const next=fence?characters(line,fence.enabled?c=>c:escapePath,fence):proseUnits(line);
    if(next.length&&/\r\n$|[\r\n]$/.test(line))next.at(-1).breakPriority=body.trim()?1:2;
    units.push(...next);
  }
  return units;
}

function suffix(fence,content) {return fence?.enabled?(/[\r\n]$/.test(content)?'':'\n')+fence.marker:'';}

/** Split QQ Markdown while retaining exact source fragments for history and auditing. */
export function splitMarkdown(value,limit=1400) {
  if(!Number.isInteger(limit)||limit<2)throw new RangeError('QQ Markdown limit must be an integer of at least 2');
  const text=String(value);if(!text)return [];
  const units=unitsFor(text,limit),parts=[];let cursor=0,fence=null;
  while(cursor<units.length){
    const prefix=fence?.enabled?fence.opener:'';
    let rendered='',lastValid=cursor,paragraph=cursor,line=cursor;
    for(let end=cursor;end<units.length;end++){
      const unit=units[end],next=rendered+unit.markdown;
      if(prefix.length+next.length+suffix(unit.fenceAfter,next).length>limit)break;
      rendered=next;lastValid=end+1;
      if(unit.breakPriority===2)paragraph=lastValid;
      if(unit.breakPriority)line=lastValid;
    }
    if(lastValid===cursor)throw new RangeError('QQ Markdown limit cannot fit this fenced fragment');
    // If everything remaining fits, keep it together; otherwise favor complete blocks/lines.
    const end=lastValid===units.length?lastValid:paragraph>cursor?paragraph:line>cursor?line:lastValid;
    const selected=units.slice(cursor,end),source=selected.map(unit=>unit.raw).join(''),content=selected.map(unit=>unit.markdown).join('');
    fence=selected.at(-1).fenceAfter;
    parts.push({text:source,markdown:prefix+content+suffix(fence,content)});cursor=end;
  }
  return parts;
}
