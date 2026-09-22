import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

const hash = value => createHash('sha256').update(value).digest('hex');
export function versionedContext(key, text, previousVersion) {
  const version = hash(JSON.stringify([key, text]));
  return { version, unchanged: previousVersion === version, text: previousVersion === version ? 'Context unchanged.' : text };
}

// Cache keys include file contents, not mtimes. Hash external recorder inputs too;
// an edited image, bibliography, package or deleted PDF must invalidate reuse.
// Controlled mode is safe to cache only when the caller also controls the
// latexmk invocation. It relaxes the project-config check, while executable
// TeX features remain ineligible because their dependency closure is opaque.
export function controlledBuildOptions(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('build options must be an object');
  const controlled = options.controlled === true;
  const externalInputs = options.externalInputs ?? [];
  if (!Array.isArray(externalInputs) || externalInputs.some(input => typeof input !== 'string' || !path.isAbsolute(input))) {
    throw new TypeError('externalInputs must contain absolute paths');
  }
  return { sourcesOnly: options.sourcesOnly === true, controlled, externalInputs: [...new Set(externalInputs)] };
}

export async function buildFingerprint(root, entry, engine, options = {}) {
  const { sourcesOnly, controlled, externalInputs } = controlledBuildOptions(options);
  const records = [];
  const job = path.resolve(root, entry.replace(/\.tex$/, ''));
  const generated = new Set(['aux','log','pdf','fls','fdb_latexmk','synctex.gz','toc','out','bbl','bcf','blg','run.xml','lof','lot'].map(e => `${job}.${e}`));
  let unsafe = false;
  const visit = async dir => {
    for (const d of (await readdir(dir, { withFileTypes: true })).sort((a,b)=>a.name.localeCompare(b.name))) {
      if (d.name === '.git') continue;
      const f = path.join(dir,d.name);
      if (d.isSymbolicLink()) { unsafe = true; continue; }
      if (d.isDirectory()) await visit(f);
      else if (d.isFile() && !(sourcesOnly && generated.has(f))) {
        const bytes = await readFile(f);
        records.push([f,hash(bytes)]);
        // Executable config and shell/Lua-driven generation can read dependencies
        // outside the TeX recorder. Rebuild rather than certify an incomplete key.
        if ((!controlled && /latexmkrc$/.test(f)) || (/\.(tex|sty|cls)$/.test(f) && /\\(?:write18|directlua|inputminted)|\\begin\{minted\}/.test(bytes.toString()))) unsafe = true;
      }
    }
  };
  await visit(root);
  for (const input of externalInputs) {
    const stat = await lstat(input).catch(() => null);
    if (!stat || !stat.isFile() || stat.isSymbolicLink()) throw new Error(`external input must be a regular non-symlink file: ${input}`);
    records.push([input, hash(await readFile(input))]);
  }
  if (unsafe && !sourcesOnly) return null;
  if (!sourcesOnly) {
    const fls = await readFile(`${job}.fls`,'utf8');
    const inputs = new Set(fls.split(/\r?\n/).filter(l=>l.startsWith('INPUT ')).map(l=>path.resolve(root,l.slice(6))));
    if (!inputs.size) return null;
    for (const f of [...inputs].sort()) records.push([await realpath(f),hash(await readFile(f))]);
    for (const tool of ['latexmk',engine]) {
      const f = await realpath(`/Library/TeX/texbin/${tool}`);
      records.push([f,hash(await readFile(f))]);
    }
  }
  return hash(JSON.stringify([engine,entry,process.env,new Date().toDateString(),{ controlled, externalInputs },records]));
}

export function sectionText(content, title) {
  const re = /\\(section|subsection|subsubsection|paragraph)\*?\{((?:[^{}]|\{[^{}]*\})*)\}/g;
  const headings = [...content.matchAll(re)];
  const matches = headings.filter(m=>m[2]===title);
  if (matches.length !== 1) throw new Error(`Expected one section titled "${title}"; found ${matches.length}.`);
  const ranks = {section:1,subsection:2,subsubsection:3,paragraph:4};
  const t = matches[0];
  const next = headings.find(m=>m.index>t.index && ranks[m[1]]<=ranks[t[1]]);
  return content.slice(t.index,next?.index ?? content.length);
}

// Brace scanning preserves nested BibTeX values and equation/figure bodies.
function entries(text) {
  const out=[]; const re=/@\w+\s*\{\s*([^,\s]+)\s*,/g; let m;
  while ((m=re.exec(text))) {
    let depth=1,i=re.lastIndex;
    for (;i<text.length && depth;i++) { if (text[i-1]==='\\') continue; if(text[i]==='{')depth++; if(text[i]==='}')depth--; }
    out.push({key:m[1],text:text.slice(m.index,i)}); re.lastIndex=i;
  }
  return out;
}
export async function sectionBundle(root, filePath, title, maxChars = 16000) {
  const full=path.resolve(root,filePath);
  if (!full.startsWith(path.resolve(root)+path.sep)) throw new Error('Section path must be inside project');
  if (!(await realpath(full)).startsWith(await realpath(root) + path.sep)) throw new Error('Section symlink escapes project');
  const source=await readFile(full,'utf8'); const body=sectionText(source,title);
  const wanted=new Set([...body.matchAll(/\\(?:auto|eq|page)?ref\{([^}]+)\}/g)].map(m=>m[1]));
  const citations=new Set([...body.matchAll(/\\(?:cite\w*|autocite|parencite|textcite)\*?(?:\[[^\]]*\])*\{([^}]+)\}/g)].flatMap(m=>m[1].split(',').map(k=>k.trim())));
  const blocks=[];const bibliography=[];
  const walk=async dir=>{
    for(const d of await readdir(dir,{withFileTypes:true})) {
      if(d.name==='.git'||d.isSymbolicLink())continue;
      const f=path.join(dir,d.name); if(d.isDirectory()){await walk(f);continue;}
      if(!/\.(tex|bib)$/.test(f))continue;
      const t=await readFile(f,'utf8');
      if(f.endsWith('.bib')) { for(const e of entries(t))if(citations.has(e.key))bibliography.push({file:path.relative(root,f),...e}); continue; }
      for(const m of t.matchAll(/\\begin\{(figure\*?|equation\*?|align\*?|gather\*?|multline\*?)\}[\s\S]*?\\end\{\1\}/g)) {
        const labels=[...m[0].matchAll(/\\label\{([^}]+)\}/g)].map(x=>x[1]);
        if(labels.some(l=>wanted.has(l))) blocks.push({file:path.relative(root,f),labels,text:m[0]});
      }
    }
  }; await walk(root);
  const resolved=new Set(blocks.flatMap(b=>b.labels));
  const result={file:filePath,section:title,body,blocks,bibliography,unresolvedLabels:[...wanted].filter(l=>!resolved.has(l)),unresolvedCitations:[...citations].filter(k=>!bibliography.some(e=>e.key===k)),assets:[...body.matchAll(/\\(?:includegraphics(?:\[[^\]]*\])?|input)\{([^}]+)\}/g)].map(m=>m[1]),truncated:false};
  // Never silently truncate: preserve the main section first and identify omissions.
  while(JSON.stringify(result).length>maxChars && (result.blocks.length||result.bibliography.length)) {result.truncated=true;if(result.blocks.length)result.blocks.pop();else result.bibliography.pop();}
  if(JSON.stringify(result).length>maxChars){result.truncated=true;result.body=body.slice(0,Math.max(0,maxChars-JSON.stringify({...result,body:''}).length-100));}
  return result;
}
