import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

const execFile = promisify(execFileCallback);

class TransactionError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'TransactionError';
    this.code = code;
  }
}

const git = (cwd, args) => execFile('git', ['-C', cwd, ...args], { maxBuffer: 10 * 1024 * 1024 });

async function gitText(cwd, args) {
  const { stdout } = await git(cwd, args);
  return stdout.trim();
}

function fail(code, message, cause) {
  throw new TransactionError(code, message, cause);
}

async function status(root) {
  // Verification tools commonly leave generated, untracked artifacts behind.
  // Tracked edits still make the checkout dirty and are rejected below.
  return gitText(root, ['status', '--porcelain=v1', '--untracked-files=no']);
}

async function head(root) {
  return gitText(root, ['rev-parse', 'HEAD']);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function ensureNoSymlink(root, filePath) {
  const absolute = path.resolve(root, filePath);
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) fail('invalid_path', `Path escapes repository: ${filePath}`);
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) fail('symlink_path', `Symlink path is not allowed: ${filePath}`);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      break;
    }
  }
  return absolute;
}

function validateUtf8(content) {
  if (typeof content !== 'string') fail('invalid_content', 'Change content must be a UTF-8 string');
  const bytes = Buffer.from(content, 'utf8');
  if (bytes.toString('utf8') !== content) fail('invalid_content', 'Change content is not valid UTF-8');
  return bytes;
}

async function validateChanges(root, changes) {
  if (!Array.isArray(changes)) fail('invalid_changes', 'changes must be an array');
  const seen = new Set();
  const checked = [];
  for (const change of changes) {
    if (!change || typeof change.filePath !== 'string' || change.filePath.includes('\0')) fail('invalid_path', 'Each change needs a valid filePath');
    const normalized = path.normalize(change.filePath);
    if (path.isAbsolute(change.filePath) || normalized === '.' || normalized.startsWith('..' + path.sep) || normalized === '..' || normalized === '.git' || normalized.startsWith(`.git${path.sep}`)) fail('invalid_path', `Invalid file path: ${change.filePath}`);
    if (seen.has(normalized)) fail('duplicate_path', `Duplicate file path: ${change.filePath}`);
    seen.add(normalized);
    if (change.baseHash !== null && (typeof change.baseHash !== 'string' || !/^[0-9a-f]{64}$/i.test(change.baseHash))) fail('invalid_hash', `baseHash must be a SHA-256 hex digest or null: ${change.filePath}`);
    const bytes = validateUtf8(change.content);
    const absolute = await ensureNoSymlink(root, normalized);
    let current = null;
    try {
      const st = await lstat(absolute);
      if (st.isSymbolicLink()) fail('symlink_path', `Symlink target is not allowed: ${change.filePath}`);
      if (!st.isFile()) fail('invalid_path', `Change target is not a regular file: ${change.filePath}`);
      current = await readFile(absolute);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    const actualHash = current === null ? null : sha256(current);
    if (actualHash !== change.baseHash) fail('stale_file', `Base hash does not match ${change.filePath}`);
    if (change.baseHash === null && current !== null) fail('stale_file', `New file already exists: ${change.filePath}`);
    checked.push({ filePath: normalized, bytes, baseHash: change.baseHash });
  }
  return checked;
}

async function assertCleanAt(root, expectedHead, checked) {
  if (await head(root) !== expectedHead) fail('stale_revision', 'Repository HEAD changed during the transaction');
  if (await status(root) !== '') fail('dirty_checkout', 'Repository working tree changed during the transaction');
  for (const change of checked) {
    const absolute = await ensureNoSymlink(root, change.filePath);
    let bytes = null;
    try { bytes = await readFile(absolute); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    if ((bytes === null ? null : sha256(bytes)) !== change.baseHash) fail('stale_file', `Base hash changed for ${change.filePath}`);
  }
}

function verificationPassed(value) {
  return value && (value.passed === true || value.pass === true);
}

async function runVerification(verify, stageRoot) {
  if (typeof verify !== 'function') fail('invalid_verify', 'verify must be a callback');
  let result;
  try { result = await verify(stageRoot); } catch (err) { fail('verification_error', err.message || 'Verification callback failed', err); }
  if (!verificationPassed(result)) fail('verification_failed', 'Verification did not pass');
  return result;
}

function compactVerification(value) {
  if (!value || typeof value !== 'object') return value;
  const result = { ...value };
  delete result.tail;
  delete result.logPath;
  delete result.pdfPath;
  return result;
}

async function removeWorktree(root, stageRoot) {
  try { await git(root, ['worktree', 'remove', '--force', stageRoot]); } catch { /* best effort cleanup */ }
  await rm(stageRoot, { recursive: true, force: true });
}

async function applyChangesUnlocked(root, { baseRevision, changes }, verify) {
  const repo = path.resolve(root);
  let stageRoot;
  try {
    if (typeof baseRevision !== 'string' || !/^[0-9a-f]{40}$/i.test(baseRevision)) fail('invalid_revision', 'baseRevision must be a full 40-hex commit SHA');
    if (await status(repo) !== '') fail('dirty_checkout', 'Repository working tree must be clean');
    const currentHead = await head(repo);
    const requestedHead = await gitText(repo, ['rev-parse', `${baseRevision}^{commit}`]);
    if (requestedHead !== currentHead) fail('stale_revision', 'baseRevision does not match HEAD');
    const checked = await validateChanges(repo, changes);
    stageRoot = await mkdtemp(path.join(tmpdir(), 'overleaf-transaction-'));
    await git(repo, ['worktree', 'add', '--detach', stageRoot, currentHead]);
    for (const change of checked) {
      const target = await ensureNoSymlink(stageRoot, change.filePath);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, change.bytes);
    }
    const verification = await runVerification(verify, stageRoot);
    for (const change of checked) {
      const bytes = await readFile(await ensureNoSymlink(stageRoot, change.filePath));
      if (!bytes.equals(change.bytes)) fail('verification_mutation', `Verification changed ${change.filePath}`);
    }
    const changed = await gitText(stageRoot, ['diff', '--name-only']);
    const allowed = new Set(checked.map(c => c.filePath));
    if (changed && changed.split('\n').some(file => !allowed.has(file))) fail('unexpected_change', 'Verification changed files outside the batch');
    let revision = currentHead;
    if (checked.length) {
      await git(stageRoot, ['add', '--', ...checked.map(c => c.filePath)]);
      const staged = await gitText(stageRoot, ['diff', '--cached', '--name-only']);
      if (staged && staged.split('\n').some(file => !allowed.has(file))) fail('unexpected_change', 'Unexpected file staged');
      if (staged) {
        await git(stageRoot, ['-c', 'user.name=Overleaf Forge', '-c', 'user.email=overleaf-forge@localhost', 'commit', '-m', 'Apply verified transaction']);
        revision = await head(stageRoot);
      }
    }
    await assertCleanAt(repo, currentHead, checked);
    await git(repo, ['merge', '--ff-only', revision]);
    return { revision: await head(repo), verification: compactVerification(verification), files: checked.map(c => c.filePath) };
  } catch (err) {
    if (err instanceof TransactionError) throw err;
    throw new TransactionError('git_error', err.message || 'Git transaction failed', err);
  } finally {
    if (stageRoot) await removeWorktree(repo, stageRoot);
  }
}

async function publishChangesUnlocked(root, { revision }, verify, push) {
  const repo = path.resolve(root);
  try {
    if (typeof revision !== 'string' || !/^[0-9a-f]{40}$/i.test(revision)) fail('invalid_revision', 'revision must be a full 40-hex commit SHA');
    if (await status(repo) !== '') fail('dirty_checkout', 'Repository working tree must be clean');
    if (await head(repo) !== await gitText(repo, ['rev-parse', `${revision}^{commit}`])) fail('stale_revision', 'revision does not match HEAD');
    const verification = await runVerification(verify, repo);
    if (await status(repo) !== '') fail('verification_mutation', 'Verification changed the repository');
    if (await head(repo) !== revision) fail('stale_revision', 'Repository HEAD changed during verification');
    const branch = await gitText(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (!branch) fail('detached_head', 'Cannot publish from a detached HEAD');
    if (push !== undefined && typeof push !== 'function') fail('invalid_push', 'push must be a callback');
    if (push) await push(repo, revision, branch);
    else await git(repo, ['push', 'HEAD:refs/heads/' + branch]);
    const files = await gitText(repo, ['diff-tree', '--no-commit-id', '--name-only', '-r', revision]);
    return { revision: await head(repo), verification: compactVerification(verification), files: files ? files.split('\n') : [] };
  } catch (err) {
    if (err instanceof TransactionError) throw err;
    throw new TransactionError('push_failed', err.message || 'Git push failed', err);
  }
}

const locks = new Map();
function enqueue(root, operation) {
  const key = path.resolve(root);
  const prior = locks.get(key) || Promise.resolve();
  const current = prior.catch(() => {}).then(operation);
  locks.set(key, current);
  return current.finally(() => { if (locks.get(key) === current) locks.delete(key); });
}

export function applyChanges(root, input, verify) {
  return enqueue(root, () => applyChangesUnlocked(root, input, verify));
}

export function publishChanges(root, input, verify, push) {
  return enqueue(root, () => publishChangesUnlocked(root, input, verify, push));
}

export { TransactionError };
