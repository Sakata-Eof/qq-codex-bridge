import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readJSONBody } from '../src/http/json-body.mjs';

test('the JSON request reader preserves characters split across UTF-8 chunks', async () => {
  const input = { markdown: '中🙂文' };
  const json = JSON.stringify(input);
  const bytes = Buffer.from(json);
  const firstSplit = bytes.indexOf(Buffer.from('中')) + 1;
  const secondSplit = bytes.indexOf(Buffer.from('🙂')) + 2;
  const request = () => Readable.from([
    bytes.subarray(0, firstSplit),
    bytes.subarray(firstSplit, secondSplit),
    bytes.subarray(secondSplit),
  ], { objectMode: false });

  assert.deepEqual(await readJSONBody(request(), json.length), input);
  await assert.rejects(() => readJSONBody(request(), json.length - 1), /请求过长/);
});
