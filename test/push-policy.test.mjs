import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile as ef } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OverleafGitClient, resolvePush } from '../overleaf-mcp-server.js';
import { publishChanges } from '../transactions.js';
import { makeRemote, clientClonePath, readFromRemote } from './helpers.mjs';

const execFile = promisify(ef);
const git = (cwd, a) => execFile('git', ['-C', cwd, ...a]);
const head = async cwd => (await git(cwd, ['rev-parse', 'HEAD'])).stdout.trim();

async function cloned(r) {
  const c = new OverleafGitClient('test', 'tok', clientClonePath(r.root), r.remote);
  await c.cloneOrPull();
  return c;
}

// Make the next `git push` race a concurrent Overleaf edit: the remote moves
// between this client's pull and its push, so the push is rejected.
function raceNextPush(c, r, file, body) {
  const real = c._git.bind(c);
  let armed = true;
  c._git = async (args, opts) => {
    if (armed && args.includes('push')) { armed = false; await r.remoteEdit(file, body); }
    return real(args, opts);
  };
}

// --- policy resolution -------------------------------------------------------

test('resolvePush: explicit push wins, then settings.autoPush, else local', () => {
  assert.equal(resolvePush({}, {}), false);
  assert.equal(resolvePush(undefined, undefined), false);
  assert.equal(resolvePush({ autoPush: true }, {}), true);
  assert.equal(resolvePush({ autoPush: true }, { push: false }), false);
  assert.equal(resolvePush({ autoPush: false }, { push: true }), true);
  assert.equal(resolvePush({ autoPush: 'yes' }, {}), false); // only a real boolean enables pushing
});

// --- local-only mutations ----------------------------------------------------

test('local edit commits without pulling or pushing', async () => {
  const r = await makeRemote({ 'a.tex': 'alpha\n', 'b.tex': 'B\n' });
  after(() => r.cleanup());
  const c = await cloned(r);
  await r.remoteEdit('b.tex', 'B-remote\n');           // would be absorbed by a pull
  const res = await c.editFile('a.tex', 'alpha', 'ALPHA', false, undefined, { push: false });
  assert.equal(res.pushed, false);
  assert.equal(res.committed, true);
  assert.equal(res.unpublished, 1);
  assert.equal(res.head, await head(c.repoPath));
  assert.equal(await c.readFile('b.tex'), 'B\n');       // no pull happened
  assert.equal((await readFromRemote(r, 'a.tex')).toString(), 'alpha\n'); // no push happened
});

test('a refused push rolls back only its own commit; earlier local commits survive', async () => {
  const r = await makeRemote({ 'a.tex': 'alpha\n', 'b.tex': 'B\n' });
  after(() => r.cleanup());
  const c = await cloned(r);
  await c.editFile('a.tex', 'alpha', 'ALPHA', false, undefined, { push: false });
  const local = await head(c.repoPath);
  raceNextPush(c, r, 'b.tex', 'B-remote\n');
  await assert.rejects(() => c.writeFile('c.tex', 'new\n', { push: true }), /refused/);
  assert.equal(await head(c.repoPath), local);          // pre-op HEAD, not origin
  assert.equal(await c.readFile('a.tex'), 'ALPHA\n');    // earlier unpublished edit intact
  assert.ok(!existsSync(path.join(c.repoPath, 'c.tex')));
});

test('publish_changes pushes every accumulated local commit at once', async () => {
  const r = await makeRemote({ 'a.tex': 'alpha\n', 'b.tex': 'beta\n' });
  after(() => r.cleanup());
  const c = await cloned(r);
  await c.editFile('a.tex', 'alpha', 'ALPHA', false, undefined, { push: false });
  const second = await c.editFile('b.tex', 'beta', 'BETA', false, undefined, { push: false });
  assert.equal(second.unpublished, 2);
  await publishChanges(c.repoPath, { revision: second.head }, async () => ({ pass: true }),
    (root, revision, branch) => c._git(['-C', root, 'push', 'origin', `${revision}:refs/heads/${branch}`], { auth: true }));
  assert.equal((await readFromRemote(r, 'a.tex')).toString(), 'ALPHA\n');
  assert.equal((await readFromRemote(r, 'b.tex')).toString(), 'BETA\n');
  assert.equal((await c.pendingState()).unpublished, 0);
});

test('restore without push is a local forward commit', async () => {
  const r = await makeRemote({ 'a.tex': 'v1\n' });
  after(() => r.cleanup());
  const c = await cloned(r);
  await c.checkpoint('p');
  await c.editFile('a.tex', 'v1', 'v2', false, undefined, { push: false });
  const res = await c.restore('p', { push: false });
  assert.equal(res.pushed, false);
  assert.equal(await c.readFile('a.tex'), 'v1\n');
  assert.equal(res.unpublished, 2);                      // the edit and its forward restore
});

// --- sync_project ------------------------------------------------------------

test('sync: up-to-date, ahead, and fast-forward', async () => {
  const r = await makeRemote({ 'a.tex': 'a\n', 'b.tex': 'b\n' });
  after(() => r.cleanup());
  const c = await cloned(r);
  assert.equal((await c.syncProject()).state, 'up-to-date');
  await c.editFile('a.tex', 'a', 'A', false, undefined, { push: false });
  const ahead = await c.syncProject();
  assert.equal(ahead.state, 'ahead');
  assert.equal(ahead.ahead, 1);
  await git(c.repoPath, ['reset', '--hard', 'HEAD~1']);  // drop the local commit
  await r.remoteEdit('b.tex', 'B\n');
  assert.equal((await c.syncProject()).state, 'fast-forwarded');
  assert.equal(await c.readFile('b.tex'), 'B\n');
});

async function divergedClient(r, { localBody = 'A\n', remoteFile = 'b.tex', remoteBody = 'B\n' } = {}) {
  const c = await cloned(r);
  await c.editFile('a.tex', 'a\n', localBody, false, undefined, { push: false });
  await r.remoteEdit(remoteFile, remoteBody);
  return c;
}

test('sync: a diverged clone is reported and left untouched', async () => {
  const r = await makeRemote({ 'a.tex': 'a\n', 'b.tex': 'b\n' });
  after(() => r.cleanup());
  const c = await divergedClient(r);
  const before = await head(c.repoPath);
  const rep = await c.syncProject();
  assert.equal(rep.state, 'diverged');
  assert.equal(rep.ahead, 1);
  assert.equal(rep.behind, 1);
  assert.equal(rep.head, before);
  assert.match(rep.localCommits, /a\.tex/);
  assert.match(rep.remoteCommits, /b\.tex/);
  assert.equal(await head(c.repoPath), before);
});

test('sync rebase: replays local work on top of Overleaf', async () => {
  const r = await makeRemote({ 'a.tex': 'a\n', 'b.tex': 'b\n' });
  after(() => r.cleanup());
  const c = await divergedClient(r);
  const res = await c.syncProject({ strategy: 'rebase' });
  assert.equal(res.state, 'rebased');
  assert.equal(res.unpublished, 1);
  assert.equal(await c.readFile('a.tex'), 'A\n');
  assert.equal(await c.readFile('b.tex'), 'B\n');
});

test('sync rebase: a conflict aborts and leaves local state unchanged', async () => {
  const r = await makeRemote({ 'a.tex': 'a\n', 'b.tex': 'b\n' });
  after(() => r.cleanup());
  const c = await divergedClient(r, { localBody: 'LOCAL\n', remoteFile: 'a.tex', remoteBody: 'REMOTE\n' });
  const before = await head(c.repoPath);
  const res = await c.syncProject({ strategy: 'rebase' });
  assert.equal(res.state, 'rebase-conflict');
  assert.deepEqual(res.conflicts, ['a.tex']);
  assert.equal(await head(c.repoPath), before);
  assert.equal(await c.readFile('a.tex'), 'LOCAL\n');
  assert.equal((await git(c.repoPath, ['status', '--porcelain'])).stdout.trim(), '');
});

test('sync reset: refuses without confirm, then backs up commits and uncommitted edits', async () => {
  const r = await makeRemote({ 'a.tex': 'a\n', 'b.tex': 'b\n' });
  after(() => r.cleanup());
  const c = await divergedClient(r, { localBody: 'LOCAL\n', remoteFile: 'a.tex', remoteBody: 'REMOTE\n' });
  const before = await head(c.repoPath);
  await writeFile(path.join(c.repoPath, 'b.tex'), 'uncommitted\n');
  await assert.rejects(() => c.syncProject({ strategy: 'reset' }), /confirm/);
  await assert.rejects(() => c.syncProject({ strategy: 'reset', confirm: 'deadbeef' }), /confirm/);
  assert.equal(await head(c.repoPath), before);

  const res = await c.syncProject({ strategy: 'reset', confirm: before });
  assert.equal(res.state, 'reset');
  assert.equal(await c.readFile('a.tex'), 'REMOTE\n');
  assert.equal(res.backups.length, 2);
  assert.equal((await git(c.repoPath, ['rev-parse', `${res.backups[0]}^{commit}`])).stdout.trim(), before);
  assert.equal((await git(c.repoPath, ['show', `${res.backups[1]}:b.tex`])).stdout, 'uncommitted\n');
  assert.equal((await git(c.repoPath, ['show', `${res.backups[0]}:a.tex`])).stdout, 'LOCAL\n');
});

// --- lint gate ---------------------------------------------------------------

async function stubLinter() {
  // exit 2 with a finding when the file contains BAD, else exit 0.
  const dir = await mkdtemp(path.join(tmpdir(), 'omcp-lint-'));
  const script = path.join(dir, 'lint.mjs');
  await writeFile(script, "import { readFileSync } from 'node:fs';\nif (readFileSync(process.argv[2], 'utf8').includes('BAD')) { process.stderr.write('found BAD'); process.exit(2); }\n");
  return `node ${script}`;
}

test('lintFiles aggregates findings across files', async () => {
  const r = await makeRemote({ 'a.tex': 'fine\n', 'b.tex': 'BAD\n' });
  after(() => r.cleanup());
  const c = await cloned(r);
  const cmd = await stubLinter();
  assert.equal((await c.lintFiles(['a.tex'], cmd)).clean, true);
  const both = await c.lintFiles(['a.tex', 'b.tex'], cmd);
  assert.equal(both.clean, false);
  assert.deepEqual(both.results.map(x => x.clean), [true, false]);
});

test('verify_build lint: findings fail an otherwise passing build; cached verdict stays clean',
  { skip: !existsSync('/Library/TeX/texbin/latexmk') && 'latexmk not installed' }, async () => {
    const doc = '\\documentclass{article}\\begin{document}Hello\\end{document}\n';
    const r = await makeRemote({ 'main.tex': doc, 'prose.tex': 'BAD prose\n' });
    after(() => r.cleanup());
    const c = await cloned(r);
    const cmd = await stubLinter();
    const plain = await c.verifyBuild('main.tex', 'pdflatex');
    assert.equal(plain.pass, true);
    const linted = await c.verifyBuild('main.tex', 'pdflatex', { lint: ['prose.tex'], lintCommand: cmd });
    assert.equal(linted.pass, false);
    assert.equal(linted.lint.clean, false);
    const again = await c.verifyBuild('main.tex', 'pdflatex');
    assert.equal(again.pass, true);                      // lint never poisons the build cache
    assert.equal(again.lint, undefined);
    const all = await c.verifyBuild('main.tex', 'pdflatex', { lint: true, lintCommand: cmd });
    assert.deepEqual(all.lint.results.map(x => x.file).sort(), ['main.tex', 'prose.tex']);
  });

// --- section reads -----------------------------------------------------------

test('getSectionContent covers \\paragraph and refuses an ambiguous title', async () => {
  const r = await makeRemote({ 'main.tex': '\\section{A}\n\\paragraph{P}pbody\n\\section{B}x\n\\section{B}y\n' });
  after(() => r.cleanup());
  const c = await cloned(r);
  assert.equal(await c.getSectionContent('main.tex', 'P'), '\\paragraph{P}pbody\n');
  await assert.rejects(() => c.getSectionContent('main.tex', 'B'), /found 2/);
});
