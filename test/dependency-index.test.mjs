import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { dependencyIndex, changeReport } from '../dependency-index.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dependency-index-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('indexes sections, cross-file labels, citations, and inputs', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'main.tex'), '\\section{Intro}\nSee \\ref{eq:x} and \\cite{paper}.\\input{chapter}\n');
  await writeFile(path.join(root, 'chapter.tex'), '\\section{Chapter}\n\\label{eq:x}\n');
  await writeFile(path.join(root, 'refs.bib'), '@article{paper,title={Paper}}\n');
  const index = await dependencyIndex(root);
  assert.ok(index.edges.some(edge => edge.kind === 'ref' && edge.to.file === 'chapter.tex'));
  assert.ok(index.edges.some(edge => edge.kind === 'cite' && edge.to.file === 'refs.bib'));
  assert.ok(index.edges.some(edge => edge.kind === 'input' && edge.to.file === 'chapter.tex'));
  assert.equal(index.unresolved.length, 0);
});

test('content edits invalidate only the changed parse cache and report affected sections', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'main.tex'), '\\section{A}\n\\ref{eq:x}\n');
  await writeFile(path.join(root, 'eq.tex'), '\\section{Equation}\n\\label{eq:x}\n');
  const first = await dependencyIndex(root);
  const second = await dependencyIndex(root);
  assert.equal(first.version, second.version);
  const baseline = await changeReport(root);
  await writeFile(path.join(root, 'eq.tex'), '\\section{Equation}\nchanged\\label{eq:x}\n');
  const report = await changeReport(root, baseline.version);
  assert.deepEqual(report.changedFiles, ['eq.tex']);
  assert.equal(report.affectedSections.length, 1);
  assert.equal(report.affectedSections[0].file, 'main.tex');
});

test('first report establishes a baseline, later versions report hashes and unresolved macros', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'main.tex'), '\\newcommand{\\myref}{eq:x}\n\\section{A}\\ref{\\myref}\\ref{missing}\n');
  const first = await changeReport(root);
  assert.equal(first.firstCall, true);
  assert.deepEqual(first.changedFiles, []);
  assert.ok(first.unresolved.some(item => item.symbol === '\\myref' || item.symbol === 'missing'));
  await writeFile(path.join(root, 'main.tex'), '\\newcommand{\\myref}{eq:x}\n\\section{A}changed\\ref{missing}\n');
  const second = await changeReport(root, first.version);
  assert.equal(second.firstCall, false);
  assert.deepEqual(second.changedFiles, ['main.tex']);
  assert.ok(second.changedSections[0].hash);
});

test('rejects changed paths outside root and skips symlinks with a notice', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'main.tex'), 'x');
  await symlink(path.join(root, 'main.tex'), path.join(root, 'linked.tex'));
  await assert.rejects(dependencyIndex(root, { changedFiles: ['../outside.tex'] }), /inside root/);
  const index = await dependencyIndex(root);
  assert.ok(index.notices.some(notice => notice.includes('linked.tex')));
});

test('reports one edited section and deleted files without marking a sibling section', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'main.tex'), '\\section{A}\nold\n\\section{B}\nkeep\n');
  await writeFile(path.join(root, 'gone.tex'), '\\section{Gone}\n');
  const baseline = await changeReport(root);
  await writeFile(path.join(root, 'main.tex'), '\\section{A}\nnew\n\\section{B}\nkeep\n');
  await rm(path.join(root, 'gone.tex'));
  const report = await changeReport(root, baseline.version);
  assert.deepEqual(report.removedFiles, ['gone.tex']);
  assert.ok(report.changedSections.some(item => item.file === 'main.tex' && item.section.includes('A')));
  assert.ok(!report.changedSections.some(item => item.file === 'main.tex' && item.section.includes('B')));
  assert.ok(report.changedSections.some(item => item.file === 'gone.tex' && item.removed));
});

test('unknown baseline asks for a full refresh instead of claiming a precise diff', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'main.tex'), '\\newcommand{\\foo}{bar}\n');
  const report = await changeReport(root, 'missing-version');
  assert.equal(report.baselineFound, false);
  assert.equal(report.fullRefreshRequired, true);
  assert.deepEqual(report.changedFiles, []);
  assert.ok(report.notices.some(item => item.includes('full refresh')));
  assert.equal(report.index, undefined);
});
