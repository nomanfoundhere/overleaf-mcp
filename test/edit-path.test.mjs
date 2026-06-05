import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { OverleafGitClient } from '../overleaf-mcp-server.js';
import { makeRemote, clientClonePath } from './helpers.mjs';
import { execFile as ef } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile as wf } from 'node:fs/promises';
import path from 'node:path';
const execFile = promisify(ef);
const git = (cwd, a) => execFile('git', ['-C', cwd, ...a]);

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

// Build a local commit that diverges from the remote, then push a remote commit,
// so the client's next push is a non-fast-forward.
async function diverge(r, c, { localFile, localBody, remoteFile, remoteBody }) {
  await c.cloneOrPull();                        // client clone at R0
  await wf(path.join(c.repoPath, localFile), localBody, 'utf-8');
  await git(c.repoPath, ['add', localFile]);
  await git(c.repoPath, ['commit', '-m', 'local edit']);
  await r.remoteEdit(remoteFile, remoteBody);   // remote advances to R1
}

test('_pushWithMerge auto-merges a non-overlapping divergence', async () => {
  const r = await makeRemote({ 'a.tex': 'A\n', 'b.tex': 'B\n' });
  after(() => r.cleanup());
  const c = client(r);
  await diverge(r, c, { localFile: 'a.tex', localBody: 'A-local\n', remoteFile: 'b.tex', remoteBody: 'B-remote\n' });
  await c._pushWithMerge();
  await c.cloneOrPull();
  assert.equal((await c.readFile('a.tex')), 'A-local\n');   // both survive
  assert.equal((await c.readFile('b.tex')), 'B-remote\n');
});

test('_pushWithMerge refuses + resets clean on an overlapping divergence', async () => {
  const r = await makeRemote({ 'a.tex': 'line\n' });
  after(() => r.cleanup());
  const c = client(r);
  await diverge(r, c, { localFile: 'a.tex', localBody: 'local\n', remoteFile: 'a.tex', remoteBody: 'remote\n' });
  await assert.rejects(() => c._pushWithMerge(), /conflict/i);
  const { stdout } = await git(c.repoPath, ['status', '--porcelain']);
  assert.equal(stdout.trim(), '');              // clean, no merge leftovers
});

test('editFile replaces a unique anchor and pushes', async () => {
  const r = await makeRemote({ 'main.tex': 'alpha beta gamma\n' });
  after(() => r.cleanup());
  const c = client(r);
  const res = await c.editFile('main.tex', 'beta', 'BETA');
  assert.equal(res.pushed, true);
  assert.equal(await c.readFile('main.tex'), 'alpha BETA gamma\n');
});

test('editFile refuses when the anchor is absent (changed on Overleaf)', async () => {
  const r = await makeRemote({ 'main.tex': 'alpha\n' });
  after(() => r.cleanup());
  const c = client(r);
  await assert.rejects(() => c.editFile('main.tex', 'ZZZ', 'q'), /not found/i);
});

test('editFile refuses an ambiguous anchor without replaceAll', async () => {
  const r = await makeRemote({ 'main.tex': 'x x\n' });
  after(() => r.cleanup());
  const c = client(r);
  await assert.rejects(() => c.editFile('main.tex', 'x', 'y'), /2 times|ambiguous/i);
});

test('editFile replaceAll replaces every occurrence', async () => {
  const r = await makeRemote({ 'main.tex': 'x x x\n' });
  after(() => r.cleanup());
  const c = client(r);
  await c.editFile('main.tex', 'x', 'y', true);
  assert.equal(await c.readFile('main.tex'), 'y y y\n');
});

test('editFile absorbs a non-overlapping concurrent edit (pull-first)', async () => {
  const r = await makeRemote({ 'main.tex': 'top\nbottom\n' });
  after(() => r.cleanup());
  const c = client(r);
  await c.cloneOrPull();
  await r.remoteEdit('main.tex', 'TOP\nbottom\n');     // remote changes a different line
  await c.editFile('main.tex', 'bottom', 'BOTTOM');    // pull-first picks up TOP
  assert.equal(await c.readFile('main.tex'), 'TOP\nBOTTOM\n');
});

test('writeFile creates a new file freely', async () => {
  const r = await makeRemote({ 'main.tex': 'm\n' });
  after(() => r.cleanup());
  const c = client(r);
  const res = await c.writeFile('new.tex', 'fresh\n');
  assert.equal(res.pushed, true);
  assert.equal(await c.readFile('new.tex'), 'fresh\n');
});

test('writeFile overwrites an existing file when baseSha matches', async () => {
  const r = await makeRemote({ 'main.tex': 'one\n' });
  after(() => r.cleanup());
  const c = client(r);
  const base = await c.getBlobSha('main.tex');
  const res = await c.writeFile('main.tex', 'two\n', { baseSha: base });
  assert.equal(res.pushed, true);
  assert.equal(await c.readFile('main.tex'), 'two\n');
});

test('writeFile refuses a stale baseSha (file changed on Overleaf)', async () => {
  const r = await makeRemote({ 'main.tex': 'one\n' });
  after(() => r.cleanup());
  const c = client(r);
  const stale = await c.getBlobSha('main.tex');
  await r.remoteEdit('main.tex', 'edited-on-overleaf\n');
  await assert.rejects(() => c.writeFile('main.tex', 'two\n', { baseSha: stale }), /changed on Overleaf|stale/i);
  assert.equal(await c.readFile('main.tex'), 'edited-on-overleaf\n'); // untouched
});

test('writeFile refuses overwrite of an existing file without baseSha or overwrite', async () => {
  const r = await makeRemote({ 'main.tex': 'one\n' });
  after(() => r.cleanup());
  const c = client(r);
  await assert.rejects(() => c.writeFile('main.tex', 'two\n'), /overwrite|edit_file/i);
});

test('writeFile overwrites without baseSha when overwrite:true', async () => {
  const r = await makeRemote({ 'main.tex': 'one\n' });
  after(() => r.cleanup());
  const c = client(r);
  const res = await c.writeFile('main.tex', 'forced\n', { overwrite: true });
  assert.equal(res.pushed, true);
  assert.equal(await c.readFile('main.tex'), 'forced\n');
});
