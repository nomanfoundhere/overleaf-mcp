import { execFile as ef } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const execFile = promisify(ef);
const git = (cwd, args) => execFile('git', ['-C', cwd, ...args]);

// Stand up a bare repo (the fake "Overleaf remote") seeded with `files`,
// on branch master. Returns { remote, seedClone, cleanup }.
export async function makeRemote(files = { 'main.tex': 'hello\n' }) {
  const root = await mkdtemp(path.join(tmpdir(), 'omcp-'));
  const remote = path.join(root, 'remote.git');
  const seed = path.join(root, 'seed');
  await execFile('git', ['init', '--bare', '-b', 'master', remote]);
  await execFile('git', ['clone', remote, seed]);
  await git(seed, ['config', 'user.email', 'seed@test']);
  await git(seed, ['config', 'user.name', 'Seed']);
  for (const [name, body] of Object.entries(files)) {
    const fp = path.join(seed, name);
    await mkdir(path.dirname(fp), { recursive: true });
    await writeFile(fp, body, 'utf-8');
    await git(seed, ['add', name]);
  }
  await git(seed, ['commit', '-m', 'seed']);
  await git(seed, ['push', 'origin', 'master']);
  return {
    remote,
    seedClone: seed,
    root,
    // simulate a concurrent Overleaf edit: commit `body` to `name` and push to the remote
    async remoteEdit(name, body) {
      await git(seed, ['pull', '--ff-only']);
      const fp = path.join(seed, name);
      await mkdir(path.dirname(fp), { recursive: true });
      await writeFile(fp, body, 'utf-8');
      await git(seed, ['add', name]);
      await git(seed, ['commit', '-m', `remote edit ${name}`]);
      await git(seed, ['push', 'origin', 'master']);
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

// Fresh client clone dir under the same temp root.
export function clientClonePath(root) {
  return path.join(root, 'client');
}

// Pull the seed clone and read a pushed file's raw bytes (Buffer) — for verifying uploads.
export async function readFromRemote(r, relPath) {
  await git(r.seedClone, ['pull', '--ff-only']);
  return readFile(path.join(r.seedClone, relPath));
}

// Assert the client clone is clean and at the remote tip.
export async function assertClean(repoPath) {
  const { stdout: status } = await git(repoPath, ['status', '--porcelain']);
  if (status.trim() !== '') throw new Error(`working tree dirty:\n${status}`);
  const { stdout: local } = await git(repoPath, ['rev-parse', 'HEAD']);
  const { stdout: remote } = await git(repoPath, ['rev-parse', '@{u}']);
  if (local.trim() !== remote.trim()) throw new Error('HEAD != upstream');
}
