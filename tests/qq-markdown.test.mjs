import test from 'node:test';
import assert from 'node:assert/strict';
import { splitMarkdown } from '../src/qq/markdown.mjs';

function valid(text,limit=1400) {
  const parts=splitMarkdown(text,limit);assert.equal(parts.map(part=>part.text).join(''),text);
  for(const part of parts){assert.ok(part.markdown.length<=limit);assert.deepEqual(Object.keys(part),['text','markdown']);assert.doesNotMatch(part.text,/[\uD800-\uDBFF]$/u);assert.doesNotMatch(part.text,/^[\uDC00-\uDFFF]/u);assert.doesNotMatch(part.markdown,/[\uD800-\uDBFF]$/u);assert.doesNotMatch(part.markdown,/^[\uDC00-\uDFFF]/u);}
  return parts;
}
function closedFences(markdown) {
  let marker=null;
  for(const line of markdown.split(/\r\n|\n|\r/)){
    const match=line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);if(!match)continue;
    if(!marker)marker=match[1];else if(match[1][0]===marker[0]&&match[1].length>=marker.length&&!match[2].trim())marker=null;
  }
  assert.equal(marker,null,markdown);
}

test('empty input yields no parts and ordinary Markdown stays literal on the wire',()=>{
  assert.deepEqual(splitMarkdown(''),[]);
  const text='# 标题\n\n**粗体** 和 *斜体*\n- 项目一\n- 项目二\n> 引用\n[网站](https://example.com/a?x=1&y=2)\n`inline code`';
  assert.deepEqual(valid(text),[{text,markdown:text}]);
});

test('local Windows and Unix links become readable text while web links remain Markdown',()=>{
  const text='[报告](<C:\\My Files\\report.docx>)\n![截图](C:/work/image.png)\n[结果](/home/user/out.txt)\n[网页](http://example.com)\n![远程](https://example.com/image.png)';
  const wire=valid(text)[0].markdown;
  assert.ok(wire.includes('报告（C:\\\\My Files\\\\report.docx）'));assert.ok(wire.includes('截图（C:/work/image.png）'));assert.ok(wire.includes('结果（/home/user/out.txt）'));assert.ok(wire.includes('[网页](http://example.com)'));assert.ok(wire.includes('![远程](https://example.com/image.png)'));assert.ok(!wire.includes('[报告]'));assert.ok(!wire.includes('![截图]'));
});

test('balanced parentheses in local paths and relative paths are downgraded',()=>{
  const text='[一](C:/work/dir(test)/file.txt) [二](../data/input.csv) [三](file:///C:/file.txt)';
  const wire=valid(text)[0].markdown;assert.ok(wire.includes('一（C:/work/dir\\(test\\)/file.txt）'));assert.ok(wire.includes('二（../data/input.csv）'));assert.ok(wire.includes('三（file:///C:/file.txt）'));
});

test('links written as inline or fenced code are preserved as code',()=>{
  const text='`[literal](C:/file.txt)`\n\n```text\n[literal](/tmp/file.txt)\n```\n';
  const parts=valid(text);assert.equal(parts.length,1);assert.equal(parts[0].markdown,text);closedFences(parts[0].markdown);
});

test('paragraphs and full lines are preferred without losing CRLF or whitespace',()=>{
  const text='第一段保留。\r\n\r\n第二段内容。\r\n第三行内容。\r\n结尾保留  ';
  const parts=valid(text,22);assert.ok(parts.length>1);assert.equal(parts[0].text,'第一段保留。\r\n\r\n');assert.equal(parts.at(-1).text.endsWith('  '),true);
});

test('long Chinese and emoji text is split without separating surrogate pairs',()=>{
  const text='中文😀🙂🧑‍💻'.repeat(1000),parts=valid(text,37);assert.ok(parts.length>10);assert.equal(parts.map(part=>part.markdown).join(''),text);
});

test('long local links are transformed even when their rendered path spans parts',()=>{
  const text='[长文件](<C:\\'+('目录\\'.repeat(120))+'output.txt>)后续文字';
  const parts=valid(text,41),wire=parts.map(part=>part.markdown).join('');assert.ok(parts.length>2);assert.ok(wire.startsWith('长文件（C:\\\\'));assert.ok(wire.endsWith('output.txt）后续文字'));assert.equal(wire.includes('[长文件]'),false);
});

test('a fenced block is closed and reopened in every continuation part',()=>{
  const text='前言\n\n```javascript\n'+('const value = "中文😀";\n'.repeat(30))+'```\n尾声';
  const parts=valid(text,90);assert.ok(parts.length>2);for(const part of parts)closedFences(part.markdown);assert.ok(parts.some(part=>part.markdown.startsWith('```javascript\n')));
});

test('unbroken code tokens and an unclosed source fence still form closed wire blocks',()=>{
  const text='```python\n'+('😀abc'.repeat(100));
  const parts=valid(text,32);assert.ok(parts.length>2);for(const part of parts)closedFences(part.markdown);
});

test('tilde fences, longer fence markers and CRLF stay within final wire limits',()=>{
  for(const text of ['~~~~text\r\n'+('hello😀\r\n'.repeat(30))+'~~~~\r\n','````text\n'+('```\n'.repeat(30))+'````\n']){for(const part of valid(text,45))closedFences(part.markdown);}
});

test('large fence metadata is shortened only on the wire',()=>{
  const text='```'+('language'.repeat(30))+'\nhello\n```';
  const parts=valid(text,40);for(const part of parts)closedFences(part.markdown);assert.ok(parts[0].markdown.includes('```\n'));
});

test('very small limits degrade oversized fences to escaped text and retain exact source',()=>{
  const text='``````text\n😀abc\n``````';valid(text,4);assert.throws(()=>splitMarkdown('x',0),RangeError);assert.throws(()=>splitMarkdown('x',1),RangeError);
});

test('tables and mathematics receive no invented rendering transformations',()=>{
  const text='| a | b |\n|---|---|\n| 1 | 2 |\n\n$x^2$ and $$y=3$$';assert.deepEqual(valid(text),[{text,markdown:text}]);
});
