import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OverleafGitClient } from '../overleaf-mcp-server.js';
import { makeRemote, clientClonePath } from './helpers.mjs';

function client(r) { return new OverleafGitClient('test', 'tok', clientClonePath(r.root), r.remote); }

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
  const s = await stub({ code: 0 });
  const res = await client(r).voiceLint('main.tex', { command: s.command });
  assert.equal(res.clean, true);
});

test('voiceLint findings (exit 2 -> stderr)', async () => {
  const r = await makeRemote({ 'main.tex': 'hi\n' });
  after(() => r.cleanup());
  const s = await stub({ code: 2, msg: 'VOICE: meta-commentary on line 3' });
  const res = await client(r).voiceLint('main.tex', { command: s.command });
  assert.equal(res.clean, false);
  assert.match(res.findings, /meta-commentary/);
});

test('voiceLint passes the linted file path to the linter', async () => {
  const r = await makeRemote({ 'main.tex': 'hi\n' });
  after(() => r.cleanup());
  const s = await stub({ code: 0 });
  await client(r).voiceLint('main.tex', { command: s.command });
  const seen = await readFile(s.argvFile, 'utf-8');
  assert.match(seen, /main\.tex$/);
});

test('voiceLint without a command throws not-configured', async () => {
  const r = await makeRemote({ 'main.tex': 'hi\n' });
  after(() => r.cleanup());
  await assert.rejects(() => client(r).voiceLint('main.tex', {}), /no voice linter configured/i);
});
