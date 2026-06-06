import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { OverleafGitClient } from '../overleaf-mcp-server.js';
import { makeRemote, clientClonePath } from './helpers.mjs';

const ef = promisify(execFile);
function client(r) { return new OverleafGitClient('test', 'tok', clientClonePath(r.root), r.remote); }
// voiceLint reads the local working copy and never pulls, so the clone must
// already exist; this mirrors a project the user has opened before.
async function clonedClient(r) { const c = client(r); await c.cloneOrPull(); return c; }

// Write a stub "linter": records its file arg, optionally prints to stderr, exits with `code`.
async function stub({ code = 0, msg = '' }) {
  const dir = await mkdtemp(path.join(tmpdir(), 'omcp-vl-'));
  const script = path.join(dir, 'stub.mjs');
  const argvFile = path.join(dir, 'argv.txt');
  await writeFile(script, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(argvFile)}, process.argv[2] || '');\nif (${JSON.stringify(msg)}) process.stderr.write(${JSON.stringify(msg)});\nprocess.exit(${code});\n`);
  return { command: `node ${script}`, argvFile };
}

test('voiceLint clean (exit 0)', async () => {
  const r = await makeRemote({ 'main.tex': 'hi\n' });
  after(() => r.cleanup());
  const c = await clonedClient(r);
  const s = await stub({ code: 0 });
  const res = await c.voiceLint('main.tex', { command: s.command });
  assert.equal(res.clean, true);
});

test('voiceLint findings (exit 2 -> stderr)', async () => {
  const r = await makeRemote({ 'main.tex': 'hi\n' });
  after(() => r.cleanup());
  const c = await clonedClient(r);
  const s = await stub({ code: 2, msg: 'VOICE: meta-commentary on line 3' });
  const res = await c.voiceLint('main.tex', { command: s.command });
  assert.equal(res.clean, false);
  assert.match(res.findings, /meta-commentary/);
});

test('voiceLint passes the linted file path to the linter', async () => {
  const r = await makeRemote({ 'main.tex': 'hi\n' });
  after(() => r.cleanup());
  const c = await clonedClient(r);
  const s = await stub({ code: 0 });
  await c.voiceLint('main.tex', { command: s.command });
  const seen = await readFile(s.argvFile, 'utf-8');
  assert.match(seen, /main\.tex$/);
});

test('voiceLint without a command throws not-configured', async () => {
  const r = await makeRemote({ 'main.tex': 'hi\n' });
  after(() => r.cleanup());
  await assert.rejects(() => client(r).voiceLint('main.tex', {}), /no voice linter configured/i);
});

test('voiceLint never pulls: a missing local clone errors instead of fetching', async () => {
  const r = await makeRemote({ 'main.tex': 'hi\n' });
  after(() => r.cleanup());
  const s = await stub({ code: 0 });
  // client() points at an un-cloned local path; with no pull, the file is absent,
  // so the lint must error rather than reach out to the remote.
  await assert.rejects(() => client(r).voiceLint('main.tex', { command: s.command }), /not found|never pulls/i);
});

test('bundled example linter: exit 2 on findings, 0 when clean', async () => {
  const linter = fileURLToPath(new URL('../examples/voice-lint.mjs', import.meta.url));
  const dir = await mkdtemp(path.join(tmpdir(), 'omcp-ex-'));
  const dirty = path.join(dir, 'dirty.tex');
  const clean = path.join(dir, 'clean.tex');
  await writeFile(dirty, 'We added a guard in order to catch the case.\n');
  await writeFile(clean, 'The guard catches the case.\n');
  await assert.rejects(() => ef('node', [linter, dirty]), e => e.code === 2); // findings -> exit 2
  await ef('node', [linter, clean]); // clean -> exit 0 (resolves)
});
