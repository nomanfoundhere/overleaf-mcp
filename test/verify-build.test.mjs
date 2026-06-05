import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { classifyBuildLog, OverleafGitClient } from '../overleaf-mcp-server.js';
import { makeRemote, clientClonePath } from './helpers.mjs';

const CLEAN = 'This is LuaHBTeX...\nOutput written on main.pdf (23 pages, 855513 bytes).\nLatexmk: All targets up to date\n';

test('clean log -> pass with page count, empty arrays', () => {
  const v = classifyBuildLog(CLEAN);
  assert.equal(v.pass, true);
  assert.equal(v.pageCount, 23);
  assert.equal(v.pdfProduced, true);
  assert.deepEqual(v.undefinedRefs, []);
  assert.deepEqual(v.undefinedCitations, []);
  assert.deepEqual(v.errors, []);
});

test('undefined reference -> fail', () => {
  const v = classifyBuildLog(CLEAN + "LaTeX Warning: Reference `fig:x' on page 2 undefined on input line 40.\n");
  assert.equal(v.undefinedRefs.length, 1);
  assert.equal(v.pass, false);
});

test('undefined citation -> fail', () => {
  const v = classifyBuildLog(CLEAN + "LaTeX Warning: Citation `desai2026' on page 1 undefined on input line 5.\n");
  assert.equal(v.undefinedCitations.length, 1);
  assert.equal(v.pass, false);
});

test('LaTeX error (! line) -> fail', () => {
  const v = classifyBuildLog('! Undefined control sequence.\nl.12 \\foo\n');
  assert.ok(v.errors.length >= 1);
  assert.equal(v.pass, false);
});

test('overfull boxes alone -> pass, counted as warnings', () => {
  const v = classifyBuildLog(CLEAN + 'Overfull \\hbox (12.3pt too wide) in paragraph at lines 1--2\nOverfull \\vbox (3.0pt too high) detected at line 9\n');
  assert.equal(v.overfullCount, 2);
  assert.equal(v.pass, true);
});

test('no "Output written" line -> no pdf, fail', () => {
  const v = classifyBuildLog('This is LuaHBTeX...\n! Emergency stop.\n');
  assert.equal(v.pdfProduced, false);
  assert.equal(v.pass, false);
});

test('page count uses the LAST Output-written line', () => {
  const v = classifyBuildLog('Output written on sub.pdf (2 pages, 100 bytes).\nOutput written on main.pdf (23 pages, 855513 bytes).\n');
  assert.equal(v.pageCount, 23);
});

test('a single failing class fails the whole verdict', () => {
  const v = classifyBuildLog(CLEAN + "LaTeX Warning: Reference `a' undefined on input line 1.\nUnderfull \\hbox (badness 10000) in paragraph at lines 3--4\n");
  assert.equal(v.pass, false);
  assert.equal(v.underfullCount, 1);
});

const LATEXMK = '/Library/TeX/texbin/latexmk';
const TRIVIAL = '\\documentclass{article}\\begin{document}hello verify\\end{document}\n';

test('verifyBuild PASSes a trivial doc (integration; skipped without latexmk)', { skip: !existsSync(LATEXMK) }, async () => {
  const r = await makeRemote({ 'main.tex': TRIVIAL });
  after(() => r.cleanup());
  const c = new OverleafGitClient('test', 'tok', clientClonePath(r.root), r.remote);
  const v = await c.verifyBuild('main.tex', 'pdflatex');
  assert.equal(v.pass, true);
  assert.ok(v.pageCount >= 1);
});

const REFDOC = '\\documentclass{article}\\begin{document}\\section{Intro}\\label{sec:intro}See \\ref{sec:intro} on page \\pageref{sec:intro}.\\end{document}\n';

test('verifyBuild PASSes a doc with a cross-ref (final-pass log, not first-pass artifacts)', { skip: !existsSync(LATEXMK) }, async () => {
  const r = await makeRemote({ 'main.tex': REFDOC });
  after(() => r.cleanup());
  const c = new OverleafGitClient('test', 'tok', clientClonePath(r.root), r.remote);
  const v = await c.verifyBuild('main.tex', 'pdflatex');
  assert.equal(v.pass, true, `expected PASS but undefinedRefs=${v.undefinedRefs.length}`);
  assert.deepEqual(v.undefinedRefs, []);
});
