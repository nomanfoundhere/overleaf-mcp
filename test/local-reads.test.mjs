import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { OverleafGitClient } from '../overleaf-mcp-server.js';
import { makeRemote, clientClonePath } from './helpers.mjs';

test('local read tools preserve the synchronized snapshot and never fetch', async t => {
  const remote = await makeRemote({
    'main.tex': '\\section{Local} local text \\cite{one}\n',
    'refs.bib': '@article{one,title={One}}\n',
  });
  t.after(() => remote.cleanup());
  const client = new OverleafGitClient('test', 'token', clientClonePath(remote.root), remote.remote);
  await client.cloneOrPull();
  await writeFile(path.join(client.repoPath, 'main.tex'), '\\section{Draft} local draft \\cite{one}\n');
  await remote.remoteEdit('main.tex', '\\section{Remote} remote text \\cite{one}\n');

  const originalGit = client._git.bind(client);
  client._git = async (args, options) => {
    assert.ok(!args.some(arg => ['clone', 'pull', 'fetch'].includes(arg)), `read attempted synchronization: ${args.join(' ')}`);
    return originalGit(args, options);
  };

  assert.deepEqual(await client.listFiles('.tex'), ['main.tex']);
  assert.match(await client.readFile('main.tex'), /local draft/);
  assert.match(await client.getSectionContent('main.tex', 'Draft'), /local draft/);
  assert.equal((await client.getSections('main.tex'))[0].title, 'Draft');
  assert.match(await client.getBlobSha('main.tex'), /^[0-9a-f]{40}$/);
  assert.equal((await client.searchText({ query: 'local draft', fixed: true })).total, 1);
  assert.deepEqual((await client.citeLint()).undefined, []);
});

test('local reads reject a missing clone and an existing path outside it', async t => {
  const remote = await makeRemote({ 'main.tex': 'local\n' });
  t.after(() => remote.cleanup());
  const client = new OverleafGitClient('test', 'token', clientClonePath(remote.root), remote.remote);
  await assert.rejects(() => client.readFile('main.tex'), /sync_project/);
  await client.cloneOrPull();
  const outside = path.join(remote.root, 'outside.tex');
  await writeFile(outside, 'secret');
  await assert.rejects(() => client.readFile('../outside.tex'), /inside the project/);
});
