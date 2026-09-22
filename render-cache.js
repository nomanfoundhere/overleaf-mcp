import { createHash } from 'node:crypto';
import { execFile as childExecFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(childExecFile);
const DEFAULT_CACHE_DIR = path.join(os.tmpdir(), 'overleaf-mcp-render');
const MAX_PAGES = 20;
const MIN_DPI = 72;
const MAX_DPI = 200;
const snapshotRetries = 3;

// One promise per key keeps concurrent callers from both invoking pdftoppm and
// replacing the same destination. The rename below still makes each write
// safe if another process is using the same cache directory.
const pending = new Map();

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (parent, child) => child === parent || child.startsWith(`${parent}${path.sep}`);

async function containedSource(root, filePath) {
  const rootReal = await pathReal(root);
  const candidate = path.resolve(root, filePath);
  if (!inside(path.resolve(root), candidate)) throw new Error('PDF path must be inside project');
  const sourceReal = await pathReal(candidate);
  if (!inside(rootReal, sourceReal)) throw new Error('PDF symlink escapes project');
  return sourceReal;
}

async function pathReal(file) {
  try {
    return await realpath(file);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`Path does not exist: ${file}`);
    throw error;
  }
}

async function cacheRoot(cacheDir) {
  const requested = path.resolve(cacheDir ?? DEFAULT_CACHE_DIR);
  await mkdir(requested, { recursive: true });
  const entry = await lstat(requested);
  if (entry.isSymbolicLink()) throw new Error('Cache directory must not be a symlink');
  return await pathReal(requested);
}

function validatePages(pages) {
  if (!Array.isArray(pages) || pages.length === 0 || pages.length > MAX_PAGES) {
    throw new Error(`pages must contain 1-${MAX_PAGES} page numbers`);
  }
  if (!pages.every(page => Number.isInteger(page) && page > 0)) {
    throw new Error('pages must contain positive integers');
  }
  return [...new Set(pages)];
}

function validateDpi(dpi) {
  if (!Number.isInteger(dpi) || dpi < MIN_DPI || dpi > MAX_DPI) {
    throw new Error(`dpi must be an integer from ${MIN_DPI} to ${MAX_DPI}`);
  }
  return dpi;
}

async function toolVersion() {
  try {
    const result = await execFile('pdftoppm', ['-v'], { encoding: 'utf8' });
    return `${result.stdout}\n${result.stderr}`.trim();
  } catch (error) {
    // pdftoppm writes its version to stderr and exits successfully on common
    // builds, but retain a stable failure if the executable cannot be run.
    if (error.stdout || error.stderr) return `${error.stdout ?? ''}\n${error.stderr ?? ''}`.trim();
    throw new Error(`Unable to run pdftoppm: ${error.message}`);
  }
}

async function pageCount(pdf) {
  let result;
  try {
    result = await execFile('pdfinfo', [pdf], { encoding: 'utf8' });
  } catch (error) {
    throw new Error(`Unable to inspect PDF: ${error.stderr?.trim() || error.message}`);
  }
  const match = result.stdout.match(/^Pages:\s+(\d+)\s*$/m);
  const count = match ? Number(match[1]) : NaN;
  if (!Number.isInteger(count) || count < 1) throw new Error('pdfinfo returned no valid page count');
  return count;
}

async function snapshot(source, root) {
  for (let attempt = 0; attempt < snapshotRetries; attempt += 1) {
    const before = await stat(source);
    const bytes = await readFile(source);
    const after = await stat(source);
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs) continue;
    const hash = digest(bytes);
    const dir = await mkdtemp(path.join(root, '.snapshot-'));
    const file = path.join(dir, 'input.pdf');
    await writeFile(file, bytes, { flag: 'wx' });
    if (digest(await readFile(file)) !== hash) {
      await rm(dir, { recursive: true, force: true });
      throw new Error('PDF snapshot verification failed');
    }
    return { dir, file, hash };
  }
  throw new Error('PDF changed while it was being read; retry the render');
}

async function existingFile(file, root) {
  if (!inside(root, path.resolve(file))) throw new Error('Cache path escapes cache directory');
  try {
    const info = await lstat(file);
    return info.isFile() && !info.isSymbolicLink() && info.size > 0;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function renderOne(snapshotFile, root, key, page, dpi) {
  const finalFile = path.join(root, `${key}.png`);
  if (await existingFile(finalFile, root)) return { file: finalFile, hit: true };
  const work = await mkdtemp(path.join(root, '.render-'));
  try {
    const prefix = path.join(work, 'page');
    await execFile('pdftoppm', ['-png', '-r', String(dpi), '-f', String(page), '-l', String(page), snapshotFile, prefix], { encoding: 'utf8' });
    const generated = path.join(work, `page-${page}.png`);
    if (!(await existingFile(generated, work))) throw new Error(`pdftoppm produced no output for page ${page}`);
    await rename(generated, finalFile);
    return { file: finalFile, hit: false };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export async function renderPages(root, { filePath, pages, dpi = 110, cacheDir } = {}) {
  if (typeof root !== 'string' || typeof filePath !== 'string') throw new Error('root and filePath are required');
  const wanted = validatePages(pages);
  const resolution = validateDpi(dpi);
  const cache = await cacheRoot(cacheDir);
  const source = await containedSource(root, filePath);
  const input = await snapshot(source, cache);
  try {
    const [version, count] = await Promise.all([toolVersion(), pageCount(input.file)]);
    if (wanted.some(page => page > count)) throw new Error(`Requested page exceeds PDF page count (${count})`);
    const results = [];
    for (const page of wanted) {
      const key = digest(JSON.stringify([input.hash, page, resolution, version]));
      let work = pending.get(key);
      if (!work) {
        work = renderOne(input.file, cache, key, page, resolution).finally(() => pending.delete(key));
        pending.set(key, work);
      }
      results.push(await work);
    }
    return { files: results.map(result => result.file), cacheHits: results.filter(result => result.hit).length, requestedPages: wanted, pageCount: count };
  } finally {
    await rm(input.dir, { recursive: true, force: true });
  }
}
