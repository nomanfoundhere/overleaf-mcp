import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile as ef } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applyChanges } from '../transactions.js';

const execFile = promisify(ef);
const git = (cwd, args) => execFile('git', ['-C', cwd, ...args]);
const hash = value => createHash('sha256').update(Buffer.from(value)).digest('hex');

async function repo(files) {
  const root = await mkdtemp(path.join(tmpdir(), 'overleaf-transactions-test-'));
  await execFile('git', ['init', '-b', 'master', root]);
  await git(root, ['config', 'user.name', 'Test']);
  await git(root, ['config', 'user.email', 'test@example.test']);
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, name);
    await writeFile(target, content);
    await git(root, ['add', name]);
  }
  await git(root, ['commit', '-m', 'seed']);
  return root;
}

const cleanup = [];
after(async () => { await Promise.all(cleanup.map(root => rm(root, { recursive: true, force: true }))); });

test('applyChanges rejects a stale revision before creating a worktree', async () => {
  const root = await repo({ 'main.tex': 'one\n' });
  cleanup.push(root);
  const { stdout } = await git(root, ['rev-parse', 'HEAD']);
  const stale = stdout.trim();
  await writeFile(path.join(root, 'main.tex'), 'two\n');
  await git(root, ['add', 'main.tex']);
  await git(root, ['commit', '-m', 'advance']);
  await assert.rejects(
    () => applyChanges(root, { baseRevision: stale, changes: [] }, async () => ({ passed: true })),
    err => err.code === 'stale_revision',
  );
});

test('failed verification leaves the original checkout untouched', async () => {
  const root = await repo({ 'main.tex': 'one\n' });
  cleanup.push(root);
  const revision = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();
  await assert.rejects(
    () => applyChanges(root, { baseRevision: revision, changes: [{ filePath: 'main.tex', baseHash: hash('one\n'), content: 'two\n' }] }, async () => ({ pass: false, errors: ['bad build'] })),
    err => err.code === 'verification_failed',
  );
  assert.equal(await readFile(path.join(root, 'main.tex'), 'utf8'), 'one\n');
  assert.equal((await git(root, ['status', '--porcelain'])).stdout, '');
  assert.equal((await git(root, ['rev-parse', 'HEAD'])).stdout.trim(), revision);
});

test('successful verification applies a multi-file batch in one commit', async () => {
  const root = await repo({ 'main.tex': 'one\n', 'notes.txt': 'old\n' });
  cleanup.push(root);
  const revision = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();
  const result = await applyChanges(root, {
    baseRevision: revision,
    changes: [
      { filePath: 'main.tex', baseHash: hash('one\n'), content: 'two\n' },
      { filePath: 'notes.txt', baseHash: hash('old\n'), content: 'new\n' },
      { filePath: 'new.txt', baseHash: null, content: 'created\n' },
    ],
  }, async stageRoot => {
    assert.equal(await readFile(path.join(stageRoot, 'main.tex'), 'utf8'), 'two\n');
    return { passed: true, pageCount: 1 };
  });
  assert.deepEqual(result.files, ['main.tex', 'notes.txt', 'new.txt']);
  assert.notEqual(result.revision, revision);
  assert.equal(await readFile(path.join(root, 'main.tex'), 'utf8'), 'two\n');
  assert.equal(await readFile(path.join(root, 'notes.txt'), 'utf8'), 'new\n');
  assert.equal(await readFile(path.join(root, 'new.txt'), 'utf8'), 'created\n');
  assert.equal((await git(root, ['rev-list', '--count', 'HEAD'])).stdout.trim(), '2');
  assert.equal((await git(root, ['status', '--porcelain'])).stdout, '');
});

test('rejects paths that target Git metadata', async () => {
  const root = await repo({ 'main.tex': 'one\n' });
  cleanup.push(root);
  const revision = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();
  await assert.rejects(
    () => applyChanges(root, { baseRevision: revision, changes: [{ filePath: '.git/config', baseHash: null, content: 'nope' }] }, async () => ({ passed: true })),
    err => err.code === 'invalid_path',
  );
});

test('allows pre-existing untracked build artifacts while applying tracked edits', async () => {
  const root = await repo({ 'main.tex': 'one\n' });
  cleanup.push(root);
  await writeFile(path.join(root, 'main.aux'), 'build artifact\n');
  const revision = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();
  const result = await applyChanges(root, { baseRevision: revision, changes: [{ filePath: 'main.tex', baseHash: hash('one\n'), content: 'two\n' }] }, async () => ({ passed: true }));
  assert.equal(result.files[0], 'main.tex');
  assert.equal(await readFile(path.join(root, 'main.aux'), 'utf8'), 'build artifact\n');
});

test('rejects a new-file change when the target already exists', async () => {
  const root = await repo({ 'main.tex': 'one\n', 'already.txt': 'present\n' });
  cleanup.push(root);
  const revision = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();
  await assert.rejects(
    () => applyChanges(root, { baseRevision: revision, changes: [{ filePath: 'already.txt', baseHash: null, content: 'replace\n' }] }, async () => ({ passed: true })),
    err => err.code === 'stale_file',
  );
});

async function addRemote(root) {
  const remote = await mkdtemp(path.join(tmpdir(), 'overleaf-publish-remote-'));
  cleanup.push(remote);
  await execFile('git', ['init', '--bare', remote]);
  await git(root, ['remote', 'add', 'origin', remote]);
  await git(root, ['push', '-u', 'origin', 'master']);
}

test('publish verification failure never invokes push', async () => {
  const root = await repo({ 'main.tex': 'one\n' });
  cleanup.push(root);
  await addRemote(root);
  const revision = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();
  let pushed = false;
  await assert.rejects(
    () => import('../transactions.js').then(({ publishChanges }) => publishChanges(root, { revision }, async () => ({ pass: false }), async () => { pushed = true; })),
    err => err.code === 'verification_failed',
  );
  assert.equal(pushed, false);
});

test('publish rejects a HEAD change made during verification', async () => {
  const root = await repo({ 'main.tex': 'one\n' });
  cleanup.push(root);
  await addRemote(root);
  const revision = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();
  let pushed = false;
  const { publishChanges } = await import('../transactions.js');
  await assert.rejects(
    () => publishChanges(root, { revision }, async () => {
      await writeFile(path.join(root, 'main.tex'), 'advanced\n');
      await git(root, ['add', 'main.tex']);
      await git(root, ['commit', '-m', 'concurrent change']);
      return { passed: true };
    }, async () => { pushed = true; }),
    err => err.code === 'stale_revision',
  );
  assert.equal(pushed, false);
});

test('successful publish callback receives the exact revision SHA', async () => {
  const root = await repo({ 'main.tex': 'one\n' });
  cleanup.push(root);
  await addRemote(root);
  const revision = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();
  let callbackArgs;
  const { publishChanges } = await import('../transactions.js');
  const result = await publishChanges(root, { revision }, async () => ({ pass: true, pageCount: 1 }), async (...args) => { callbackArgs = args; });
  assert.equal(callbackArgs[1], revision);
  assert.equal(callbackArgs[2], 'master');
  assert.equal(result.revision, revision);
});
