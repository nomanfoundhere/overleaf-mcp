import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { OverleafGitClient } from '../overleaf-mcp-server.js';
import { makeRemote, clientClonePath } from './helpers.mjs';

function client(r) {
  return new OverleafGitClient('test', 'tok', clientClonePath(r.root), r.remote);
}

test('getBlobSha returns a stable 40-hex sha for an existing file', async () => {
  const r = await makeRemote({ 'main.tex': 'hello\n' });
  after(() => r.cleanup());
  const c = client(r);
  const sha = await c.getBlobSha('main.tex');
  assert.match(sha, /^[0-9a-f]{40}$/);
  assert.equal(sha, await c.getBlobSha('main.tex')); // stable when unchanged
});

test('getBlobSha returns null for a missing file', async () => {
  const r = await makeRemote();
  after(() => r.cleanup());
  assert.equal(await client(r).getBlobSha('nope.tex'), null);
});
