import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { versionedContext, sectionBundle } from '../efficiency.js';
import { OverleafGitClient } from '../overleaf-mcp-server.js';

const doc='\\documentclass{article}\\begin{document}Hello\\end{document}\n';
async function fixture(t) {
 const root=await mkdtemp(path.join(os.tmpdir(),'overleaf-efficient-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(path.join(root,'.git')); await writeFile(path.join(root,'main.tex'),doc);
 const c=new OverleafGitClient('x','unused',root);
 c.cloneOrPull=async()=>{throw Error('Unexpected implicit synchronization');};
 return {root,c};
}
test('context detects content and project changes; unchanged omits body',()=>{
 const a=versionedContext('a','hello');
 assert.equal(versionedContext('a','hello',a.version).text,'Context unchanged.');
 assert.equal(versionedContext('a','changed',a.version).unchanged,false);
 assert.equal(versionedContext('b','hello',a.version).unchanged,false);
});
test('section bundle includes sibling-file equation, nested bibliography and reports missing labels',async t=>{
 const {root}=await fixture(t);
 await writeFile(path.join(root,'main.tex'),'\\section{A}\nSee \\autoref{eq:x} and \\autoref{missing}. \\cite{key}\n\\subsection{Child}Kept\n\\section{B}Excluded');
 await writeFile(path.join(root,'eq.tex'),'\\begin{equation}x=1\\label{eq:x}\\end{equation}');
 await writeFile(path.join(root,'refs.bib'),'@article{key,title={A {nested} title},year={2026}}\n@book{other,title={No}}');
 const b=await sectionBundle(root,'main.tex','A');
 assert.match(b.body,/Kept/); assert.doesNotMatch(b.body,/Excluded/);
 assert.equal(b.blocks.length,1);assert.match(b.bibliography[0].text,/nested/);assert.deepEqual(b.unresolvedLabels,['missing']);
 await assert.rejects(sectionBundle(root,'../other','A'),/inside/);
 await writeFile(path.join(root,'main.tex'),'\\section{A}'+ 'x'.repeat(9000));
 assert.equal((await sectionBundle(root,'main.tex','A',2000)).truncated,true);
});
test('local verification reuses unchanged output, invalidates edits and deleted PDF, force rebuilds',async t=>{
 const {root,c}=await fixture(t);let calls=0; const original=c._runLatexmk.bind(c);
 c._runLatexmk=async(...args)=>{calls++;return original(...args);};
 assert.equal((await c.verifyBuild('main.tex','pdflatex')).pass,true);
 assert.equal((await c.verifyBuild('main.tex','pdflatex')).reused,true);
 assert.equal(calls,1);
 await writeFile(path.join(root,'refs.bib'),'@book{x,title={new}}');
 assert.equal((await c.verifyBuild('main.tex','pdflatex')).reused,false);
 await rm(path.join(root,'main.pdf'));
 assert.equal((await c.verifyBuild('main.tex','pdflatex')).reused,false);
 await c.verifyBuild('main.tex','pdflatex',{force:true});assert.equal(calls,4);
});
test('failed command cannot pass using stale PDF and clean log',async t=>{
 const {root,c}=await fixture(t);
 await writeFile(path.join(root,'main.pdf'),'old PDF');
 await writeFile(path.join(root,'main.log'),'Output written on main.pdf (1 page, 1 bytes).');
 c._runLatexmk=async()=>({log:'failed',pdfPath:path.join(root,'main.pdf'),commandFailed:true});
 assert.equal((await c.verifyBuild('main.tex')).pass,false);
});
test('executable build configuration disables reuse',async t=>{
 const {root,c}=await fixture(t);await writeFile(path.join(root,'.latexmkrc'),'# project configuration\n');
 const v=await c.verifyBuild('main.tex','pdflatex');assert.equal(v.pass,true);assert.equal(v.cacheEligible,false);
});
test('missing clone asks for explicit sync rather than fetching',async t=>{
 const {root,c}=await fixture(t);await rm(path.join(root,'.git'),{recursive:true});
 await assert.rejects(c.compileFile('main.tex'),/sync_project/);
});
test('external recorder dependency edits invalidate reuse',async t=>{
 const {root,c}=await fixture(t);const external=await mkdtemp(path.join(os.tmpdir(),'overleaf-external-'));t.after(()=>rm(external,{recursive:true,force:true}));
 const input=path.join(external,'text.tex');await writeFile(input,'Version one');
 await writeFile(path.join(root,'main.tex'),`\\documentclass{article}\\begin{document}\\input{${input}}\\end{document}`);
 assert.equal((await c.verifyBuild('main.tex','pdflatex')).pass,true);
 assert.equal((await c.verifyBuild('main.tex','pdflatex')).reused,true);
 await writeFile(input,'Version two');assert.equal((await c.verifyBuild('main.tex','pdflatex')).reused,false);
});
test('explicit sync does not reset when the fetch fails',async t=>{
 const {c}=await fixture(t);const calls=[];c._git=async args=>{calls.push(args);if(args.includes('fetch'))throw Error('network down');return {stdout:''};};
 await assert.rejects(c.syncProject(),/network down/);assert.ok(calls.some(a=>a.includes('fetch')));assert.ok(calls.every(a=>!a.includes('reset')));
});
