import test from 'node:test';
import assert from 'node:assert/strict';
import { splitMarkdown } from './qq-markdown.mjs';

test('random Markdown fragments preserve exact source and stay within the wire limit', () => {
  let seed = 123456789;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const atoms = ['中文', '😀', '\n', '\r\n', '```js\n', '```\n', '~~~\n', '[文件](C:/a.txt)', '`literal`', ' ', '[x](../file.txt)'];
  for (let example = 0; example < 500; example++) {
    let text = '';
    for (let n = 0; n < 20; n++) text += atoms[Math.floor(random() * atoms.length)];
    const limit = 20 + Math.floor(random() * 110);
    const parts = splitMarkdown(text, limit);
    assert.equal(parts.map(part => part.text).join(''), text);
    for (const part of parts) {
      assert(part.markdown.length <= limit);
      assert(!/[\uD800-\uDBFF]$/.test(part.text));
      assert(!/^[\uDC00-\uDFFF]/.test(part.text));
    }
  }
});
