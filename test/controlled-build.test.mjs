import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildFingerprint, controlledBuildOptions } from '../efficiency.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'controlled-build-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'main.tex'), '\\documentclass{article}\\begin{document}x\\end{document}\n');
  return root;
}

test('controlled options are explicit and normalize external paths', () => {
  assert.deepEqual(controlledBuildOptions({ controlled: true, externalInputs: ['/tmp/a', '/tmp/a'] }), { controlled: true, sourcesOnly: false, externalInputs: ['/tmp/a'] });
  assert.throws(() => controlledBuildOptions({ externalInputs: ['relative.tex'] }), /absolute/);
});

test('mode is part of the fingerprint key', async t => {
  const root = await fixture(t);
  const normal = await buildFingerprint(root, 'main.tex', 'pdflatex', { sourcesOnly: true });
  const controlled = await buildFingerprint(root, 'main.tex', 'pdflatex', { sourcesOnly: true, controlled: true });
  assert.notEqual(normal, controlled);
});

test('explicit external inputs invalidate the fingerprint when content changes', async t => {
  const root = await fixture(t);
  const external = path.join(path.dirname(root), 'controlled-external.tex');
  t.after(() => rm(external, { force: true }));
  await writeFile(external, 'one');
  const first = await buildFingerprint(root, 'main.tex', 'pdflatex', { sourcesOnly: true, controlled: true, externalInputs: [external] });
  await writeFile(external, 'two');
  const second = await buildFingerprint(root, 'main.tex', 'pdflatex', { sourcesOnly: true, controlled: true, externalInputs: [external] });
  assert.notEqual(first, second);
});

test('controlled mode permits latexmkrc but keeps executable TeX ineligible', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, '.latexmkrc'), '# controlled flags are supplied by the caller\n');
  await writeFile(path.join(root, 'main.fls'), `INPUT ${path.join(root, 'main.tex')}\n`);
  assert.equal(await buildFingerprint(root, 'main.tex', 'pdflatex'), null);
  const controlled = await buildFingerprint(root, 'main.tex', 'pdflatex', { controlled: true });
  assert.equal(typeof controlled, 'string');
  await writeFile(path.join(root, 'main.tex'), '\\directlua{tex.print("x")}\n');
  assert.equal(await buildFingerprint(root, 'main.tex', 'pdflatex', { controlled: true }), null);
});
