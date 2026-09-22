import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, readdir } from 'node:fs/promises';
import path from 'node:path';

const parseCache = new Map();
const snapshots = new Map();
const MAX_FILES = 1000;
const MAX_RESPONSE = 5000;
const MAX_SNAPSHOTS = 8;

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const lineAt = (text, offset) => text.slice(0, offset).split('\n').length;
const rel = (root, file) => path.relative(root, file).split(path.sep).join('/');

function inside(root, candidate) {
  const r = path.resolve(root);
  const c = path.resolve(candidate);
  return c === r || c.startsWith(`${r}${path.sep}`);
}

function withoutComments(source) {
  return source.replace(/(^|[^\\])%[^\n]*/g, '$1');
}

function sectionFor(sections, offset) {
  let result = null;
  for (const section of sections) {
    if (section.offset <= offset) result = section;
    else break;
  }
  return result;
}

function parseFile(file, source, hash) {
  const text = withoutComments(source);
  const sections = [];
  const sectionRe = /\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\{((?:[^{}]|\{[^{}]*\})*)\}/g;
  let match;
  while ((match = sectionRe.exec(text))) sections.push({
    id: `${file}#${match[2]}`,
    title: match[2], type: match[1], line: lineAt(text, match.index), offset: match.index,
  });
  for (let i = 0; i < sections.length; i++) {
    const nextOffset = i + 1 < sections.length ? sections[i + 1].offset : source.length;
    sections[i].endLine = i + 1 < sections.length ? sections[i + 1].line - 1 : source.split('\n').length;
    // Hash the section's own source span. This keeps an unchanged subsection
    // stable when text in a sibling section shifts its line number.
    sections[i].hash = digest(source.slice(sections[i].offset, nextOffset));
    if (i > 0 && sections[i - 1].id === sections[i].id) sections[i].id += `:${i + 1}`;
  }
  const declarations = [];
  const labels = [];
  const refs = [];
  const citations = [];
  const includes = [];
  const graphics = [];
  const values = [];
  if (/\.bib$/i.test(file)) {
    const bibRe = /@\w+\s*\{\s*([^,\s]+)\s*,/g;
    while ((match = bibRe.exec(text))) citations.push({ kind: 'bib', symbol: match[1], line: lineAt(text, match.index), section: null });
  }
  const declarationRe = /\\(?:newcommand|renewcommand|providecommand)\s*\{\\([^}]+)\}(?:\s*\[[^\]]*\])?\s*\{([^{}]*)\}/g;
  while ((match = declarationRe.exec(text))) {
    const symbol = `\\${match[1]}`;
    const declaration = { symbol, value: match[2], line: lineAt(text, match.index), section: sectionFor(sections, match.index)?.id ?? null };
    declarations.push(declaration); values.push(declaration);
  }
  const labelRe = /\\label\s*\{([^}]+)\}/g;
  while ((match = labelRe.exec(text))) labels.push({ symbol: match[1], line: lineAt(text, match.index), section: sectionFor(sections, match.index)?.id ?? null });
  const refRe = /\\(ref|pageref|autoref|cref|Cref)\s*\{([^}]+)\}/g;
  while ((match = refRe.exec(text))) refs.push({ kind: match[1], symbol: match[2], line: lineAt(text, match.index), section: sectionFor(sections, match.index)?.id ?? null, dynamic: /\\|\$|#/.test(match[2]) });
  const citeRe = /\\cite[a-zA-Z*]*\s*(?:\[[^\]]*\]\s*)?\{([^}]+)\}/g;
  while ((match = citeRe.exec(text))) for (const symbol of match[1].split(',').map(x => x.trim()).filter(Boolean)) citations.push({ kind: 'cite', symbol, line: lineAt(text, match.index), section: sectionFor(sections, match.index)?.id ?? null });
  const includeRe = /\\(input|include|includegraphics)\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g;
  while ((match = includeRe.exec(text))) {
    const item = { kind: match[1], target: match[2].trim(), line: lineAt(text, match.index), section: sectionFor(sections, match.index)?.id ?? null, dynamic: /\\|\$|#/.test(match[2]) };
    (match[1] === 'includegraphics' ? graphics : includes).push(item);
  }
  return { file, hash, sections, declarations, labels, refs, citations, includes, graphics, values };
}

async function filesUnder(root, notices) {
  const result = [];
  async function walk(dir) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch (error) { notices.push(`cannot read ${rel(root, dir)}: ${error.message}`); return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) { notices.push(`skipped symlink ${rel(root, full)}`); continue; }
      if (entry.isDirectory()) { await walk(full); continue; }
      if (entry.isFile() && /\.(?:tex|sty|cls|bib|bbx|cbx|ltx)$/i.test(entry.name)) result.push(full);
    }
  }
  await walk(root);
  return result.sort();
}

function resolveTarget(target, from, root, files) {
  if (!target || /[\\$#]/.test(target)) return null;
  const base = path.resolve(root, path.dirname(from), target);
  const candidates = [base, ...(!path.extname(base) ? ['.tex', '.sty', '.cls', '.bib'].map(ext => `${base}${ext}`) : [])];
  return candidates.find(candidate => files.has(rel(root, candidate))) ? rel(root, candidates.find(candidate => files.has(rel(root, candidate)))) : null;
}

function cap(list, limit, field, truncated) {
  if (list.length <= limit) return list;
  truncated[field] = true;
  return list.slice(0, limit);
}

export async function dependencyIndex(root, { changedFiles = [], changedSymbols = [] } = {}) {
  const rootReal = await realpath(root);
  const notices = [];
  const paths = await filesUnder(rootReal, notices);
  const truncated = {};
  const files = new Map();
  const pathSet = new Set(paths.map(file => rel(rootReal, file)));
  for (const file of paths.slice(0, MAX_FILES)) {
    const relative = rel(rootReal, file);
    const bytes = await readFile(file);
    const hash = digest(bytes);
    const key = `${rootReal}:${relative}`;
    const old = parseCache.get(key);
    const parsed = old?.hash === hash ? old : parseFile(relative, bytes.toString('utf8'), hash);
    parseCache.set(key, parsed);
    files.set(relative, parsed);
  }
  if (paths.length > MAX_FILES) truncated.files = true;
  const labels = new Map();
  const citations = new Map();
  for (const file of files.values()) {
    for (const label of file.labels) labels.set(label.symbol, { file: file.file, section: label.section, line: label.line });
    for (const citation of file.citations) citations.set(citation.symbol, { file: file.file, section: citation.section, line: citation.line });
  }
  const edges = [];
  const unresolved = [];
  for (const file of files.values()) {
    const add = (kind, item, target, symbol = null) => edges.push({ kind, from: { file: file.file, section: item.section, line: item.line }, to: target ? { file: target.file, section: target.section ?? null, line: target.line ?? null, symbol } : { symbol: target ?? symbol, unresolved: true } });
    for (const item of file.refs) { const target = labels.get(item.symbol); add(item.kind, item, target, item.symbol); if (!target) unresolved.push({ kind: item.kind, file: file.file, section: item.section, line: item.line, symbol: item.symbol, dynamic: item.dynamic }); }
    for (const item of file.citations) { const target = citations.get(item.symbol); add('cite', item, target, item.symbol); if (!target) unresolved.push({ kind: 'cite', file: file.file, section: item.section, line: item.line, symbol: item.symbol }); }
    for (const item of [...file.includes, ...file.graphics]) { const targetFile = resolveTarget(item.target, file.file, rootReal, pathSet); add(item.kind, item, targetFile ? { file: targetFile } : item.target); if (!targetFile) unresolved.push({ kind: item.kind, file: file.file, section: item.section, line: item.line, symbol: item.target, dynamic: item.dynamic }); }
  }
  const changed = new Set();
  for (const file of changedFiles) {
    const candidate = path.resolve(rootReal, file);
    if (!inside(rootReal, candidate)) throw new Error(`changed file must be inside root: ${file}`);
    changed.add(rel(rootReal, candidate));
  }
  const affected = edges.filter(edge => changed.has(edge.to.file) || (edge.to.symbol && changedSymbols.includes(edge.to.symbol))).map(edge => edge.from);
  const version = digest(JSON.stringify([...files].map(([file, value]) => [file, value.hash])));
  return { version, files: cap([...files.values()].map(({ file, hash, sections, declarations }) => ({ file, hash, sections, symbols: declarations.map(item => item.symbol), definitions: declarations.slice(0, 200) })), MAX_FILES, 'files', truncated), edges: cap(edges, MAX_RESPONSE, 'edges', truncated), unresolved: cap(unresolved, MAX_RESPONSE, 'unresolved', truncated), affectedSections: cap([...new Map(affected.map(x => [x.file + '#' + x.section + ':' + x.line, x])).values()], MAX_RESPONSE, 'affectedSections', truncated), notices, truncated, truncatedFields: Object.keys(truncated) };
}

export async function changeReport(root, baselineVersion) {
  const index = await dependencyIndex(root);
  const key = await realpath(root);
  const previous = baselineVersion ? snapshots.get(key)?.get(baselineVersion) : null;
  const firstCall = !baselineVersion;
  const baselineFound = firstCall || Boolean(previous);
  const oldFiles = previous?.files ?? [];
  const oldMap = new Map(oldFiles.map(file => [file.file, file]));
  const currentMap = new Map(index.files.map(file => [file.file, file]));
  const allFileNames = new Set([...oldMap.keys(), ...currentMap.keys()]);
  const changedFiles = [...allFileNames].filter(file => oldMap.get(file)?.hash !== currentMap.get(file)?.hash).sort();
  const removedFiles = [...oldMap.keys()].filter(file => !currentMap.has(file)).sort();
  const changedFileSet = new Set(changedFiles);
  const oldEdges = previous?.edges ?? [];
  const affectedEdges = firstCall ? [] : [...index.edges, ...oldEdges].filter(edge => changedFileSet.has(edge.to.file));
  const affectedSections = [...new Map(affectedEdges.map(edge => [edge.from.file + '#' + edge.from.section + ':' + edge.from.line, edge.from])).values()];
  const notices = [...index.notices];
  if (baselineVersion && !previous) notices.push(`baseline version not found: ${baselineVersion}; full refresh required`);
  const changedFileHashes = Object.fromEntries(index.files.filter(file => changedFiles.includes(file.file)).map(file => [file.file, file.hash]));
  const changedSections = [];
  if (!firstCall && previous) {
    for (const file of allFileNames) {
      const before = new Map((oldMap.get(file)?.sections ?? []).map(section => [section.id, section]));
      const after = new Map((currentMap.get(file)?.sections ?? []).map(section => [section.id, section]));
      for (const id of new Set([...before.keys(), ...after.keys()])) {
        if (before.get(id)?.hash !== after.get(id)?.hash) changedSections.push({ file, section: id, beforeHash: before.get(id)?.hash ?? null, hash: after.get(id)?.hash ?? null, removed: !after.has(id) });
      }
    }
  }
  const report = { version: index.version, baselineVersion: baselineVersion ?? null, baselineFound, fullRefreshRequired: Boolean(baselineVersion && !previous), firstCall, changedFiles: firstCall || !previous ? [] : changedFiles, removedFiles: firstCall || !previous ? [] : removedFiles, changedFileHashes, changedSections: cap(changedSections, MAX_RESPONSE, 'changedSections', index.truncated), affectedSections: cap(affectedSections, MAX_RESPONSE, 'affectedSections', index.truncated), affectedRefs: cap(affectedEdges, MAX_RESPONSE, 'affectedRefs', index.truncated), suggestions: firstCall || !previous ? [] : affectedSections.map(section => ({ file: section.file, section: section.section, action: 'review references and recompile' })), unresolved: index.unresolved, notices, truncated: index.truncated, truncatedFields: Object.keys(index.truncated) };
  if (!snapshots.has(key)) snapshots.set(key, new Map());
  snapshots.get(key).set(index.version, index);
  const retained = snapshots.get(key);
  while (retained.size > MAX_SNAPSHOTS) retained.delete(retained.keys().next().value);
  return report;
}
