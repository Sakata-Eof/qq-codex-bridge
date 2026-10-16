import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { History } from '../../history-db.mjs';
import { splitMarkdown } from '../../qq-markdown.mjs';

// This benchmark uses only generated records in a temporary database, never runtime/.
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-codex-benchmark-'));
const history = new History({ appId: 'synthetic-benchmark', users: [] }, temporary);
const report = { syntheticRecords: 10000, productionDataTouched: false };
function measure(fn, rounds = 25) {
  for (let i = 0; i < 3; i++) fn();
  const samples = [];
  for (let i = 0; i < rounds; i++) {
    const start = performance.now();
    fn();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  return { medianMs: +samples[Math.floor(samples.length / 2)].toFixed(3), p95Ms: +samples[Math.floor(samples.length * .95)].toFixed(3) };
}
try {
  history.transaction(() => {
    for (const user of ['A', 'B']) for (let i = 0; i < 2500; i++) {
      const base = { messageId: 'event-' + i, threadId: i % 7 ? 'main' : 'other' };
      const time = step => new Date(Date.UTC(2026, 9, 16, 0, 0, i * 4 + step)).toISOString();
      const text = 'result ' + i + ' ' + '中文😀'.repeat(i % 4 === 1 ? 70 : 3);
      history.record(user, { ...base, recordId: 'result-' + i, time: time(0), kind: 'result', text, status: 'completed', turnId: 'turn-' + i });
      const outbound = i % 4 === 1 ? text.slice(0, 40) + '\n（结果较长，完整内容保存在本机配置页。）' : i % 4 === 2 ? text + ' unmatched' : text;
      history.record(user, { ...base, recordId: 'sent-' + i, time: time(1), kind: 'outbound', text: outbound, ...(i % 4 === 3 ? { file: 'synthetic.txt' } : {}) });
    }
  });
  const indexedStmt = history.stmt.bind(history);
  const legacyStmt = sql => indexedStmt(sql.replace(' INDEXED BY messages_event', ''));
  let equivalentPages = 0;
  for (const user of ['A', 'B']) for (const limit of [1, 20, 30, 100]) {
    let before = '';
    for (let page = 0; page < 8; page++) {
      history.stmt = legacyStmt;
      const expected = history.page(user, { thread: 'main', before, limit });
      history.stmt = indexedStmt;
      const actual = history.page(user, { thread: 'main', before, limit });
      assert.deepEqual(actual, expected);
      equivalentPages++;
      before = expected.next;
      if (!before) break;
    }
  }
  history.stmt = legacyStmt;
  const beforeIndex = measure(() => history.page('B', { thread: 'main', limit: 100 }));
  history.stmt = indexedStmt;
  const afterIndex = measure(() => history.page('B', { thread: 'main', limit: 100 }));
  report.history = { pageSize: 100, equivalentPages, before: beforeIndex, after: afterIndex };

  // Reconstruct the prior inner scan for a differential comparison of this optimization.
  // Fail explicitly if a later implementation no longer matches this baseline transform.
  const source = fs.readFileSync(new URL('../../qq-markdown.mjs', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
  const current = `let renderedLength=0,lastChar='',lastValid=cursor,paragraph=cursor,line=cursor;
    for(let end=cursor;end<units.length;end++){
      const unit=units[end],nextLength=renderedLength+unit.markdown.length,nextChar=unit.markdown?unit.markdown.at(-1):lastChar;
      const suffixLength=unit.fenceAfter?.enabled?(nextChar==='\\r'||nextChar==='\\n'?0:1)+unit.fenceAfter.marker.length:0;
      if(prefix.length+nextLength+suffixLength>limit)break;
      renderedLength=nextLength;lastChar=nextChar;lastValid=end+1;`;
  const legacy = `let rendered='',lastValid=cursor,paragraph=cursor,line=cursor;
    for(let end=cursor;end<units.length;end++){
      const unit=units[end],next=rendered+unit.markdown;
      if(prefix.length+next.length+suffix(unit.fenceAfter,next).length>limit)break;
      rendered=next;lastValid=end+1;`;
  assert(source.includes(current), 'Update the benchmark baseline transform for the new splitter');
  const { splitMarkdown: previousSplit } = await import('data:text/javascript;base64,' + Buffer.from(source.replace(current, legacy)).toString('base64'));
  let seed = 123456789;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const atoms = ['a', '中文', '😀', '\n', '\r\n', '\n\n', '```js\n', '```\n', '~~~\n', '[文件](C:/a.txt)', '`literal`', ' ', '[x](../file.txt)'];
  for (let index = 0; index < 500; index++) {
    let text = '';
    for (let n = 0; n < 20; n++) text += atoms[Math.floor(random() * atoms.length)];
    const limit = 2 + Math.floor(random() * 90);
    let expected, failure;
    try { expected = previousSplit(text, limit); } catch (error) { failure = error; }
    if (failure) assert.throws(() => splitMarkdown(text, limit), { name: failure.name, message: failure.message });
    else assert.deepEqual(splitMarkdown(text, limit), expected);
  }
  const cases = [
    ['prose', '说明中文😀。\n\n- item one\n- item two\n'.repeat(1500)],
    ['fenced-code', '```javascript\n' + 'const value = "中文😀";\n'.repeat(6000) + '```'],
    ['local-links', '[文件](<C:\\目录\\file(test).txt>) 和 [网站](https://example.com)\n'.repeat(1600)],
  ];
  report.markdown = { equivalentRandomCases: 500, cases: [] };
  for (const [name, text] of cases) {
    assert.deepEqual(splitMarkdown(text, 1300), previousSplit(text, 1300));
    report.markdown.cases.push({ name, utf16Length: text.length, before: measure(() => previousSplit(text, 1300), 15), after: measure(() => splitMarkdown(text, 1300), 15) });
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  history.close();
  const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(temporary));
  assert(relative.startsWith('qq-codex-benchmark-') && !relative.includes(path.sep), 'Cleanup must stay in the generated temporary directory');
  fs.rmSync(temporary, { recursive: true, force: true });
}
