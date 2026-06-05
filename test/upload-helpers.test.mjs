import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeRemote, readFromRemote } from './helpers.mjs';

test('makeRemote seeds a subdir file and readFromRemote returns its bytes', async () => {
  const r = await makeRemote({ 'figures/x.png': 'old' });
  after(() => r.cleanup());
  const got = await readFromRemote(r, 'figures/x.png');
  assert.equal(got.toString('utf-8'), 'old');
});
