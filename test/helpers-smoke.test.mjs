import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { makeRemote } from './helpers.mjs';

test('makeRemote seeds a bare remote with main.tex', async () => {
  const r = await makeRemote({ 'main.tex': 'seeded\n' });
  after(() => r.cleanup());
  const body = await readFile(path.join(r.seedClone, 'main.tex'), 'utf-8');
  assert.equal(body, 'seeded\n');
});
