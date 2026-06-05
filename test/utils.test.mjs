import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile as ef } from 'node:child_process';
import { promisify } from 'node:util';
import { OverleafGitClient } from '../overleaf-mcp-server.js';
import { makeRemote, clientClonePath, readFromRemote } from './helpers.mjs';

const execFile = promisify(ef);
const git = (cwd, a) => execFile('git', ['-C', cwd, ...a]);
function client(r) { return new OverleafGitClient('test', 'tok', clientClonePath(r.root), r.remote); }

test('searchText finds a regex match with file:line', async () => {
  const r = await makeRemote({ 'main.tex': 'a\n\\label{sec:x}\n\\autoref{sec:x}\n' });
  after(() => r.cleanup());
  const res = await client(r).searchText({ query: '\\\\label\\{' });
  assert.equal(res.total, 1);
  assert.match(res.matches[0], /^main\.tex:2:/);
});

test('searchText extension filter + no-match', async () => {
  const r = await makeRemote({ 'main.tex': 'hello\n', 'refs.bib': '@article{onlyinbib, title={X}}\n' });
  after(() => r.cleanup());
  const c = client(r);
  assert.equal((await c.searchText({ query: 'onlyinbib', extension: '.tex' })).total, 0);
  assert.equal((await c.searchText({ query: 'zzz-nomatch' })).total, 0);
});

test('addCitation appends a new entry and pushes', async () => {
  const r = await makeRemote({ 'refs.bib': '@article{a, title={A}}\n' });
  after(() => r.cleanup());
  const res = await client(r).addCitation({ entry: '@book{k1, title={K One}}' });
  assert.equal(res.key, 'k1');
  assert.equal(res.pushed, true);
  const bib = (await readFromRemote(r, 'refs.bib')).toString('utf-8');
  assert.match(bib, /@book\{k1,/);
  assert.match(bib, /@article\{a,/);
});

test('addCitation refuses a duplicate key', async () => {
  const r = await makeRemote({ 'refs.bib': '@article{dup, title={D}}\n' });
  after(() => r.cleanup());
  await assert.rejects(() => client(r).addCitation({ entry: '@misc{dup, title={again}}' }), /already in refs\.bib/i);
});

test('citeLint reports undefined and unused', async () => {
  const r = await makeRemote({
    'main.tex': 'text \\cite{a,b} more \\autocite{a}\n',
    'refs.bib': '@article{a, title={A}}\n@book{c, title={C}}\n',
  });
  after(() => r.cleanup());
  const res = await client(r).citeLint();
  assert.deepEqual(res.undefined, ['b']);
  assert.deepEqual(res.unused, ['c']);
});

test('checkpoint + restore rolls back content via a forward push', async () => {
  const r = await makeRemote({ 'main.tex': 'v1\n' });
  after(() => r.cleanup());
  const c = client(r);
  const cp = await c.checkpoint('p');
  assert.equal(cp.label, 'mcp-snap/p');
  await c.editFile('main.tex', 'v1', 'v2');
  const before = (await git(c.repoPath, ['rev-parse', 'HEAD'])).stdout.trim();
  const res = await c.restore('p');
  assert.equal(res.pushed, true);
  assert.equal((await readFromRemote(r, 'main.tex')).toString('utf-8'), 'v1\n');
  const anc = await git(c.repoPath, ['merge-base', '--is-ancestor', before, 'HEAD']).then(() => 'yes').catch(() => 'no');
  assert.equal(anc, 'yes');
});

test('checkpoint refuses a duplicate label', async () => {
  const r = await makeRemote({ 'main.tex': 'x\n' });
  after(() => r.cleanup());
  const c = client(r);
  await c.checkpoint('dup');
  await assert.rejects(() => c.checkpoint('dup'), /already exists/i);
});

test('restore errors on an unknown label', async () => {
  const r = await makeRemote();
  after(() => r.cleanup());
  await assert.rejects(() => client(r).restore('nope'), /not found/i);
});
