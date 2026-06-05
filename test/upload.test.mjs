import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile as ef } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OverleafGitClient } from '../overleaf-mcp-server.js';
import { makeRemote, clientClonePath, readFromRemote } from './helpers.mjs';

const execFile = promisify(ef);
const git = (cwd, a) => execFile('git', ['-C', cwd, ...a]);
function client(r) { return new OverleafGitClient('test', 'tok', clientClonePath(r.root), r.remote); }

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]; // PNG magic + null + 0xff (not valid UTF-8)

async function tmpBinary(bytes) {
  const dir = await mkdtemp(path.join(tmpdir(), 'omcp-src-'));
  const p = path.join(dir, 'src.bin');
  const buf = Buffer.from(bytes);
  await writeFile(p, buf);
  return { p, buf };
}

test('uploadFile lands bytes identical in the pushed remote', async () => {
  const r = await makeRemote({ 'main.tex': 'm\n' });
  after(() => r.cleanup());
  const c = client(r);
  const { p, buf } = await tmpBinary(PNG);
  const res = await c.uploadFile({ srcPath: p, destPath: 'figures/fig1.png' });
  assert.equal(res.pushed, true);
  assert.equal(Buffer.compare(await readFromRemote(r, 'figures/fig1.png'), buf), 0);
});

test('uploadFile creates nested dirs for a new file', async () => {
  const r = await makeRemote({ 'main.tex': 'm\n' });
  after(() => r.cleanup());
  const c = client(r);
  const { p } = await tmpBinary(PNG);
  const res = await c.uploadFile({ srcPath: p, destPath: 'figures/sub/fig.png' });
  assert.equal(res.pushed, true);
  assert.deepEqual(res.files, ['figures/sub/fig.png']);
});

test('uploadFile refuses an existing file without baseSha or overwrite', async () => {
  const r = await makeRemote({ 'figures/x.png': 'old' });
  after(() => r.cleanup());
  const c = client(r);
  const { p } = await tmpBinary(PNG);
  await assert.rejects(() => c.uploadFile({ srcPath: p, destPath: 'figures/x.png' }), /already exists|overwrite/i);
});

test('uploadFile overwrites with overwrite:true', async () => {
  const r = await makeRemote({ 'figures/x.png': 'old' });
  after(() => r.cleanup());
  const c = client(r);
  const { p, buf } = await tmpBinary(PNG);
  const res = await c.uploadFile({ srcPath: p, destPath: 'figures/x.png', overwrite: true });
  assert.equal(res.pushed, true);
  assert.equal(Buffer.compare(await readFromRemote(r, 'figures/x.png'), buf), 0);
});

test('uploadFile refuses a stale baseSha in single mode', async () => {
  const r = await makeRemote({ 'figures/x.png': 'old' });
  after(() => r.cleanup());
  const c = client(r);
  const stale = await c.getBlobSha('figures/x.png');
  await r.remoteEdit('figures/x.png', 'changed-on-overleaf');
  const { p } = await tmpBinary(PNG);
  await assert.rejects(() => c.uploadFile({ srcPath: p, destPath: 'figures/x.png', baseSha: stale }), /changed on Overleaf|stale/i);
});

test('uploadFile rejects a destPath escaping the repo', async () => {
  const r = await makeRemote();
  after(() => r.cleanup());
  const c = client(r);
  const { p } = await tmpBinary(PNG);
  await assert.rejects(() => c.uploadFile({ srcPath: p, destPath: '../evil.png' }), /escape|not allowed/i);
  await assert.rejects(() => c.uploadFile({ srcPath: p, destPath: '/tmp/evil.png' }), /escape|not allowed/i);
});

test('uploadFile errors clearly on a missing srcPath', async () => {
  const r = await makeRemote();
  after(() => r.cleanup());
  const c = client(r);
  await assert.rejects(() => c.uploadFile({ srcPath: '/no/such/file.png', destPath: 'figures/a.png' }), /not found|unreadable/i);
});

test('uploadFile batch lands both files in ONE commit', async () => {
  const r = await makeRemote({ 'main.tex': 'm\n' });
  after(() => r.cleanup());
  const c = client(r);
  await c.cloneOrPull();
  const before = Number((await git(c.repoPath, ['rev-list', '--count', 'HEAD'])).stdout.trim());
  const a = await tmpBinary(PNG);
  const b = await tmpBinary([0x01, 0x02, 0x03]);
  const res = await c.uploadFile({ files: [
    { srcPath: a.p, destPath: 'figures/f1.png' },
    { srcPath: b.p, destPath: 'figures/f2.png' },
  ] });
  assert.equal(res.pushed, true);
  assert.equal(res.files.length, 2);
  const afterN = Number((await git(c.repoPath, ['rev-list', '--count', 'HEAD'])).stdout.trim());
  assert.equal(afterN - before, 1, 'exactly one new commit for the batch');
  assert.equal(Buffer.compare(await readFromRemote(r, 'figures/f1.png'), a.buf), 0);
  assert.equal(Buffer.compare(await readFromRemote(r, 'figures/f2.png'), b.buf), 0);
});

test('uploadFile batch is all-or-nothing (one refused -> none written, tree clean)', async () => {
  const r = await makeRemote({ 'figures/exists.png': 'old' });
  after(() => r.cleanup());
  const c = client(r);
  const a = await tmpBinary(PNG);
  const b = await tmpBinary([0x09]);
  await assert.rejects(() => c.uploadFile({ files: [
    { srcPath: a.p, destPath: 'figures/new.png' },     // would be fine
    { srcPath: b.p, destPath: 'figures/exists.png' },  // exists, no overwrite -> refuse whole batch
  ] }), /already exists|overwrite/i);
  const status = (await git(c.repoPath, ['status', '--porcelain'])).stdout.trim();
  assert.equal(status, '', 'working tree must be clean (nothing copied)');
  await assert.rejects(() => readFromRemote(r, 'figures/new.png')); // never pushed
});
