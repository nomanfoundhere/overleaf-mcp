#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { readFile, writeFile, access, mkdir, readdir, stat, rm, rename } from 'fs/promises';
import { promisify } from 'util';
import { execFile as execFileCallback } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Every subprocess call goes through execFile (no shell): no shell injection and
// no secrets in command strings. Git auth is supplied via an inline credential
// helper that reads the token from the environment (see OverleafGitClient._git).
const execFile = promisify(execFileCallback);

const CONFIG_PATH = path.join(__dirname, 'projects.json');
const CONTEXTS_DIR = path.join(__dirname, 'contexts');
const GUIDELINES_PATH = path.join(__dirname, 'writing-guidelines.md');

// Capture the cwd Claude Code spawned this MCP from. Used for project autodetection.
const SESSION_CWD = process.cwd();

// Re-read on every call so register_project / token rotation / context edits
// take effect immediately without restarting Claude.
async function loadConfig() {
  const raw = await readFile(CONFIG_PATH, 'utf-8');
  return JSON.parse(raw);
}

async function saveConfig(config) {
  // Write-temp-then-rename so a crash mid-write can't corrupt projects.json
  // (it holds the token and every project entry).
  const tmp = `${CONFIG_PATH}.tmp`;
  await writeFile(tmp, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  await rename(tmp, CONFIG_PATH);
}

function resolveGitToken(config, project) {
  return project.gitToken || config.settings?.gitToken || process.env.OVERLEAF_GIT_TOKEN;
}

function resolveLocalPath(config, projectKey, project) {
  if (project.localPath) return project.localPath;
  if (config.settings?.repoDir) {
    return path.join(config.settings.repoDir, project.name || projectKey);
  }
  return path.join(os.tmpdir(), `overleaf-${project.projectId}`);
}

// Default project resolution:
//   1. explicit projectName argument
//   2. project whose `cwd` is a prefix of SESSION_CWD (longest match wins)
//   3. project keyed "default"
//   4. first project in file
function pickProjectKey(config, requested) {
  // An explicit request must resolve to a known project. If it cannot, throw --
  // never fall through to CWD autodetection, which is how writes used to land
  // silently in the wrong project.
  if (requested) {
    if (config.projects[requested]) return requested;
    const lc = String(requested).trim().toLowerCase();
    for (const [key, p] of Object.entries(config.projects)) {
      if (key.toLowerCase() === lc) return key;
      if (p.name && p.name.toLowerCase() === lc) return key;
    }
    throw new Error(
      `Project "${requested}" not found. Known keys: ${Object.keys(config.projects).join(', ') || '(none)'}. ` +
      `Pass an exact key/name, or omit projectName to auto-detect from the current directory.`
    );
  }

  // No explicit request: auto-detect from the session CWD (longest cwd prefix wins).
  if (SESSION_CWD) {
    let best = null;
    let bestLen = -1;
    for (const [key, p] of Object.entries(config.projects)) {
      if (p.cwd && (SESSION_CWD === p.cwd || SESSION_CWD.startsWith(p.cwd + path.sep))) {
        if (p.cwd.length > bestLen) {
          best = key;
          bestLen = p.cwd.length;
        }
      }
    }
    if (best) return best;
  }

  if (config.projects.default) return 'default';
  const keys = Object.keys(config.projects);
  if (keys.length) return keys[0];
  throw new Error('No projects configured');
}

class OverleafGitClient {
  constructor(projectId, gitToken, localPath, gitUrlOverride) {
    this.projectId = projectId;
    this.gitToken = gitToken;
    this.repoPath = localPath;
    this.gitUrl = gitUrlOverride || `https://git.overleaf.com/${projectId}`; // override for tests / token-free
  }

  // Run git without a shell. For authenticated remote ops the token is provided
  // through an inline credential helper that reads it from the environment, so
  // the token never appears in argv and therefore never in an error message.
  async _git(args, { auth = false } = {}) {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    const pre = [];
    if (auth) {
      if (!this.gitToken) {
        throw new Error('No Overleaf git token configured. Set settings.gitToken in projects.json or OVERLEAF_GIT_TOKEN env var.');
      }
      env.OVERLEAF_TOKEN = this.gitToken;
      pre.push(
        '-c', 'credential.helper=',
        '-c', 'credential.helper=!f() { test "$1" = get && echo username=git && echo "password=$OVERLEAF_TOKEN"; }; f'
      );
    }
    return execFile('git', [...pre, ...args], { env, maxBuffer: 20 * 1024 * 1024 });
  }

  async _hasRepo() {
    try { await access(path.join(this.repoPath, '.git')); return true; } catch { return false; }
  }

  async cloneOrPull() {
    if (!this.gitToken) {
      throw new Error('No Overleaf git token configured. Set settings.gitToken in projects.json or OVERLEAF_GIT_TOKEN env var.');
    }
    if (!(await this._hasRepo())) {
      await mkdir(path.dirname(this.repoPath), { recursive: true });
      const { stdout } = await this._git(['clone', this.gitUrl, this.repoPath], { auth: true });
      return stdout;
    }
    // Repair older clones that embedded the token in the remote URL.
    await this._git(['-C', this.repoPath, 'remote', 'set-url', 'origin', this.gitUrl]).catch(() => {});
    try {
      const { stdout } = await this._git(['-C', this.repoPath, 'pull', '--ff-only'], { auth: true });
      return stdout;
    } catch {
      // Pull failed (diverged, or leftover changes from a prior failed write).
      // Overleaf is the source of truth, so fetch and hard-reset to the remote
      // tip rather than cascading into a clone-into-nonempty-dir error.
      await this._git(['-C', this.repoPath, 'fetch', 'origin'], { auth: true });
      const { stdout: br } = await this._git(['-C', this.repoPath, 'rev-parse', '--abbrev-ref', 'HEAD']);
      const branch = (br || '').trim() || 'master';
      await this._git(['-C', this.repoPath, 'reset', '--hard', `origin/${branch}`]);
      return `recovered: hard-reset to origin/${branch}`;
    }
  }

  async listFiles(extension = '.tex') {
    await this.cloneOrPull();
    const out = [];
    const walk = async (dir) => {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.name === '.git') continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else if (e.isFile() && (!extension || e.name.endsWith(extension))) {
          out.push(path.relative(this.repoPath, full));
        }
      }
    };
    await walk(this.repoPath);
    return out.sort();
  }

  async readFile(filePath) {
    await this.cloneOrPull();
    const fullPath = path.join(this.repoPath, filePath);
    return await readFile(fullPath, 'utf-8');
  }

  // git blob SHA of a file at the current tip; null if the file isn't tracked.
  async getBlobSha(filePath) {
    await this.cloneOrPull();
    try {
      const { stdout } = await this._git(['-C', this.repoPath, 'rev-parse', `HEAD:${filePath}`]);
      return stdout.trim();
    } catch {
      return null;
    }
  }

  async getSections(filePath) {
    const content = await this.readFile(filePath);
    const sections = [];
    // Allow \section* and one level of nested braces in the title
    // (e.g. \section{The \textbf{bold} title}).
    const sectionRegex = /\\(section|subsection|subsubsection)\*?\{((?:[^{}]|\{[^{}]*\})*)\}/g;
    let match;
    while ((match = sectionRegex.exec(content)) !== null) {
      sections.push({ title: match[2], type: match[1], index: match.index });
    }
    return sections;
  }

  async compileFile(filePath, engine = 'lualatex') {
    await this.cloneOrPull();
    const engineFlag = { pdflatex: '-pdf', xelatex: '-xelatex', lualatex: '-lualatex' }[engine];
    if (!engineFlag) {
      throw new Error(`Invalid engine "${engine}". Choose from: pdflatex, xelatex, lualatex`);
    }
    // Build with latexmk from the repo root so the project's .latexmkrc (shell-
    // escape, the python@3.13 PATH fix for minted, $pdf_mode) applies, and so
    // references, citations and reruns resolve -- a single raw engine pass cannot.
    const texbin = '/Library/TeX/texbin';
    const env = { ...process.env, PATH: `${texbin}:${process.env.PATH || ''}` };
    const { stdout, stderr } = await execFile(
      path.join(texbin, 'latexmk'),
      [engineFlag, '-interaction=nonstopmode', '-halt-on-error', filePath],
      { cwd: this.repoPath, timeout: 180000, maxBuffer: 20 * 1024 * 1024, env }
    ).catch(e => ({ stdout: e.stdout || '', stderr: e.stderr || e.message }));

    const pdfPath = path.join(this.repoPath, filePath.replace(/\.tex$/, '.pdf'));
    let pdfExists = false;
    try { await access(pdfPath); pdfExists = true; } catch { /* no pdf */ }

    const log = `${stdout}\n${stderr}`;
    const errors = (log.match(/^!.*$/gm) || []).slice(0, 20);
    const undefinedRefs = (log.match(/^(?:LaTeX|Package)[^\n]*Warning:[^\n]*(?:undefined|multiply)[^\n]*/gmi) || []);
    const overfull = (log.match(/^(?:Overfull|Underfull)[^\n]*$/gm) || []).slice(0, 20);
    return {
      pdfPath: pdfExists ? pdfPath : null,
      errors,
      undefinedRefs,
      overfull,
      tail: log.slice(-2500),
    };
  }

  async commitAndPush(message, { addAll = false, addPath } = {}) {
    await this._git(['-C', this.repoPath, 'config', 'user.email', 'claude@anthropic.com']);
    await this._git(['-C', this.repoPath, 'config', 'user.name', 'Claude']);
    if (addAll) await this._git(['-C', this.repoPath, 'add', '-A']);
    else if (addPath) await this._git(['-C', this.repoPath, 'add', '--', addPath]);
    try {
      await this._git(['-C', this.repoPath, 'commit', '-m', message]);
    } catch (e) {
      if (/nothing to commit/i.test((e.stdout || '') + (e.stderr || ''))) {
        return { pushed: false, reason: 'nothing to commit' };
      }
      throw e;
    }
    await this._git(['-C', this.repoPath, 'push', 'origin', 'HEAD'], { auth: true });
    return { pushed: true };
  }

  async _currentBranch() {
    const { stdout } = await this._git(['-C', this.repoPath, 'rev-parse', '--abbrev-ref', 'HEAD']);
    return (stdout || '').trim() || 'master';
  }

  // Push origin HEAD. If the remote moved during the op (non-fast-forward),
  // let git 3-way merge it: clean merge -> push; real conflict -> abort, reset
  // to the remote tip, and throw (so nothing half-applied is left behind).
  async _pushWithMerge() {
    try {
      await this._git(['-C', this.repoPath, 'push', 'origin', 'HEAD'], { auth: true });
      return { pushed: true, merged: false };
    } catch {
      const branch = await this._currentBranch();
      await this._git(['-C', this.repoPath, 'fetch', 'origin'], { auth: true });
      try {
        await this._git(['-C', this.repoPath, 'merge', '--no-edit', `origin/${branch}`]);
      } catch (mergeErr) {
        await this._git(['-C', this.repoPath, 'merge', '--abort']).catch(() => {});
        await this._git(['-C', this.repoPath, 'reset', '--hard', `origin/${branch}`]);
        const e = new Error('conflict: the file changed on Overleaf in a way that overlaps this edit. Re-read the file and retry.');
        e.cause = mergeErr;
        throw e;
      }
      await this._git(['-C', this.repoPath, 'push', 'origin', 'HEAD'], { auth: true });
      return { pushed: true, merged: true };
    }
  }

  async writeFile(filePath, content, commitMessage = 'Update via Claude') {
    await this.cloneOrPull();
    const fullPath = path.join(this.repoPath, filePath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, 'utf-8');
    return await this.commitAndPush(commitMessage, { addPath: filePath });
  }

  async getSectionContent(filePath, sectionTitle) {
    const content = await this.readFile(filePath);
    const sections = await this.getSections(filePath);
    const target = sections.find(s => s.title === sectionTitle);
    if (!target) {
      throw new Error(`Section "${sectionTitle}" not found`);
    }
    // The body runs until the next heading of the SAME or HIGHER level, so a
    // \section keeps its \subsections instead of being cut at the first one.
    const rank = { section: 1, subsection: 2, subsubsection: 3 };
    const next = sections.find(s => s.index > target.index && rank[s.type] <= rank[target.type]);
    const endIdx = next ? next.index : content.length;
    return content.substring(target.index, endIdx);
  }
}

export { OverleafGitClient };

async function getClient(projectName) {
  const config = await loadConfig();
  const key = pickProjectKey(config, projectName);
  const project = config.projects[key];
  const gitToken = resolveGitToken(config, project);
  const localPath = resolveLocalPath(config, key, project);
  return { client: new OverleafGitClient(project.projectId, gitToken, localPath), key, project };
}

// Parse an SSA name like "Y1 ABC123 SSA 5" → { year, courseCode, ssaNum, slug }.
function parseSsaName(name) {
  const m = name.trim().match(/^Y(\d+)\s+([A-Za-z0-9]+)\s+SSA\s*(\d+)$/i);
  if (!m) {
    throw new Error(`SSA name must look like "Y<year> <COURSE_CODE> SSA <num>" (got "${name}")`);
  }
  return {
    year: parseInt(m[1], 10),
    courseCode: m[2].toUpperCase(),
    ssaNum: parseInt(m[3], 10),
    slug: `y${m[1]}-${m[2].toLowerCase()}-ssa${m[3]}`,
  };
}

// Extract Overleaf project id from a full URL or accept a bare id.
function parseOverleafRef(ref) {
  const trimmed = ref.trim();
  const urlMatch = trimmed.match(/overleaf\.com\/project\/([a-f0-9]{16,32})/i);
  if (urlMatch) return urlMatch[1];
  if (/^[a-f0-9]{16,32}$/i.test(trimmed)) return trimmed;
  throw new Error(`Could not extract Overleaf project id from "${ref}"`);
}

// Find the course folder matching <courseCode> under academicRoot/Year <year>/Q*.
async function findCourseFolder(academicRoot, year, courseCode) {
  const yearDir = path.join(academicRoot, `Year ${year}`);
  let quarters;
  try {
    quarters = await readdir(yearDir);
  } catch {
    throw new Error(`Year folder not found: ${yearDir}`);
  }
  const candidates = [];
  for (const q of quarters) {
    const qPath = path.join(yearDir, q);
    let s;
    try { s = await stat(qPath); } catch { continue; }
    if (!s.isDirectory()) continue;
    let entries;
    try { entries = await readdir(qPath); } catch { continue; }
    for (const e of entries) {
      // Course folder convention: code is the first whitespace-delimited token of the folder name.
      const firstToken = e.split(/[\s_-]/)[0].toUpperCase();
      if (firstToken === courseCode.toUpperCase()) {
        candidates.push({ quarter: q, folder: e, path: path.join(qPath, e) });
      }
    }
  }
  if (candidates.length === 0) {
    throw new Error(`No folder starting with "${courseCode}" found under any Q* of ${yearDir}`);
  }
  if (candidates.length > 1) {
    throw new Error(`Ambiguous: multiple course folders match "${courseCode}":\n${candidates.map(c => `  ${c.path}`).join('\n')}`);
  }
  return candidates[0];
}

// Wipe a duplicated SSA's body content while preserving the preamble and structure.
// Returns { changed: [...], skipped: [...] }.
async function resetSsaContent(repoPath, { ssaName, author, date, readUrl, dryRun } = {}) {
  const changed = [];
  const skipped = [];

  // 1. Empty chapter and appendix files matching the canonical layout.
  const chaptersDir = path.join(repoPath, 'Chapters');
  let chapterEntries = [];
  try { chapterEntries = await readdir(chaptersDir); } catch { skipped.push('Chapters/ (missing)'); }
  for (const f of chapterEntries) {
    if (!/^(ch\d+|app_[A-Za-z0-9]+)\.tex$/i.test(f)) continue;
    const p = path.join(chaptersDir, f);
    if (!dryRun) await writeFile(p, '', 'utf-8');
    changed.push(`Chapters/${f} (emptied)`);
  }

  // 2. Empty refs.bib if present.
  const refsPath = path.join(repoPath, 'refs.bib');
  try {
    await access(refsPath);
    if (!dryRun) await writeFile(refsPath, '', 'utf-8');
    changed.push('refs.bib (emptied)');
  } catch { skipped.push('refs.bib (missing)'); }

  // 3. Wipe figures/ contents (keep the dir).
  const figuresDir = path.join(repoPath, 'figures');
  let figureEntries = [];
  try { figureEntries = await readdir(figuresDir); } catch { skipped.push('figures/ (missing)'); }
  for (const f of figureEntries) {
    if (f === '.gitkeep') continue;
    const p = path.join(figuresDir, f);
    let s;
    try { s = await stat(p); } catch { continue; }
    if (s.isFile()) {
      if (!dryRun) await rm(p, { force: true });
      changed.push(`figures/${f} (removed)`);
    } else if (s.isDirectory()) {
      if (!dryRun) await rm(p, { recursive: true, force: true });
      changed.push(`figures/${f}/ (removed)`);
    }
  }

  // 4. Rewrite title block in main.tex if any header field was provided.
  if (ssaName || author || date || readUrl) {
    const mainPath = path.join(repoPath, 'main.tex');
    let main;
    try { main = await readFile(mainPath, 'utf-8'); }
    catch { skipped.push('main.tex (missing — header not rewritten)'); main = null; }
    if (main) {
      let updated = main;
      // Match \title{...} including a \textbf{...} wrapper.
      if (ssaName) {
        updated = updated.replace(/\\title\{[^}]*?(?:\{[^}]*\}[^}]*?)*\}/, () => `\\title{\\textbf{${ssaName}}}`);
        changed.push(`main.tex \\title{} → ${ssaName}`);
      }
      if (author) {
        updated = updated.replace(/\\author\{[^}]*?(?:\{[^}]*\}[^}]*?)*\}/, () => `\\author{\\textbf{${author}}}`);
        changed.push(`main.tex \\author{} → ${author}`);
      }
      if (date) {
        updated = updated.replace(/\\date\{[^}]*?(?:\{[^}]*\}[^}]*?)*\}/, () => `\\date{\\textbf{${date}}}`);
        changed.push(`main.tex \\date{} → ${date}`);
      }
      if (readUrl) {
        // Replace any line that is exactly \url{...} (the read-link under \maketitle).
        if (/\\url\{[^}]*\}/.test(updated)) {
          updated = updated.replace(/\\url\{[^}]*\}/, `\\url{${readUrl}}`);
          changed.push(`main.tex \\url{} → ${readUrl}`);
        } else {
          skipped.push('main.tex \\url{} (no existing \\url line found)');
        }
      }
      if (!dryRun) await writeFile(mainPath, updated, 'utf-8');
    }
  }

  return { changed, skipped };
}

async function readContext(projectKey, project) {
  const mdPath = path.join(CONTEXTS_DIR, `${projectKey}.md`);
  try {
    await access(mdPath);
    const md = await readFile(mdPath, 'utf-8');
    return { source: mdPath, body: md.trim() };
  } catch {
    if (project?.context) {
      return { source: '(inline in projects.json)', body: project.context };
    }
    return { source: '(none)', body: `(No context set. Create ${path.relative(__dirname, mdPath)} or call update_context to add notes for this project.)` };
  }
}

// MCP server
const server = new Server(
  { name: 'overleaf-mcp-server', version: '2.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'get_context',
      description: 'Read writing guidelines + per-project context. Always call this at the start of any writing or editing session, and re-read whenever instructions feel forgotten. Both the guidelines and the project context md are re-read from disk on every call, so external edits take effect immediately without restarting.',
      inputSchema: {
        type: 'object',
        properties: {
          projectName: { type: 'string', description: 'Project key. Omit to auto-detect from current working directory.' },
        },
      },
    },
    {
      name: 'list_projects',
      description: 'List configured Overleaf projects (key, name, projectId, cwd, localPath). Shows which one auto-detects as default from the current CWD.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'bootstrap_ssa',
      description: 'One-shot setup for a new SSA. Takes the Overleaf URL (or bare project id) and an SSA name in the format "Y<year> <COURSE_CODE> SSA <num>" (e.g. "Y1 ABC123 SSA 5"). Resolves the course folder under settings.academicRoot/Year <year>/Q*, creates settings.ssaSubdir/<ssaName>/ inside it, clones the Overleaf repo into a `overleaf/` subfolder, registers the project (key = slug), and scaffolds contexts/<slug>.md. If `cleanAfterClone` is true, also empties Chapters/ch*.tex, Chapters/app_*.tex, refs.bib, and figures/* and rewrites the title block in main.tex (use after duplicating a previous SSA in Overleaf). Returns a checklist of context questions; after the user answers, follow up with update_context to fill the context md.',
      inputSchema: {
        type: 'object',
        properties: {
          overleafRef: { type: 'string', description: 'Full Overleaf URL (https://www.overleaf.com/project/<id>) or just the project id.' },
          ssaName: { type: 'string', description: 'SSA name in the form "Y<year> <COURSE_CODE> SSA <num>", e.g. "Y1 ABC123 SSA 5".' },
          cleanAfterClone: { type: 'boolean', description: 'If true, run reset_ssa_content immediately after the clone (use when duplicating a previous SSA). Defaults to false.' },
          readUrl: { type: 'string', description: 'Optional Overleaf read-only URL (https://www.overleaf.com/read/...) to inject under the title.' },
        },
        required: ['overleafRef', 'ssaName'],
      },
    },
    {
      name: 'reset_ssa_content',
      description: 'Empty the body content of a duplicated SSA: clears Chapters/ch*.tex, Chapters/app_*.tex, refs.bib, and figures/* (keeps directories). Optionally rewrites \\title{}, \\author{}, \\date{}, and the standalone \\url{} line in main.tex. Commits and pushes. Run this AFTER duplicating a previous SSA project in the Overleaf web UI and cloning it locally, so you start from a clean slate without touching the preamble.',
      inputSchema: {
        type: 'object',
        properties: {
          projectName: { type: 'string', description: 'Project key. Defaults to the autodetected project.' },
          ssaName: { type: 'string', description: 'Optional. If given, used to rewrite \\title{}. Recommended format: full assignment title, e.g. "SSA 5 for ABC123 Course Title".' },
          author: { type: 'string', description: 'Optional. If given, rewrites \\author{}.' },
          date: { type: 'string', description: 'Optional. If given, rewrites \\date{}.' },
          readUrl: { type: 'string', description: 'Optional. If given, replaces the standalone \\url{...} line under \\maketitle.' },
          dryRun: { type: 'boolean', description: 'If true, report what would change but do not write or push.' },
        },
      },
    },
    {
      name: 'register_project',
      description: 'Add or overwrite a project entry in projects.json. Lets you onboard a new Overleaf project without hand-editing JSON. Uses the global gitToken from settings. After registering, also call update_context to set the project notes.',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Short identifier used to refer to this project (e.g. "ssa4", "thesis"). Becomes the filename of contexts/<key>.md.' },
          projectId: { type: 'string', description: 'Overleaf project ID (from the URL https://www.overleaf.com/project/<ID>).' },
          name: { type: 'string', description: 'Human-readable name. Defaults to the key if omitted.' },
          cwd: { type: 'string', description: 'Local workspace directory where you run Claude for this project. Used for autodetection. Defaults to the current session CWD.' },
          localPath: { type: 'string', description: 'Where to clone the Overleaf git repo. Defaults to settings.repoDir/<name>.' },
        },
        required: ['key', 'projectId'],
      },
    },
    {
      name: 'set_project_path',
      description: 'Update the local clone path (localPath) and/or cwd for an existing project without hand-editing JSON.',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Project key to update. Defaults to the autodetected project.' },
          localPath: { type: 'string', description: 'New local clone directory.' },
          cwd: { type: 'string', description: 'New workspace directory for autodetection.' },
        },
      },
    },
    {
      name: 'update_context',
      description: 'Replace (or append to) the project context md at contexts/<key>.md. Use this to record assignment-specific notes, terminology, deadlines, structure constraints. Takes effect immediately — no restart needed.',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Project key. Defaults to the autodetected project.' },
          content: { type: 'string', description: 'New context body (markdown).' },
          mode: { type: 'string', enum: ['replace', 'append'], description: 'replace (default) or append.' },
        },
        required: ['content'],
      },
    },
    {
      name: 'list_files',
      description: 'List files in the Overleaf project, filtered by extension.',
      inputSchema: {
        type: 'object',
        properties: {
          projectName: { type: 'string' },
          extension: { type: 'string', description: 'e.g. ".tex", ".bib". Defaults to ".tex".' },
        },
      },
    },
    {
      name: 'read_file',
      description: 'Read a file from the Overleaf project. The first line of the result is an overleaf-mcp comment carrying the file baseSha (its git blob hash); pass that baseSha to write_file to detect and refuse a clobber of concurrent Overleaf edits.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: { type: 'string' },
          projectName: { type: 'string' },
        },
        required: ['filePath'],
      },
    },
    {
      name: 'get_sections',
      description: 'List \\section / \\subsection / \\subsubsection entries in a .tex file.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: { type: 'string' },
          projectName: { type: 'string' },
        },
        required: ['filePath'],
      },
    },
    {
      name: 'get_section_content',
      description: 'Get the body of a single section by title.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: { type: 'string' },
          sectionTitle: { type: 'string' },
          projectName: { type: 'string' },
        },
        required: ['filePath', 'sectionTitle'],
      },
    },
    {
      name: 'compile_file',
      description: 'Compile a .tex file locally with LuaLaTeX (default), XeLaTeX, or pdfLaTeX. Pulls before compiling. ALWAYS run this after write_file before declaring work done — silent build breakage is the most common failure mode.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: { type: 'string' },
          engine: { type: 'string', description: 'pdflatex | xelatex | lualatex (default lualatex)' },
          projectName: { type: 'string' },
        },
        required: ['filePath'],
      },
    },
    {
      name: 'write_file',
      description: 'Write full file contents and push to Overleaf. After calling, ALWAYS call compile_file on the project entrypoint (usually main.tex) to verify the build still works. Do not declare a writing task complete without a successful compile.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: { type: 'string' },
          content: { type: 'string' },
          commitMessage: { type: 'string' },
          projectName: { type: 'string' },
        },
        required: ['filePath', 'content'],
      },
    },
    {
      name: 'status_summary',
      description: 'High-level project status: file count, main file, sections.',
      inputSchema: {
        type: 'object',
        properties: { projectName: { type: 'string' } },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const { name, arguments: args } = request.params;

    switch (name) {
      case 'list_projects': {
        const config = await loadConfig();
        const autodetected = (() => { try { return pickProjectKey(config); } catch { return null; } })();
        const projects = Object.entries(config.projects).map(([key, p]) => ({
          key,
          name: p.name,
          projectId: p.projectId,
          cwd: p.cwd || null,
          localPath: resolveLocalPath(config, key, p),
          autodetected: key === autodetected,
        }));
        return { content: [{ type: 'text', text: `Session CWD: ${SESSION_CWD}\n\n${JSON.stringify(projects, null, 2)}` }] };
      }

      case 'bootstrap_ssa': {
        const config = await loadConfig();
        const academicRoot = config.settings?.academicRoot;
        if (!academicRoot) throw new Error('settings.academicRoot not set in projects.json');
        const ssaSubdir = config.settings?.ssaSubdir || 'MY SSAs';

        const parsed = parseSsaName(args.ssaName);
        const projectId = parseOverleafRef(args.overleafRef);
        const course = await findCourseFolder(academicRoot, parsed.year, parsed.courseCode);

        const workspaceDir = path.join(course.path, ssaSubdir, args.ssaName.trim());
        const cloneDir = path.join(workspaceDir, 'overleaf');
        await mkdir(workspaceDir, { recursive: true });

        // Register the project so the MCP knows about it.
        const entry = {
          name: args.ssaName.trim(),
          projectId,
          cwd: workspaceDir,
          localPath: cloneDir,
        };
        config.projects[parsed.slug] = entry;
        await saveConfig(config);

        // Trigger clone now so user immediately has files locally.
        const gitToken = resolveGitToken(config, entry);
        const client = new OverleafGitClient(projectId, gitToken, cloneDir);
        let cloneStatus;
        let cleanReport = null;
        try {
          await client.cloneOrPull();
          cloneStatus = `✓ Cloned ${projectId} → ${cloneDir}`;
          if (args.cleanAfterClone) {
            // Course folder convention: "<CODE> - <descriptor>" → descriptor for the title.
            const descriptor = course.folder.split(/\s*-\s*/).slice(1).join(' - ').trim();
            const fullTitle = descriptor
              ? `SSA ${parsed.ssaNum} for ${parsed.courseCode} ${descriptor}`
              : `SSA ${parsed.ssaNum} for ${parsed.courseCode}`;
            const reset = await resetSsaContent(cloneDir, {
              ssaName: fullTitle,
              readUrl: args.readUrl,
            });
            // Stage + commit + push the wipe so Overleaf reflects it.
            try {
              const r = await client.commitAndPush(`Reset content for ${args.ssaName.trim()}`, { addAll: true });
              cleanReport = r.pushed ? reset : { ...reset, note: 'nothing to commit' };
            } catch (e) {
              cleanReport = { ...reset, note: `commit/push failed: ${e.message}` };
            }
          }
        } catch (e) {
          cloneStatus = `✗ Clone failed: ${e.message}\n  (project is still registered; fix the token or id and call list_files to retry)`;
        }

        // Scaffold context md with a question template.
        await mkdir(CONTEXTS_DIR, { recursive: true });
        const ctxPath = path.join(CONTEXTS_DIR, `${parsed.slug}.md`);
        const scaffold = `# ${args.ssaName.trim()}

> Fill these in. Each block is here because past SSAs have needed it. Drop blocks that genuinely do not apply, but do not leave them blank — empty context is the most common reason Claude drifts.

## Topic and scope
- What is this SSA actually about? One paragraph in your own words.
- What is in scope, and what is explicitly out of scope?

## Deadline and submission
- Hard deadline (date + time):
- Submission target (Canvas, hand-in, etc.):
- Page or length limit, if any:

## Collaborators and division of labour
- Who else is on this SSA:
- Who is doing what:
- What you specifically own:

## Pinned decisions
- Decisions already made that should not be re-litigated mid-draft:

## Source material
- Lecture notes / chapters / datasheets / papers you are working from:
- Citation style (default IEEE):

## Structure constraints
- Required sections (Goals, Summary, Details, etc.) in order:
- Anything unusual (e.g. an appendix the assignment requires):

## Known unknowns
- Things that are still open and will need updating:

## Other context
- Anything else Claude should keep in mind throughout the write-up:
`;
        try { await access(ctxPath); }
        catch { await writeFile(ctxPath, scaffold, 'utf-8'); }

        const checklist = [
          '',
          '## Next step — set up context',
          '',
          'Ask the user for the following, one block at a time, then call `update_context` (mode=replace) with the filled-in context md. Do not invent answers.',
          '',
          '1. Topic & scope (one paragraph + what is out of scope)',
          '2. Deadline and submission target (date, time, length limit if any)',
          '3. Collaborators and division of labour',
          '4. Pinned decisions to respect',
          '5. Source material (lecture notes, chapters, datasheets, papers)',
          '6. Required section structure (any deviations from the standard SSA layout)',
          '7. Known unknowns and anything else relevant',
          '',
          'After collecting, write the populated context md via `update_context` with `key: "' + parsed.slug + '"`.',
        ].join('\n');

        const lines = [
          `# Bootstrapped ${args.ssaName.trim()}`,
          ``,
          `**Course folder:** ${course.path}`,
          `**Workspace:** ${workspaceDir}`,
          `**Overleaf clone:** ${cloneDir}`,
          `**Project key:** \`${parsed.slug}\``,
          `**Context md:** ${path.relative(__dirname, ctxPath)}`,
          ``,
          cloneStatus,
        ];
        if (cleanReport) {
          lines.push('', '## Clean report');
          for (const c of cleanReport.changed) lines.push(`- ${c}`);
          for (const s of cleanReport.skipped) lines.push(`- (skipped) ${s}`);
          if (cleanReport.note) lines.push(`- note: ${cleanReport.note}`);
        }
        lines.push(checklist);

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      case 'reset_ssa_content': {
        const { client, project } = await getClient(args.projectName);
        await client.cloneOrPull();
        const report = await resetSsaContent(client.repoPath, {
          ssaName: args.ssaName,
          author: args.author,
          date: args.date,
          readUrl: args.readUrl,
          dryRun: args.dryRun,
        });
        let pushNote = '';
        if (!args.dryRun) {
          try {
            const r = await client.commitAndPush('Reset SSA content', { addAll: true });
            pushNote = r.pushed ? '✓ Pushed to Overleaf.' : '(nothing to commit — already clean)';
          } catch (e) {
            pushNote = `✗ commit/push failed: ${e.message}`;
          }
        } else {
          pushNote = '(dryRun — nothing written or pushed)';
        }
        const out = [
          `# Reset ${project.name}`,
          ``,
          ...report.changed.map(c => `- ${c}`),
          ...report.skipped.map(s => `- (skipped) ${s}`),
          ``,
          pushNote,
        ];
        return { content: [{ type: 'text', text: out.join('\n') }] };
      }

      case 'register_project': {
        const config = await loadConfig();
        if (!args.key || !args.projectId) throw new Error('key and projectId are required');
        const entry = {
          name: args.name || args.key,
          projectId: args.projectId,
        };
        if (args.cwd) entry.cwd = args.cwd;
        else if (SESSION_CWD) entry.cwd = SESSION_CWD;
        if (args.localPath) entry.localPath = args.localPath;
        config.projects[args.key] = entry;
        await saveConfig(config);
        await mkdir(CONTEXTS_DIR, { recursive: true });
        const ctxPath = path.join(CONTEXTS_DIR, `${args.key}.md`);
        try { await access(ctxPath); } catch {
          await writeFile(ctxPath, `# ${entry.name}\n\n(Context placeholder. Call update_context to fill this in, or edit ${path.relative(__dirname, ctxPath)} directly.)\n`, 'utf-8');
        }
        return { content: [{ type: 'text', text: `Registered "${args.key}" → ${args.projectId}\ncwd: ${entry.cwd || '(none)'}\nlocalPath: ${resolveLocalPath(config, args.key, entry)}\ncontext: ${path.relative(__dirname, ctxPath)}` }] };
      }

      case 'set_project_path': {
        const config = await loadConfig();
        const key = args.key || pickProjectKey(config);
        const p = config.projects[key];
        if (!p) throw new Error(`Project "${key}" not found`);
        if (args.localPath) p.localPath = args.localPath;
        if (args.cwd) p.cwd = args.cwd;
        await saveConfig(config);
        return { content: [{ type: 'text', text: `Updated "${key}":\n  cwd: ${p.cwd || '(unset)'}\n  localPath: ${resolveLocalPath(config, key, p)}` }] };
      }

      case 'update_context': {
        const config = await loadConfig();
        const key = args.key || pickProjectKey(config);
        if (!config.projects[key]) throw new Error(`Project "${key}" not found`);
        await mkdir(CONTEXTS_DIR, { recursive: true });
        const ctxPath = path.join(CONTEXTS_DIR, `${key}.md`);
        const mode = args.mode || 'replace';
        let body = args.content;
        if (mode === 'append') {
          let existing = '';
          try { existing = await readFile(ctxPath, 'utf-8'); } catch { /* none */ }
          body = existing.replace(/\s+$/, '') + '\n\n' + args.content + '\n';
        } else if (!body.endsWith('\n')) {
          body += '\n';
        }
        await writeFile(ctxPath, body, 'utf-8');
        return { content: [{ type: 'text', text: `Wrote context for "${key}" → ${path.relative(__dirname, ctxPath)} (${mode})` }] };
      }

      case 'get_context': {
        const config = await loadConfig();
        const key = pickProjectKey(config, args.projectName);
        const project = config.projects[key];
        let guidelines = '';
        try { guidelines = await readFile(GUIDELINES_PATH, 'utf-8'); }
        catch { guidelines = '(writing-guidelines.md missing from OverleafMCP folder)'; }
        const ctx = await readContext(key, project);
        const text = [
          `# Writing Context`,
          ``,
          `**Active project:** \`${key}\` — ${project.name}`,
          `**Context source:** ${ctx.source}`,
          ``,
          `---`,
          ``,
          `## Global Guidelines`,
          ``,
          guidelines.trim(),
          ``,
          `---`,
          ``,
          `## Project Context — ${project.name}`,
          ``,
          ctx.body,
        ].join('\n');
        return { content: [{ type: 'text', text }] };
      }

      case 'list_files': {
        const { client } = await getClient(args.projectName);
        const files = await client.listFiles(args.extension || '.tex');
        return { content: [{ type: 'text', text: files.join('\n') }] };
      }

      case 'read_file': {
        const { client } = await getClient(args.projectName);
        const content = await client.readFile(args.filePath);
        const baseSha = await client.getBlobSha(args.filePath);
        const header = `<!-- overleaf-mcp baseSha: ${baseSha || 'none'} (pass as baseSha to write_file to guard against clobbering Overleaf edits) -->\n`;
        return { content: [{ type: 'text', text: header + content }] };
      }

      case 'get_sections': {
        const { client } = await getClient(args.projectName);
        const sections = await client.getSections(args.filePath);
        return { content: [{ type: 'text', text: JSON.stringify(sections, null, 2) }] };
      }

      case 'get_section_content': {
        const { client } = await getClient(args.projectName);
        const content = await client.getSectionContent(args.filePath, args.sectionTitle);
        return { content: [{ type: 'text', text: content }] };
      }

      case 'compile_file': {
        const { client } = await getClient(args.projectName);
        const r = await client.compileFile(args.filePath, args.engine || 'lualatex');
        const status = r.pdfPath ? `✓ PDF written to ${r.pdfPath}` : '✗ Compilation failed — no PDF produced';
        const parts = [status];
        if (r.errors.length)        parts.push(`\n--- Errors (${r.errors.length}) ---\n${r.errors.join('\n')}`);
        if (r.undefinedRefs.length) parts.push(`\n--- Undefined refs/citations (${r.undefinedRefs.length}) ---\n${r.undefinedRefs.join('\n')}`);
        if (r.overfull.length)      parts.push(`\n--- Overfull/Underfull (${r.overfull.length}) ---\n${r.overfull.join('\n')}`);
        parts.push(`\n--- Log tail ---\n${r.tail}`);
        return { content: [{ type: 'text', text: parts.join('\n').trim() }] };
      }

      case 'write_file': {
        const { client } = await getClient(args.projectName);
        const res = await client.writeFile(args.filePath, args.content, args.commitMessage);
        const tail = res.pushed
          ? `Pushed ${args.filePath}. NEXT STEP: call compile_file on the project main .tex to verify the build still works before declaring done.`
          : `No changes detected for ${args.filePath} (${res.reason}).`;
        return { content: [{ type: 'text', text: tail }] };
      }

      case 'status_summary': {
        const { client, key, project } = await getClient(args.projectName);
        const files = await client.listFiles();
        const mainFile = files.find(f => /(^|\/)main\.tex$/.test(f)) || files[0];
        let sections = [];
        if (mainFile) sections = await client.getSections(mainFile);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              activeProjectKey: key,
              activeProjectName: project.name,
              totalFiles: files.length,
              mainFile,
              totalSections: sections.length,
              files: files.slice(0, 20),
            }, null, 2),
          }],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    // Defense in depth: scrub any tokenized URL that might surface in an error.
    const msg = String(error?.message ?? error).replace(/git:[^@\s/]+@/g, 'git:***@');
    return {
      content: [{ type: 'text', text: `Error: ${msg}` }],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Overleaf MCP server v2 running on stdio (session cwd: ${SESSION_CWD})`);
}

// Only launch the stdio server when run directly, not when imported by tests.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}
