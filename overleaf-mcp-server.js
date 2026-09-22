#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { readFile, writeFile, access, mkdir, readdir, stat, rm, rename, copyFile } from 'fs/promises';
import { existsSync, realpathSync, readFileSync } from 'fs';
import { promisify } from 'util';
import { execFile as execFileCallback } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import { createHash } from 'node:crypto';
import { dependencyIndex, changeReport } from './dependency-index.js';
import { renderPages } from './render-cache.js';
import { applyChanges, publishChanges } from './transactions.js';
import { observeTool, usageStats, toolError } from './runtime-observability.js';
import { versionedContext, buildFingerprint, sectionBundle, sectionText, controlledBuildOptions } from './efficiency.js';
const verifiedBuilds = new Map();
const recentPasses = new Map();
const buildQueues = new Map();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Every subprocess call goes through execFile (no shell): no shell injection and
// no secrets in command strings. Git auth is supplied via an inline credential
// helper that reads the token from the environment (see OverleafGitClient._git).
const execFile = promisify(execFileCallback);

// --- Paths: bundled assets vs. writable user state --------------------------
// Bundled, read-only defaults (templates, the default writing-guidelines) ship
// inside the package and are read from PACKAGE_DIR. User state (the token
// config, per-project contexts, customised templates, and git clones) must live
// somewhere writable, because the package can run from an immutable npm/npx
// cache. Anything a user edits resolves user-copy-first, bundled-default-last.
const PACKAGE_DIR = __dirname;

// Single source of truth for the version: read it from the shipped package.json
// so `npm version` is the only place a release number changes. Fall back to '0.0.0'
// if package.json is somehow unreadable (never fatal).
let PKG_VERSION = '0.0.0';
try { PKG_VERSION = JSON.parse(readFileSync(path.join(PACKAGE_DIR, 'package.json'), 'utf-8')).version || PKG_VERSION; } catch { /* keep fallback */ }

// Expand a leading ~ to the user's home. Plain join elsewhere assumes absolute.
function expandHome(p) {
  if (!p) return p;
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

// Where user state lives. Precedence:
//   1. $OVERLEAF_MCP_HOME                      (explicit override)
//   2. PACKAGE_DIR, if it already holds a projects.json (existing local clones)
//   3. ~/.overleaf-mcp                         (fresh npx / global installs)
// Pure (FS facts injected) so the precedence is unit-testable.
export function resolveDataHome({ env, packageDir, homeDir, hasPackageConfig }) {
  const override = (env.OVERLEAF_MCP_HOME || '').trim();
  if (override) return override.startsWith('~') ? path.join(homeDir, override.slice(1)) : override;
  if (hasPackageConfig) return packageDir;
  return path.join(homeDir, '.overleaf-mcp');
}

// Build a single-project config from environment variables alone, so the server
// runs with zero config files (the common LM Studio / Claude Desktop case: token
// and project id passed via the client's `env` block). Returns null when the env
// doesn't carry enough to act on.
export function synthesizeConfigFromEnv(env, defaultRepoDir) {
  const gitToken = env.OVERLEAF_GIT_TOKEN;
  const projectId = env.OVERLEAF_PROJECT_ID;
  if (!gitToken || !projectId) return null;
  return {
    settings: { gitToken, repoDir: defaultRepoDir },
    projects: {
      default: {
        name: env.OVERLEAF_PROJECT_NAME || 'Overleaf Project',
        projectId,
        localPath: path.join(defaultRepoDir, 'default'),
      },
    },
  };
}

const DATA_HOME = resolveDataHome({
  env: process.env,
  packageDir: PACKAGE_DIR,
  homeDir: os.homedir(),
  hasPackageConfig: existsSync(path.join(PACKAGE_DIR, 'projects.json')),
});

const CONFIG_PATH = path.join(DATA_HOME, 'projects.json');
const CONTEXTS_DIR = path.join(DATA_HOME, 'contexts');
const DEFAULT_REPO_DIR = path.join(DATA_HOME, 'repos');
const BUNDLED_TEMPLATES_DIR = path.join(PACKAGE_DIR, 'templates');
// Guidelines resolve personal-first:
//   1. <dataHome>/writing-guidelines.local.md  (gitignored; never ships)
//   2. <dataHome>/writing-guidelines.md        (user copy, when dataHome is not the package)
//   3. <packageDir>/writing-guidelines.md      (bundled generic default)
// The .local name is what keeps a personal copy distinct when dataHome IS the
// package dir (a local clone with projects.json), where 2 and 3 are one file.
// Resolved per call so creating or deleting the local file needs no restart.
export function resolveGuidelinesPath({ dataHome, packageDir, exists }) {
  const local = path.join(dataHome, 'writing-guidelines.local.md');
  if (exists(local)) return local;
  const user = path.join(dataHome, 'writing-guidelines.md');
  if (exists(user)) return user;
  return path.join(packageDir, 'writing-guidelines.md');
}

// Where scaffold templates (main.tex skeleton, context-scaffold.md) are read.
// Precedence: settings.templatesDir → $OVERLEAF_MCP_TEMPLATES → ~/.overleaf-mcp/
// templates (if present) → bundled defaults. Lets a user customise the scaffolds.
function resolveTemplatesDir(config) {
  const fromSettings = config?.settings?.templatesDir;
  if (fromSettings) return expandHome(fromSettings);
  const fromEnv = (process.env.OVERLEAF_MCP_TEMPLATES || '').trim();
  if (fromEnv) return expandHome(fromEnv);
  const inHome = path.join(DATA_HOME, 'templates');
  if (existsSync(inHome)) return inHome;
  return BUNDLED_TEMPLATES_DIR;
}

// Read a named template from the resolved templates dir; null if absent so the
// caller can fall back to a built-in default (templates must never hard-fail).
async function loadTemplate(config, filename) {
  try { return await readFile(path.join(resolveTemplatesDir(config), filename), 'utf-8'); }
  catch { return null; }
}

// Built-in fallback for templates/context-scaffold.md, used when the user has
// not supplied their own. __SSA_NAME__ is substituted at scaffold time.
const DEFAULT_CONTEXT_SCAFFOLD = `# __SSA_NAME__

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

// Capture the cwd Claude Code spawned this MCP from. Used for project autodetection.
const SESSION_CWD = process.cwd();

// Re-read on every call so register_project / token rotation / context edits
// take effect immediately without restarting Claude. A missing config is not an
// error: fall back to env-only mode, then to an empty config so the server still
// starts and tools return actionable messages instead of dying at spawn.
async function loadConfig() {
  try {
    const raw = await readFile(CONFIG_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;   // corrupt / unreadable: surface it
    const fromEnv = synthesizeConfigFromEnv(process.env, DEFAULT_REPO_DIR);
    if (fromEnv) return fromEnv;
    return { settings: {}, projects: {} };
  }
}

async function saveConfig(config) {
  // Ensure the data home exists (env-only / fresh installs may not have it yet),
  // then write-temp-then-rename so a crash mid-write can't corrupt projects.json
  // (it holds the token and every project entry).
  await mkdir(path.dirname(CONFIG_PATH), { recursive: true });
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
  return path.join(DEFAULT_REPO_DIR, project.name || projectKey);
}

// The global settings the `configure` tool manages, each with the question to
// ask the user when it is unset. Order is the order to ask in.
const SETTING_HELP = {
  repoDir:      'Where should project clones land by default? (absolute path; clones go to repoDir/<name>)',
  academicRoot: 'Where do your course folders live? (bootstrap_ssa searches academicRoot/Year <n>/Q*/<COURSE>*)',
  ssaSubdir:    'What subfolder name should new SSAs go under inside each course folder? (e.g. "MY SSAs")',
  templatesDir: 'Use your own scaffold templates? Give the directory holding main.tex / context-scaffold.md (blank keeps the bundled examples).',
  voiceLinter:  'Use your own prose linter for voice_lint? Give the command (takes a file path, exits non-zero on findings; blank keeps the bundled example).',
  autoPush:     'Should edit tools push to Overleaf immediately (true), or commit locally until publish_changes sends a verified batch (false, the default)?',
  gitToken:    'Overleaf git token (prefer the OVERLEAF_GIT_TOKEN env var; set here only if you must store it in projects.json).',
};
const SETTING_KEYS = Object.keys(SETTING_HELP);
const SETTING_PATHY = new Set(['repoDir', 'academicRoot', 'templatesDir']);

// Merge the provided settings into the current ones, expanding a leading ~ for
// path-like fields. Pure (homeDir injected) so it is unit-testable. Returns the
// new settings object and the list of keys actually changed.
export function mergeSettings(current, args, homeDir) {
  const settings = { ...(current || {}) };
  const provided = [];
  for (const k of SETTING_KEYS) {
    if (args[k] === undefined) continue;
    let v = args[k];
    if (typeof v === 'string' && SETTING_PATHY.has(k) && v.startsWith('~')) v = path.join(homeDir, v.slice(1));
    settings[k] = v;
    provided.push(k);
  }
  return { settings, provided };
}

// Whether a mutating tool pushes to Overleaf. An explicit per-call `push` wins,
// then settings.autoPush; the default is false, so edits stay local commits
// until publish_changes verifies and sends them in one deliberate step.
export function resolvePush(settings, args) {
  if (typeof args?.push === 'boolean') return args.push;
  return settings?.autoPush === true;
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

// Pure: classify a latexmk/LaTeX log into a build verdict. Exported for tests.
// pass iff a PDF was produced AND there are no errors, undefined references, or
// undefined citations. Overfull/underfull boxes are reported but never fail.
export function classifyBuildLog(log) {
  const text = String(log || '');
  const pageMatches = [...text.matchAll(/Output written on [^\n(]*\((\d+) pages?/g)];
  const pageCount = pageMatches.length ? Number(pageMatches[pageMatches.length - 1][1]) : null;
  const pdfProduced = pageCount !== null;
  const undefinedRefs = text.match(/^LaTeX Warning: Reference [^\n]*undefined[^\n]*/gim) || [];
  const undefinedCitations = text.match(/^(?:LaTeX|Package natbib|Package biblatex)[^\n]*Warning:[^\n]*Citation[^\n]*undefined[^\n]*/gim) || [];
  const errors = (text.match(/^! [^\n]*/gm) || [])
    .concat(text.match(/^(?:Latexmk|Fatal error)[^\n]*(?:error|failed|fatal)[^\n]*/gim) || []);
  const overfullCount = (text.match(/^Overfull \\[hv]box/gm) || []).length;
  const underfullCount = (text.match(/^Underfull \\[hv]box/gm) || []).length;
  const pass = pdfProduced && errors.length === 0 && undefinedRefs.length === 0 && undefinedCitations.length === 0;
  return { pass, pageCount, undefinedRefs, undefinedCitations, errors, overfullCount, underfullCount, pdfProduced };
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
    const { stdout } = await this._git(['-C', this.repoPath, 'pull', '--ff-only'], { auth: true });
    return stdout;
  }

  async requireLocal() {
    if (!(await this._hasRepo())) throw Object.assign(new Error('Local clone missing; call sync_project explicitly.'), { code: 'LOCAL_CLONE_MISSING' });
  }

  // Mutations that push absorb remote edits first; local-only mutations stay
  // off the network entirely, like reads.
  async _prepareMutation(push) {
    if (push) await this.cloneOrPull();
    else await this.requireLocal();
    await this._git(['-C', this.repoPath, 'config', 'user.email', 'claude@anthropic.com']);
    await this._git(['-C', this.repoPath, 'config', 'user.name', 'Claude']);
    return this._head();
  }

  async _head() {
    const { stdout } = await this._git(['-C', this.repoPath, 'rev-parse', 'HEAD']);
    return stdout.trim();
  }

  // HEAD plus the number of local commits not yet on the remote-tracking branch.
  // unpublished is null when there is no tracking ref to compare against.
  async pendingState() {
    const head = await this._head();
    const branch = await this._currentBranch();
    let unpublished = null;
    try {
      const { stdout } = await this._git(['-C', this.repoPath, 'rev-list', '--count', `origin/${branch}..HEAD`]);
      unpublished = Number(stdout.trim());
    } catch { /* no tracking ref */ }
    return { head, unpublished };
  }

  // Finish a mutation whose commit is already made. push:false keeps it local
  // for publish_changes. A refused push rolls back to preHead, this operation's
  // own starting point: only its commit is undone, and earlier unpublished
  // commits survive. (Resetting to origin/<branch> would silently drop them.)
  async _finishMutation(preHead, push, { merge = false, refusal }) {
    if (!push) return { pushed: false, committed: true, ...(await this.pendingState()) };
    if (merge) return this._pushWithMerge(preHead);
    try {
      await this._git(['-C', this.repoPath, 'push', 'origin', 'HEAD'], { auth: true });
    } catch (e) {
      await this._git(['-C', this.repoPath, 'reset', '--hard', preHead]).catch(() => {});
      throw new Error(`${refusal} (${(e.stderr || e.message || '').slice(0, 120)})`);
    }
    return { pushed: true };
  }

  // git commit that reports "nothing to commit" as a value instead of throwing.
  async _commit(message) {
    try {
      await this._git(['-C', this.repoPath, 'commit', '-m', message]);
      return true;
    } catch (e) {
      if (/nothing to commit/i.test((e.stdout || '') + (e.stderr || ''))) return false;
      throw e;
    }
  }

  async listFiles(extension = '.tex') {
    await this.requireLocal();
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
    await this.requireLocal();
    const root = realpathSync(this.repoPath);
    const fullPath = realpathSync(path.resolve(root, filePath));
    if (!fullPath.startsWith(root + path.sep)) throw Object.assign(new Error('File must be inside the project.'), { code: 'INVALID_INPUT' });
    return await readFile(fullPath, 'utf-8');
  }

  // git blob SHA of a file at the current tip; null if the file isn't tracked.
  async getBlobSha(filePath) {
    await this.requireLocal();
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

  // Run latexmk from the repo root (so the project's .latexmkrc -- shell-escape,
  // the python@3.13 PATH fix for minted, $pdf_mode -- applies, and refs/citations/
  // reruns resolve). clean:true adds -gg to force a complete from-scratch rebuild.
  async _runLatexmk(filePath, engine = 'lualatex', { clean = false, controlled = false } = {}) {
    const full = path.resolve(this.repoPath, filePath);
    if (!full.startsWith(path.resolve(this.repoPath) + path.sep) || !filePath.endsWith('.tex') || filePath.startsWith('-')) throw new Error('Build entrypoint must be a .tex path inside the project.');
    if (!(await this._hasRepo())) throw new Error('Local clone missing; call sync_project explicitly before building.');
    const engineFlag = { pdflatex: '-pdf', xelatex: '-xelatex', lualatex: '-lualatex' }[engine];
    if (!engineFlag) {
      throw new Error(`Invalid engine "${engine}". Choose from: pdflatex, xelatex, lualatex`);
    }
    const texbin = '/Library/TeX/texbin';
    const env = { ...process.env, PATH: `${texbin}:${process.env.PATH || ''}` };
    const args = [engineFlag, '-interaction=nonstopmode', '-halt-on-error', '-recorder'];
    // -norc must precede all other options so no user or project Perl config runs.
    if (controlled) args.unshift('-norc', '-no-shell-escape');
    if (clean) args.push('-gg');
    args.push(filePath);
    let commandFailed = false;
    const { stdout, stderr } = await execFile(
      path.join(texbin, 'latexmk'), args,
      { cwd: this.repoPath, timeout: 180000, maxBuffer: 20 * 1024 * 1024, env }
    ).catch(e => { commandFailed = true; return { stdout: e.stdout || '', stderr: e.stderr || e.message }; });
    const pdfPath = path.join(this.repoPath, filePath.replace(/\.tex$/, '.pdf'));
    let pdfExists = false;
    try { await access(pdfPath); pdfExists = true; } catch { /* no pdf */ }
    return { stdout, stderr, commandFailed, log: `${stdout}\n${stderr}`, pdfPath: !commandFailed && pdfExists ? pdfPath : null };
  }

  async compileFile(filePath, engine = 'lualatex', options = {}) {
    return this.verifyBuild(filePath, engine, { ...options, force: true, clean: false });
  }

  // Explicit sync. Fetches, then acts on the ahead/behind relation:
  //   behind only        -> fast-forward
  //   ahead only / equal -> nothing to do (ahead = unpublished local commits)
  //   diverged           -> report both sides and change nothing, unless a
  //                         strategy is chosen:
  //     'rebase' replays local commits onto the remote; a conflict aborts back
  //              to the untouched pre-sync state.
  //     'reset'  discards local work to match the remote. Requires confirm to
  //              equal the reported local HEAD (proof the report was read), and
  //              tags the old HEAD and any uncommitted edits as mcp-backup/*
  //              first, so nothing becomes unrecoverable.
  async syncProject({ strategy, confirm } = {}) {
    if (!(await this._hasRepo())) {
      await this.cloneOrPull();
      return { state: 'cloned', ...(await this.pendingState()) };
    }
    if (strategy !== undefined && strategy !== 'rebase' && strategy !== 'reset') {
      throw new Error(`Unknown strategy "${strategy}". Use "rebase" or "reset".`);
    }
    const g = (args, opts) => this._git(['-C', this.repoPath, ...args], opts);
    await g(['remote', 'set-url', 'origin', this.gitUrl]).catch(() => {});
    await g(['fetch', 'origin'], { auth: true });
    // rebase and stash create write commits, which need a committer identity.
    await g(['config', 'user.email', 'claude@anthropic.com']);
    await g(['config', 'user.name', 'Claude']);
    const branch = await this._currentBranch();
    const upstream = `origin/${branch}`;
    const count = async range => Number((await g(['rev-list', '--count', range])).stdout.trim());
    const ahead = await count(`${upstream}..HEAD`);
    const behind = await count(`HEAD..${upstream}`);
    const head = await this._head();
    const dirty = (await g(['status', '--porcelain=v1', '--untracked-files=no'])).stdout.split('\n').filter(Boolean).map(l => l.slice(3));

    if (strategy === 'reset') {
      if (confirm !== head) {
        throw new Error(`reset discards local work; pass confirm: "${head}" (the current local HEAD) after reviewing the sync_project report.`);
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backups = [`mcp-backup/${stamp}`];
      await g(['tag', backups[0], head]);
      if (dirty.length) {
        // stash create snapshots uncommitted tracked edits as a commit without
        // touching the working tree; the tag keeps it reachable.
        const wip = (await g(['stash', 'create', `mcp-backup ${stamp}`])).stdout.trim();
        if (wip) { backups.push(`mcp-backup/${stamp}-wip`); await g(['tag', backups[1], wip]); }
      }
      await g(['reset', '--hard', upstream]);
      return { state: 'reset', discardedCommits: ahead, discardedFiles: dirty, backups, ...(await this.pendingState()) };
    }

    if (behind === 0) return { state: ahead ? 'ahead' : 'up-to-date', ahead, behind, head, dirtyFiles: dirty };
    if (ahead === 0) {
      await g(['merge', '--ff-only', upstream]);
      return { state: 'fast-forwarded', ahead, behind, ...(await this.pendingState()) };
    }

    const log = async range => (await g(['log', '--format=%h %s', '--name-only', range])).stdout.trim();
    const report = {
      state: 'diverged', ahead, behind, head, upstream: (await g(['rev-parse', upstream])).stdout.trim(),
      localCommits: await log(`${upstream}..HEAD`), remoteCommits: await log(`HEAD..${upstream}`), dirtyFiles: dirty,
      options: 'strategy:"rebase" replays local commits onto Overleaf (aborts cleanly on conflict); strategy:"reset" with confirm:<head> discards local work after tagging a backup.',
    };
    if (strategy !== 'rebase') return report;
    if (dirty.length) throw new Error(`rebase needs a clean working tree; uncommitted edits in: ${dirty.join(', ')}. Commit them or choose reset.`);
    try {
      await g(['rebase', upstream]);
    } catch {
      const conflicts = (await g(['diff', '--name-only', '--diff-filter=U']).catch(() => ({ stdout: '' }))).stdout.trim().split('\n').filter(Boolean);
      await g(['rebase', '--abort']).catch(() => {});
      return { ...report, state: 'rebase-conflict', conflicts, note: 'Rebase aborted; local state is unchanged.' };
    }
    return { state: 'rebased', ...(await this.pendingState()) };
  }

  // options.lint (true = every .tex file, or an array of paths) adds the voice
  // linter to the gate: findings fail it like an undefined reference does.
  // Lint runs outside the build cache, so a reused build verdict is never
  // mutated and lint always sees the current files.
  async verifyBuild(filePath, engine = 'lualatex', options = {}) {
    const key = path.resolve(this.repoPath);
    const previous = buildQueues.get(key) || Promise.resolve();
    const task = previous.catch(() => {}).then(() => this._verifyLocal(filePath, engine, options));
    buildQueues.set(key, task);
    let verdict;
    try { verdict = await task; } finally { if (buildQueues.get(key) === task) buildQueues.delete(key); }
    if (!options.lint) return verdict;
    const files = Array.isArray(options.lint) ? options.lint : await this.listFiles('.tex');
    const lint = await this.lintFiles(files, options.lintCommand);
    return { ...verdict, lint, pass: verdict.pass && lint.clean };
  }

  async lintFiles(files, command) {
    const results = [];
    for (const file of files) results.push({ file, ...(await this.voiceLint(file, { command })) });
    return { clean: results.every(r => r.clean), results };
  }

  async _verifyLocal(filePath, engine, options = {}) {
    const { force = false, clean = true } = options;
    const config = controlledBuildOptions(options);
    // Resolved so the gate (client.repoPath) and publish (path.resolve(root)) share a key.
    const key = JSON.stringify([path.resolve(this.repoPath),filePath,engine,config]);
    const fingerprint = () => buildFingerprint(this.repoPath,filePath,engine,config).catch(()=>null);
    const sources = () => buildFingerprint(this.repoPath,filePath,engine,{...config,sourcesOnly:true});
    const cached = verifiedBuilds.get(key);
    const before = await sources();
    if (!force && cached && cached.fingerprint === await fingerprint()) return { ...cached.verdict, reused: true };
    // publish_changes re-verifies a commit the final gate usually just passed.
    // Projects with executable config (rc files, minted, shell escape) never
    // qualify for the full cache above, so without this every publish would
    // rebuild from scratch. Reuse is allowed only when every project file is
    // byte-identical to the state right after that PASS (the sources hash
    // covers tracked and untracked files, the environment and the day) within
    // this process. Not covered: a TeX installation change in between.
    const recent = recentPasses.get(key);
    if (options.reuseRecentPass && !force && recent && recent.sources === before) return { ...recent.verdict, reused: true };
    verifiedBuilds.delete(key);
    const { log: runLog, pdfPath, commandFailed } = await this._runLatexmk(filePath,engine,{clean,controlled:config.controlled});
    const logPath = path.join(this.repoPath,filePath.replace(/\.tex$/,'.log'));
    let finalLog = runLog;
    try { finalLog = await readFile(logPath,'utf8'); } catch { /* failed before log creation */ }
    const verdict = classifyBuildLog(finalLog);
    if (commandFailed) verdict.errors.push('latexmk command failed; any previous PDF is not a successful build.');
    verdict.pdfProduced = pdfPath !== null;
    verdict.pass = verdict.pdfProduced && !verdict.errors.length && !verdict.undefinedRefs.length && !verdict.undefinedCitations.length;
    verdict.logPath = logPath;
    verdict.pdfPath = pdfPath;
    verdict.tail = (commandFailed ? runLog : finalLog).slice(-2500);
    verdict.reused = false;
    const after = await sources();
    if (before && before !== after) { verdict.pass = false; verdict.errors.push('Project inputs changed during the build; verify the latest source again.'); }
    const print = before && before === after ? await fingerprint() : null;
    verdict.cacheEligible = Boolean(print);
    if (verdict.pass && print) verifiedBuilds.set(key,{ fingerprint:print,verdict });
    if (verdict.pass && before === after) recentPasses.set(key, { sources: after, verdict });
    else recentPasses.delete(key);
    return verdict;
  }

  // Read-only grep across tracked files. Regex by default; fixed -> -F; ignoreCase -> -i.
  async searchText({ query, fixed = false, ignoreCase = false, extension } = {}) {
    if (!query) throw new Error('search_text needs a query.');
    await this.requireLocal();
    const args = ['-C', this.repoPath, 'grep', '-n', '--no-color', fixed ? '-F' : '-E'];
    if (ignoreCase) args.push('-i');
    args.push('-e', query);
    if (extension) args.push('--', `*${extension}`);
    try {
      const { stdout } = await this._git(args);
      const lines = stdout.split('\n').filter(Boolean);
      return { matches: lines.slice(0, 200), total: lines.length };
    } catch (e) {
      if (e.code === 1 && !(e.stderr && e.stderr.trim())) return { matches: [], total: 0 }; // git grep: no matches
      throw e;
    }
  }

  // Append a BibTeX entry to refs.bib (reject a duplicate key), commit, and
  // push when push is true.
  async addCitation({ entry, commitMessage, push = true } = {}) {
    if (!entry || !entry.trim()) throw new Error('add_citation needs a BibTeX entry.');
    const m = entry.match(/@\w+\s*\{\s*([^,\s]+)/);
    if (!m) throw new Error('Could not find a BibTeX key in the entry (expected @type{key, ...}).');
    const key = m[1];
    const preHead = await this._prepareMutation(push);
    const bibPath = path.join(this.repoPath, 'refs.bib');
    let current = '';
    try { current = await readFile(bibPath, 'utf-8'); } catch { /* missing -> create */ }
    const dup = new RegExp(`@\\w+\\s*\\{\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*,`);
    if (dup.test(current)) throw new Error(`citation key "${key}" already in refs.bib.`);
    await writeFile(bibPath, current.replace(/\s*$/, '') + '\n\n' + entry.trim() + '\n', 'utf-8');
    await this._git(['-C', this.repoPath, 'add', '--', 'refs.bib']);
    if (!(await this._commit(commitMessage || `Add citation ${key}`))) return { pushed: false, reason: 'nothing to commit', key };
    return { ...(await this._finishMutation(preHead, push, { merge: true })), key };
  }

  // Read-only: cited keys (across .tex) vs defined keys (refs.bib).
  async citeLint() {
    await this.requireLocal();
    const texFiles = await this.listFiles('.tex');
    const citeRe = /\\(?:cite|autocite|parencite|citep|citet|textcite|footcite|nocite)\*?(?:\[[^\]]*\])*\{([^}]+)\}/g;
    const cited = new Set();
    for (const f of texFiles) {
      const content = await readFile(path.join(this.repoPath, f), 'utf-8');
      let m;
      while ((m = citeRe.exec(content)) !== null) {
        for (const k of m[1].split(',')) {
          const key = k.trim();
          if (key && key !== '*') cited.add(key);
        }
      }
    }
    let bib = '';
    try { bib = await readFile(path.join(this.repoPath, 'refs.bib'), 'utf-8'); } catch { /* none */ }
    const defined = new Set();
    let bm;
    const defRe = /@(\w+)\s*\{\s*([^,\s]+)/g;
    while ((bm = defRe.exec(bib)) !== null) {
      const type = bm[1].toLowerCase();
      if (type === 'string' || type === 'comment' || type === 'preamble') continue;
      defined.add(bm[2]);
    }
    return {
      undefined: [...cited].filter(k => !defined.has(k)).sort(),
      unused: [...defined].filter(k => !cited.has(k)).sort(),
      cited: cited.size,
      defined: defined.size,
    };
  }

  // Local rollback point: a lightweight tag mcp-snap/<label> at HEAD (not pushed).
  async checkpoint(label) {
    await this.requireLocal();
    const name = `mcp-snap/${(label && label.trim()) || `snap-${Date.now()}`}`;
    let exists = false;
    try { await this._git(['-C', this.repoPath, 'rev-parse', '--verify', '--quiet', `refs/tags/${name}`]); exists = true; } catch { exists = false; }
    if (exists) throw new Error(`snapshot "${name}" already exists; choose a different label.`);
    await this._git(['-C', this.repoPath, 'tag', name]);
    const { stdout } = await this._git(['-C', this.repoPath, 'rev-parse', 'HEAD']);
    return { label: name, head: stdout.trim() };
  }

  // Forward-restore the snapshot's tree as a new commit on top of HEAD, pushed
  // when push is true. No history rewrite, no force-push (the new commit
  // descends from HEAD). The fast-forward refuses rather than overwriting
  // uncommitted local edits to files the restore would change.
  async restore(label, { push = true } = {}) {
    const preHead = await this._prepareMutation(push);
    const name = String(label || '').startsWith('mcp-snap/') ? label : `mcp-snap/${label}`;
    let tree;
    try { ({ stdout: tree } = await this._git(['-C', this.repoPath, 'rev-parse', `${name}^{tree}`])); }
    catch {
      const tags = await this._git(['-C', this.repoPath, 'tag', '--list', 'mcp-snap/*']).then(r => r.stdout.trim()).catch(() => '');
      throw new Error(`snapshot "${name}" not found. Available: ${tags || '(none)'}`);
    }
    tree = tree.trim();
    const { stdout: commit } = await this._git(['-C', this.repoPath, 'commit-tree', tree, '-p', 'HEAD', '-m', `restore: ${name}`]);
    await this._git(['-C', this.repoPath, 'merge', '--ff-only', commit.trim()]);
    const res = await this._finishMutation(preHead, push, { refusal: 'restore: Overleaf moved during the rollback; refused. Run sync_project, then retry.' });
    return { ...res, label: name, restoredTo: tree };
  }

  // Run the configured voice linter on a file; advisory, read-only.
  // exit 0 -> clean; exit 2 -> findings (stderr); other -> error. command is
  // tokenized (no shell); a leading ~ in any token expands to the home dir.
  async voiceLint(filePath, { command } = {}) {
    if (!command || !command.trim()) {
      throw new Error('No voice linter configured. Set settings.voiceLinter in projects.json or the OVERLEAF_VOICE_LINTER env var (e.g. a command that takes a file path and exits non-zero on findings).');
    }
    // Lint the local working copy as-is: never pulls, no network. Advisory and
    // read-only, so it reflects on-disk state including edits not yet pushed. If
    // the clone is absent, say so rather than silently fetching.
    const abs = path.join(this.repoPath, filePath);
    if (!existsSync(abs)) {
      throw new Error(`voice_lint: ${filePath} not found in the local clone (${this.repoPath}). voice_lint reads the local working copy and never pulls; open the project once (list_files / read_file) to clone it, then lint.`);
    }
    const home = os.homedir();
    const parts = command.trim().split(/\s+/).map(t => (t.startsWith('~') ? home + t.slice(1) : t));
    const [prog, ...rest] = parts;
    try {
      const { stdout, stderr } = await execFile(prog, [...rest, abs], { maxBuffer: 4 * 1024 * 1024 });
      return { clean: true, findings: (stderr || stdout || '').trim() };
    } catch (e) {
      if (e.code === 2) return { clean: false, findings: (e.stderr || e.stdout || '').trim() };
      throw new Error(`voice linter failed (exit ${e.code}): ${(e.stderr || e.message || '').slice(0, 200)}`);
    }
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
  // let git 3-way merge it: clean merge -> push; real conflict -> abort, roll
  // back to preHead (the state before this operation's commit), and throw, so
  // nothing half-applied is left behind and earlier local commits survive.
  async _pushWithMerge(preHead) {
    if (!preHead) throw new Error('_pushWithMerge needs the pre-operation HEAD to roll back to.');
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
        await this._git(['-C', this.repoPath, 'reset', '--hard', preHead]);
        const e = new Error('conflict: the file changed on Overleaf in a way that overlaps this edit. Run sync_project, re-read the file and retry.');
        e.cause = mergeErr;
        throw e;
      }
      try {
        await this._git(['-C', this.repoPath, 'push', 'origin', 'HEAD'], { auth: true });
      } catch (e2) {
        await this._git(['-C', this.repoPath, 'reset', '--hard', preHead]).catch(() => {});
        const e = new Error('conflict: Overleaf moved again while merging; reset clean — re-read the file and retry.');
        e.cause = e2;
        throw e;
      }
      return { pushed: true, merged: true };
    }
  }

  // Full-file create / wholesale overwrite. New files: created freely. Existing
  // files: require either a matching baseSha (proves freshness) or overwrite:true
  // (a deliberate clobber). A stale baseSha is refused, never merged.
  async writeFile(filePath, content, opts = {}) {
    const { baseSha, overwrite = false, commitMessage, push = true } = opts;
    const preHead = await this._prepareMutation(push);
    const fullPath = path.join(this.repoPath, filePath);
    const current = await this.getBlobSha(filePath); // null if new

    if (current !== null) {
      if (baseSha != null) {
        if (baseSha !== current) {
          throw new Error(`${filePath} changed on Overleaf since baseSha ${String(baseSha).slice(0, 12)} (now ${current.slice(0, 12)}); the write is stale. Re-read and retry, or use edit_file for a surgical change.`);
        }
      } else if (!overwrite) {
        throw new Error(`${filePath} already exists. Pass baseSha (from read_file) to overwrite the version you read, set overwrite:true to force, or use edit_file for a surgical change.`);
      }
    }

    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, 'utf-8');
    await this._git(['-C', this.repoPath, 'add', '--', filePath]);
    if (!(await this._commit(commitMessage || `Update ${filePath} via Claude`))) return { pushed: false, reason: 'nothing to commit' };
    // write_file refuses on a push race rather than merging (conflict-refuse policy).
    return this._finishMutation(preHead, push, { refusal: `${filePath}: Overleaf moved while writing; refused to overwrite. Run sync_project, re-read and retry.` });
  }

  // Upload binary file(s) from local disk into the clone and push. Single mode:
  // {srcPath, destPath}. Batch mode: {files:[{srcPath, destPath}, ...]} -> one
  // commit for the set. The whole set is gated BEFORE any copy (all-or-nothing).
  // Binary never 3-way-merges, so a push race refuses + resets like writeFile.
  // baseSha freshness applies in single mode only; existing files in batch mode
  // require overwrite:true.
  async uploadFile({ srcPath, destPath, files, baseSha, overwrite = false, commitMessage, push = true } = {}) {
    let pairs;
    const batch = Array.isArray(files);
    if (batch) {
      if (srcPath || destPath) throw new Error('Pass either srcPath+destPath OR files[], not both.');
      if (!files.length) throw new Error('files[] is empty.');
      pairs = files.map(f => ({ src: f.srcPath, dest: f.destPath }));
    } else if (srcPath && destPath) {
      pairs = [{ src: srcPath, dest: destPath }];
    } else {
      throw new Error('upload_file needs srcPath+destPath (single) or files:[{srcPath,destPath}] (batch).');
    }

    const preHead = await this._prepareMutation(push);
    const repoAbs = path.resolve(this.repoPath);
    const resolved = [];
    for (const { src, dest } of pairs) {
      if (!src || !dest) throw new Error('each file needs srcPath and destPath.');
      try { const s = await stat(src); if (!s.isFile()) throw new Error('not a file'); }
      catch { throw new Error(`source file not found or unreadable: ${src}`); }
      const destAbs = path.resolve(repoAbs, dest);
      const rel = path.relative(repoAbs, destAbs);
      if (destAbs === repoAbs || rel.startsWith('..') || path.isAbsolute(rel) || rel.split(path.sep)[0] === '.git') {
        throw new Error(`destPath escapes the project or is not allowed: ${dest}`);
      }
      const current = await this.getBlobSha(rel);
      if (current !== null) {
        if (!batch && baseSha != null) {
          if (baseSha !== current) {
            throw new Error(`${rel} changed on Overleaf since baseSha ${String(baseSha).slice(0, 12)} (now ${current.slice(0, 12)}); stale. Re-read and retry.`);
          }
        } else if (!overwrite) {
          throw new Error(`${rel} already exists. Pass baseSha (single mode) or overwrite:true to replace it.`);
        }
      }
      resolved.push({ src, destAbs, rel });
    }

    for (const { src, destAbs } of resolved) {
      await mkdir(path.dirname(destAbs), { recursive: true });
      await copyFile(src, destAbs);
    }

    const rels = resolved.map(r => r.rel);
    await this._git(['-C', this.repoPath, 'add', '--', ...rels]);
    if (!(await this._commit(commitMessage || `Upload ${resolved.length} file(s) via Claude`))) {
      return { pushed: false, reason: 'nothing to commit (identical to repo)', files: rels };
    }
    const res = await this._finishMutation(preHead, push, { refusal: 'Overleaf moved while uploading; refused. Run sync_project and retry.' });
    return { ...res, files: rels };
  }

  // Anchored, conflict-safe edit. When pushing, pulls first (absorbing
  // non-overlapping Overleaf edits); local-only edits never touch the network.
  // A missing anchor means the region changed (overlap) or the string was
  // wrong -> refuse, nothing written.
  async editFile(filePath, oldString, newString, replaceAll = false, commitMessage, { push = true } = {}) {
    const preHead = await this._prepareMutation(push);
    const fullPath = path.join(this.repoPath, filePath);
    let content;
    try { content = await readFile(fullPath, 'utf-8'); }
    catch { throw new Error(`File not found in project: ${filePath}`); }

    const parts = content.split(oldString);
    const count = parts.length - 1;
    if (count === 0) {
      throw new Error(`oldString not found in ${filePath}. It may have changed on Overleaf since you read it (an overlapping edit) — re-read the file and retry.`);
    }
    if (count > 1 && !replaceAll) {
      throw new Error(`oldString matches ${count} times in ${filePath}; pass replaceAll: true or include more surrounding context to make it unique.`);
    }
    const updated = replaceAll ? parts.join(newString) : content.replace(oldString, () => newString);
    await writeFile(fullPath, updated, 'utf-8');
    await this._git(['-C', this.repoPath, 'add', '--', filePath]);
    if (!(await this._commit(commitMessage || `Edit ${filePath} via Claude`))) return { pushed: false, reason: 'no change (new === old)' };
    return this._finishMutation(preHead, push, { merge: true });
  }

  // Same slicing as the bundle (sectionText): runs to the next heading of the
  // same or higher level, covers \paragraph, and refuses an ambiguous title
  // rather than silently returning the first match.
  async getSectionContent(filePath, sectionTitle) {
    return sectionText(await this.readFile(filePath), sectionTitle);
  }
}

export { OverleafGitClient };

// settings.voiceLinter / $OVERLEAF_VOICE_LINTER override the bundled example
// linter, which ships with the package so voice_lint works out of the box. The
// example implements generic prose checks; point the setting at your own
// command to enforce a house style.
function voiceLinterCommand(config) {
  return config.settings?.voiceLinter
    || process.env.OVERLEAF_VOICE_LINTER
    || `node ${path.join(PACKAGE_DIR, 'examples', 'voice-lint.mjs')}`;
}

// What a mutating tool reports: pushed, or committed locally with the count of
// commits still waiting for publish_changes.
function mutationTail(res, what) {
  if (res.pushed) return `${what} and pushed to Overleaf${res.merged ? ' (auto-merged a concurrent Overleaf change)' : ''}.`;
  // The full hash is what publish_changes takes as revision; the workflow
  // itself lives in the tool descriptions, not in every reply.
  const n = res.unpublished == null ? '' : `, ${res.unpublished} unpublished`;
  return `${what}; committed locally at ${res.head}${n}.`;
}

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
    return { source: '(none)', body: `(No context set. Create ${path.relative(DATA_HOME,mdPath)} or call update_context to add notes for this project.)` };
  }
}

// MCP server
const server = new Server(
  { name: 'overleaf-forge', version: PKG_VERSION },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    ...[
      ['dependency_index', 'Local static TeX dependencies and affected sections. Dynamic macros are reported as unresolved.', { changedFiles: { type: 'array', items: { type: 'string' } }, changedSymbols: { type: 'array', items: { type: 'string' } } }, []],
      ['change_report', 'Compact local file and section changes against an in-process baseline. Omit baselineVersion to establish one.', { baselineVersion: { type: 'string' } }, []],
      ['render_pages', 'Render explicitly selected PDF pages to cached local PNG paths. Pages are one-based; no sync or build.', { filePath: { type: 'string' }, pages: { type: 'array', items: { type: 'integer', minimum: 1 }, minItems: 1, maxItems: 20 }, dpi: { type: 'integer', minimum: 36, maximum: 300 } }, ['filePath', 'pages']],
      ['usage_stats', 'In-process tool counts, durations, response bytes and cache hits. Stores no document content. Bytes are not billed tokens.', { reset: { type: 'boolean' } }, []],
      ['apply_changes', 'Verify a UTF-8 multi-file batch in an isolated worktree, then commit it locally. Requires clean tracked source, HEAD baseRevision and SHA-256 baseHash per file (null for new files). No push.', { baseRevision: { type: 'string' }, changes: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object', properties: { filePath: { type: 'string' }, baseHash: { type: ['string', 'null'] }, content: { type: 'string' } }, required: ['filePath', 'baseHash', 'content'] } }, filePath: { type: 'string' }, engine: { type: 'string' }, controlled: { type: 'boolean' }, externalInputs: { type: 'array', items: { type: 'string' } }, lint: { anyOf: [{ type: 'boolean' }, { type: 'array', items: { type: 'string' } }] } }, ['baseRevision', 'changes', 'filePath']],
      ['publish_changes', 'Verify the clean local HEAD and push every unpublished commit once. revision must equal HEAD. Reuses this session\'s verify_build PASS when no project file changed since; force rebuilds. No pull, merge or retry: if Overleaf moved, sync_project first. Needs publishing authorization.', { revision: { type: 'string' }, force: { type: 'boolean' }, filePath: { type: 'string' }, engine: { type: 'string' }, controlled: { type: 'boolean' }, externalInputs: { type: 'array', items: { type: 'string' } }, lint: { anyOf: [{ type: 'boolean' }, { type: 'array', items: { type: 'string' } }] } }, ['revision', 'filePath']],
    ].map(([name, description, properties, required]) => ({ name, description, inputSchema: { type: 'object', properties: { projectName: { type: 'string' }, ...properties }, required } })),
    {
      name: 'get_context',
      description: 'Read current writing and project context. Supply previousVersion to receive a compact unchanged response when content and project identity match.',
      inputSchema: {
        type: 'object',
        properties: {
          previousVersion: { type: 'string', description: 'Version returned by the previous context read.' },
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
      name: 'configure',
      description: 'Set up or update overleaf-forge\'s global settings: the scaffold templates directory, the voice_lint command, the edit push policy (autoPush), and the recurring-work settings bootstrap_ssa uses (academic root, SSA subdir, default clone dir). FIRST call this with NO arguments to see the current settings and which are unset, with a question for each; ask the user those questions in turn; THEN call it again with their answers to write them to projects.json. Omit a field to leave it unchanged; pass an empty string to clear it back to the bundled default. The git token is redacted in all output. Intended right after install to configure the server conversationally.',
      inputSchema: {
        type: 'object',
        properties: {
          repoDir: { type: 'string', description: 'Default clone location; clones go to repoDir/<name>. Absolute path (a leading ~ is expanded).' },
          academicRoot: { type: 'string', description: 'Root folder bootstrap_ssa searches: academicRoot/Year <n>/Q*/<COURSE>*. Absolute path (~ expanded).' },
          ssaSubdir: { type: 'string', description: 'Subfolder name created under each course folder for new SSAs, e.g. "MY SSAs".' },
          templatesDir: { type: 'string', description: 'Directory of your scaffold templates (main.tex, context-scaffold.md), overriding the bundled examples. ~ expanded. Empty string reverts to bundled.' },
          voiceLinter: { type: 'string', description: 'Prose-linter command for voice_lint (takes a file path, exits non-zero on findings), overriding the bundled example. Empty string reverts to bundled.' },
          autoPush: { type: 'boolean', description: 'true: edit tools push immediately. false (default): they commit locally and publish_changes sends the verified batch.' },
          gitToken: { type: 'string', description: 'Overleaf git token. Prefer the OVERLEAF_GIT_TOKEN env var; set here only to store it in projects.json.' },
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
      name: 'sync_project',
      description: 'Fetch Overleaf. Fast-forwards when behind; reports unpublished commits when ahead. On divergence it changes nothing and reports both sides unless strategy is "rebase" (aborts cleanly on conflict) or "reset" (needs confirm = the reported head; tags mcp-backup/* first). Clones a missing project.',
      inputSchema: { type: 'object', properties: {
        strategy: { type: 'string', enum: ['rebase', 'reset'], description: 'Only for a diverged clone. Omit to get the report first.' },
        confirm: { type: 'string', description: 'For strategy "reset": the full local head SHA from the report.' },
        projectName: { type: 'string' },
      } },
    },
    {
      name: 'get_section_content',
      description: 'Read one section (\\section to \\paragraph) by exact title from the local clone; no pull. The title must be unique in the file. bundle:true also returns the equation/figure blocks it references, matching bibliography entries and asset paths as JSON, reporting unresolved references and truncation (not a recursive TeX parser).',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: { type: 'string' },
          sectionTitle: { type: 'string' },
          bundle: { type: 'boolean', default: false, description: 'Include referenced blocks, bibliography entries and assets.' },
          maxChars: { type: 'integer', minimum: 2000, maximum: 64000, description: 'bundle only: response budget (default 16000).' },
          projectName: { type: 'string' },
        },
        required: ['filePath', 'sectionTitle'],
      },
    },
    {
      name: 'verify_build',
      description: 'Build the entrypoint and return PASS/FAIL. PASS needs a PDF, zero LaTeX errors and zero undefined references and citations (and zero findings with lint); box warnings do not fail. Default: clean from-scratch final gate, reusing an unchanged eligible PASS unless force. clean:false: quick incremental rebuild for intermediate checks. Local only.',
      inputSchema: {
        type: 'object',
        properties: {
          clean: { type: 'boolean', default: true, description: 'false = quick incremental rebuild that always recompiles (intermediate checks); true = from-scratch final gate.' },
          lint: { description: 'Also run the voice linter as part of the gate: true for every .tex file, or an array of paths. Findings fail the verdict.', anyOf: [{ type: 'boolean' }, { type: 'array', items: { type: 'string' } }] },
          controlled: { type: 'boolean', default: false, description: 'Ignore all latexmk rc files and disable shell escape. Opt in only when the project supports this mode.' },
          externalInputs: { type: 'array', items: { type: 'string' }, description: 'Absolute paths of additional build inputs to hash.' },
          verbose: { type: 'boolean', default: false, description: 'Include a bounded log tail; full log remains on disk.' },
          force: { type: 'boolean', default: false, description: 'Ignore a cached verification and rebuild.' },
          filePath: { type: 'string', description: 'The entrypoint, usually main.tex.' },
          engine: { type: 'string', description: 'pdflatex | xelatex | lualatex (default lualatex).' },
          projectName: { type: 'string' },
        },
        required: ['filePath'],
      },
    },
    {
      name: 'edit_file',
      description: 'Anchored edit: replace oldString (must match once unless replaceAll) with newString and commit. A missing anchor means the region changed, so the edit refuses instead of clobbering it. Prefer over write_file for existing files. Commits locally unless push.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: { type: 'string' },
          oldString: { type: 'string', description: 'Exact text to replace. Include enough surrounding context to be unique.' },
          newString: { type: 'string', description: 'Replacement text.' },
          replaceAll: { type: 'boolean', description: 'Replace every occurrence (default false; otherwise oldString must be unique).' },
          commitMessage: { type: 'string' },
          push: { type: 'boolean', description: 'Push now. Default settings.autoPush; false keeps a local commit for publish_changes.' },
          projectName: { type: 'string' },
        },
        required: ['filePath', 'oldString', 'newString'],
      },
    },
    {
      name: 'write_file',
      description: 'Create a file or replace one wholesale, and commit. Replacing needs baseSha from read_file (a stale one is refused) or overwrite:true. Prefer edit_file for changes. Commits locally unless push.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: { type: 'string' },
          content: { type: 'string' },
          baseSha: { type: 'string', description: 'The baseSha from read_file for this file. Required to overwrite an existing file safely; if Overleaf moved since, the write is refused.' },
          overwrite: { type: 'boolean', description: 'Force-overwrite an existing file without a baseSha (deliberate full replacement). Ignored for new files.' },
          commitMessage: { type: 'string' },
          push: { type: 'boolean', description: 'Push now. Default settings.autoPush; false keeps a local commit for publish_changes.' },
          projectName: { type: 'string' },
        },
        required: ['filePath', 'content'],
      },
    },
    {
      name: 'upload_file',
      description: 'Copy binary file(s) such as figures from a local path into the project and commit. Single: srcPath + destPath; batch: files[] in one commit. Existing destinations need baseSha (single) or overwrite:true. Commits locally unless push.',
      inputSchema: {
        type: 'object',
        properties: {
          srcPath: { type: 'string', description: 'Absolute local path of the file to upload (single mode).' },
          destPath: { type: 'string', description: 'Path inside the Overleaf project, e.g. figures/fig1.png (single mode).' },
          files: {
            type: 'array',
            description: 'Batch mode: list of {srcPath, destPath}. One commit + push for the whole set. baseSha is ignored in batch mode.',
            items: { type: 'object', properties: { srcPath: { type: 'string' }, destPath: { type: 'string' } }, required: ['srcPath', 'destPath'] },
          },
          baseSha: { type: 'string', description: 'Single-file mode only: baseSha from read_file; a stale value is refused. Ignored in batch.' },
          overwrite: { type: 'boolean', description: 'Replace existing dest file(s). Required to overwrite in batch mode.' },
          commitMessage: { type: 'string' },
          push: { type: 'boolean', description: 'Push now. Default settings.autoPush; false keeps a local commit for publish_changes.' },
          projectName: { type: 'string' },
        },
      },
    },
    {
      name: 'search_text',
      description: 'Grep across the project\'s tracked files (find a \\label, a duplicate key, every \\autoref, etc.). Read-only. Regex by default; fixed:true for a literal string; ignoreCase:true for -i; extension (e.g. ".tex") restricts the file set. Returns file:line:match.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Pattern (POSIX extended regex unless fixed:true).' },
          fixed: { type: 'boolean', description: 'Treat query as a literal string (-F).' },
          ignoreCase: { type: 'boolean', description: 'Case-insensitive (-i).' },
          extension: { type: 'string', description: 'Restrict to files with this extension, e.g. ".tex".' },
          projectName: { type: 'string' },
        },
        required: ['query'],
      },
    },
    {
      name: 'add_citation',
      description: 'Append a BibTeX entry (raw @type{key, ...} string) to refs.bib and commit (local by default; see push). Refuses if the key already exists. Creates refs.bib if absent.',
      inputSchema: {
        type: 'object',
        properties: {
          entry: { type: 'string', description: 'A complete BibTeX entry, e.g. @article{key, title={...}, ...}.' },
          commitMessage: { type: 'string' },
          push: { type: 'boolean', description: 'Push now. Default settings.autoPush; false keeps a local commit for publish_changes.' },
          projectName: { type: 'string' },
        },
        required: ['entry'],
      },
    },
    {
      name: 'cite_lint',
      description: 'Report citation problems: undefined (\\cite keys with no refs.bib entry) and unused (refs.bib entries never cited). Read-only. Run before verify_build to catch undefined citations early.',
      inputSchema: { type: 'object', properties: { projectName: { type: 'string' } } },
    },
    {
      name: 'checkpoint',
      description: 'Mark a local rollback point (a git tag mcp-snap/<label>) at the current state before a risky edit. label defaults to a timestamp. Local only (not pushed). Use restore to roll back.',
      inputSchema: { type: 'object', properties: { label: { type: 'string' }, projectName: { type: 'string' } } },
    },
    {
      name: 'restore',
      description: 'Roll back to a checkpoint: re-applies the snapshot\'s file tree as a NEW commit on top of history (no force-push, no history rewrite); intervening commits are preserved. Local by default; see push.',
      inputSchema: { type: 'object', properties: { label: { type: 'string' }, push: { type: 'boolean', description: 'Push now. Default settings.autoPush; false keeps a local commit for publish_changes.' }, projectName: { type: 'string' } }, required: ['label'] },
    },
    {
      name: 'voice_lint',
      description: 'Run the prose linter (settings.voiceLinter, else the bundled example) on a local .tex file; never pulls. Advisory on its own; verify_build with lint makes findings fail the gate.',
      inputSchema: {
        type: 'object',
        properties: { filePath: { type: 'string' }, projectName: { type: 'string' } },
        required: ['filePath'],
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

server.setRequestHandler(CallToolRequestSchema, async (request) => observeTool(request.params.name, async () => {
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

        // Scaffold context md from the (user-configurable) context-scaffold
        // template, falling back to the built-in default if none is provided.
        await mkdir(CONTEXTS_DIR, { recursive: true });
        const ctxPath = path.join(CONTEXTS_DIR, `${parsed.slug}.md`);
        const ctxTemplate = await loadTemplate(config, 'context-scaffold.md');
        const scaffold = (ctxTemplate != null ? ctxTemplate : DEFAULT_CONTEXT_SCAFFOLD)
          .replaceAll('__SSA_NAME__', args.ssaName.trim());
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
          `**Context md:** ${path.relative(DATA_HOME,ctxPath)}`,
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

      case 'configure': {
        const config = await loadConfig();
        config.settings = config.settings || {};
        const redact = (s) => { const r = { ...s }; if (r.gitToken) r.gitToken = '(set)'; return r; };
        const { settings, provided } = mergeSettings(config.settings, args, os.homedir());

        if (provided.length === 0) {
          // Report mode: show current state and the questions for what is unset.
          const unset = SETTING_KEYS.filter(k => config.settings[k] === undefined || config.settings[k] === '');
          const lines = [
            '# overleaf-forge configuration',
            '',
            'Current settings:',
            '```json',
            JSON.stringify(redact(config.settings), null, 2),
            '```',
            '',
            unset.length
              ? 'Not set yet. Ask the user each of these, then call configure again with their answers (omit any they want to skip):'
              : 'All settings are set. Pass any field to update it (empty string reverts a template/linter to the bundled default).',
            ...unset.map((k, i) => `${i + 1}. **${k}** — ${SETTING_HELP[k]}`),
          ];
          return { content: [{ type: 'text', text: lines.join('\n') }] };
        }

        // Apply mode: persist the provided settings.
        config.settings = settings;
        await saveConfig(config);
        return { content: [{ type: 'text', text: `Updated: ${provided.join(', ')}.\n\`\`\`json\n${JSON.stringify(redact(config.settings), null, 2)}\n\`\`\`\nTakes effect on the next call (projects.json is re-read each time).` }] };
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
          await writeFile(ctxPath, `# ${entry.name}\n\n(Context placeholder. Call update_context to fill this in, or edit ${path.relative(DATA_HOME,ctxPath)} directly.)\n`, 'utf-8');
        }
        return { content: [{ type: 'text', text: `Registered "${args.key}" → ${args.projectId}\ncwd: ${entry.cwd || '(none)'}\nlocalPath: ${resolveLocalPath(config, args.key, entry)}\ncontext: ${path.relative(DATA_HOME,ctxPath)}` }] };
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
        return { content: [{ type: 'text', text: `Wrote context for "${key}" → ${path.relative(DATA_HOME,ctxPath)} (${mode})` }] };
      }

      case 'get_context': {
        const config = await loadConfig();
        const key = pickProjectKey(config, args.projectName);
        const project = config.projects[key];
        let guidelines = '';
        const guidelinesPath = resolveGuidelinesPath({ dataHome: DATA_HOME, packageDir: PACKAGE_DIR, exists: existsSync });
        try { guidelines = await readFile(guidelinesPath, 'utf-8'); }
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
        const v = versionedContext(key,text,args.previousVersion);
        return { content: [{ type: 'text', text: `Context version: ${v.version}\n${v.text}` }], structuredContent: { version:v.version, unchanged:v.unchanged, projectName:key } };
      }

      case 'list_files': {
        const { client } = await getClient(args.projectName);
        const files = await client.listFiles(args.extension || '.tex');
        return { content: [{ type: 'text', text: files.join('\n') }] };
      }

      case 'read_file': {
        const { client } = await getClient(args.projectName);
        const content = await client.readFile(args.filePath);
        const baseSha = await client.getBlobSha(args.filePath, { pull: false });
        const header = `<!-- overleaf-mcp baseSha: ${baseSha || 'none'} (pass as baseSha to write_file to guard against clobbering Overleaf edits) -->\n`;
        const { stdout } = await client._git(['-C', client.repoPath, 'rev-parse', 'HEAD']);
        return { content: [{ type: 'text', text: header + content }], structuredContent: { baseSha, baseRevision: stdout.trim(), contentHash: createHash('sha256').update(content).digest('hex') } };
      }

      case 'get_sections': {
        const { client } = await getClient(args.projectName);
        const sections = await client.getSections(args.filePath);
        return { content: [{ type: 'text', text: JSON.stringify(sections, null, 2) }] };
      }

      case 'get_section_content': {
        const { client } = await getClient(args.projectName);
        if (args.bundle) {
          await client.requireLocal();
          const result = await sectionBundle(client.repoPath, args.filePath, args.sectionTitle, args.maxChars);
          return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
        }
        const content = await client.getSectionContent(args.filePath, args.sectionTitle);
        return { content: [{ type: 'text', text: content }] };
      }

      case 'sync_project': {
        const { client } = await getClient(args.projectName);
        const result = await client.syncProject({ strategy: args.strategy, confirm: args.confirm });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result };
      }
      case 'usage_stats': {
        const result = usageStats(args);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
      }
      case 'dependency_index':
      case 'change_report':
      case 'render_pages': {
        const { client } = await getClient(args.projectName);
        await client.requireLocal();
        const result = name === 'dependency_index' ? await dependencyIndex(client.repoPath, args)
          : name === 'change_report' ? await changeReport(client.repoPath, args.baselineVersion)
          : await renderPages(client.repoPath, args);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
      }
      case 'apply_changes':
      case 'publish_changes': {
        const config = await loadConfig();
        const { client } = await getClient(args.projectName);
        await client.requireLocal();
        const verify = async root => {
          const candidate = new OverleafGitClient(client.projectId, client.gitToken, root);
          return candidate.verifyBuild(args.filePath, args.engine || 'lualatex', {
            controlled: args.controlled === true,
            externalInputs: args.externalInputs,
            lint: args.lint,
            lintCommand: voiceLinterCommand(config),
            reuseRecentPass: name === 'publish_changes' && args.force !== true,
          });
        };
        const result = name === 'apply_changes' ? await applyChanges(client.repoPath, args, verify)
          : await publishChanges(client.repoPath, args, verify, async (root, revision, branch) => {
            try {
              await client._git(['-C', root, 'push', 'origin', `${revision}:refs/heads/${branch}`], { auth: true });
            } catch (e) {
              // A rejected push means Overleaf moved since the last sync; name
              // the recovery instead of surfacing raw git plumbing.
              if (/rejected|fetch first|non-fast-forward/i.test(e.stderr || '')) {
                throw new Error('Overleaf has commits this clone lacks, so the push was refused and nothing was published. Run sync_project to see both sides, resolve with strategy "rebase", verify again, then publish the new HEAD.');
              }
              throw e;
            }
          });
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
      }
      case 'verify_build': {
        const config = await loadConfig();
        const { client } = await getClient(args.projectName);
        const opts = { ...args, lintCommand: voiceLinterCommand(config) };
        const v = args.clean === false
          ? await client.compileFile(args.filePath, args.engine || 'lualatex', opts)
          : await client.verifyBuild(args.filePath, args.engine || 'lualatex', opts);
        // A PASS already means zero errors and zero undefined references and
        // citations, so only box warnings and reuse are worth reporting. A FAIL
        // carries the counts, the first offenders and where the full log is.
        const boxes = v.overfullCount || v.underfullCount ? `; ${v.overfullCount} overfull / ${v.underfullCount} underfull boxes` : '';
        const parts = v.pass
          ? [`PASS: ${v.pageCount ?? '?'} pages${boxes}${v.reused ? ' (reused unchanged verification)' : ''}.`]
          : [`FAIL: ${v.pageCount ?? '?'} pages; ${v.errors.length} errors; ${v.undefinedRefs.length} undefined references; ${v.undefinedCitations.length} undefined citations${boxes}. Log: ${path.relative(client.repoPath, v.logPath)}`,
            ...v.errors.slice(0,5),...v.undefinedRefs.slice(0,5),...v.undefinedCitations.slice(0,5)];
        if (v.lint) parts.push(v.lint.clean ? `Voice lint: clean (${v.lint.results.length} file(s)).` : `Voice lint findings:\n${v.lint.results.filter(r => !r.clean).map(r => `${r.file}:\n${r.findings}`).join('\n')}`);
        if (args.verbose) parts.push(v.tail);
        return { content:[{type:'text',text:parts.join('\n')}], structuredContent: { pass: v.pass, pageCount: v.pageCount, reused: v.reused, cacheEligible: v.cacheEligible, errors: v.errors.slice(0,5), logPath: v.logPath, lintClean: v.lint ? v.lint.clean : null } };
      }

      case 'edit_file': {
        const config = await loadConfig();
        const { client } = await getClient(args.projectName);
        const res = await client.editFile(args.filePath, args.oldString, args.newString, args.replaceAll || false, args.commitMessage, { push: resolvePush(config.settings, args) });
        const tail = res.reason
          ? `No change applied to ${args.filePath} (${res.reason}).`
          : mutationTail(res, `Edited ${args.filePath}`);
        return { content: [{ type: 'text', text: tail }] };
      }

      case 'write_file': {
        const config = await loadConfig();
        const { client } = await getClient(args.projectName);
        const res = await client.writeFile(args.filePath, args.content, {
          baseSha: args.baseSha,
          overwrite: args.overwrite,
          commitMessage: args.commitMessage,
          push: resolvePush(config.settings, args),
        });
        const tail = res.reason
          ? `No change detected for ${args.filePath} (${res.reason}).`
          : mutationTail(res, `Wrote ${args.filePath}`);
        return { content: [{ type: 'text', text: tail }] };
      }

      case 'upload_file': {
        const config = await loadConfig();
        const { client } = await getClient(args.projectName);
        const res = await client.uploadFile({
          push: resolvePush(config.settings, args),
          srcPath: args.srcPath,
          destPath: args.destPath,
          files: args.files,
          baseSha: args.baseSha,
          overwrite: args.overwrite,
          commitMessage: args.commitMessage,
        });
        const tail = res.reason
          ? `No upload performed (${res.reason}).`
          : `${mutationTail(res, `Uploaded ${res.files.length} file(s): ${res.files.join(', ')}`)} Reference each figure with \\includegraphics{...} via edit_file.`;
        return { content: [{ type: 'text', text: tail }] };
      }

      case 'search_text': {
        const { client } = await getClient(args.projectName);
        const r = await client.searchText({ query: args.query, fixed: args.fixed, ignoreCase: args.ignoreCase, extension: args.extension });
        if (!r.total) return { content: [{ type: 'text', text: `No matches for ${JSON.stringify(args.query)}.` }] };
        const more = r.total > r.matches.length ? `\n… (+${r.total - r.matches.length} more)` : '';
        return { content: [{ type: 'text', text: `${r.total} match(es):\n${r.matches.join('\n')}${more}` }] };
      }

      case 'add_citation': {
        const config = await loadConfig();
        const { client } = await getClient(args.projectName);
        const res = await client.addCitation({ entry: args.entry, commitMessage: args.commitMessage, push: resolvePush(config.settings, args) });
        return { content: [{ type: 'text', text: res.reason ? `No change for "${res.key}" (${res.reason}).` : mutationTail(res, `Added citation "${res.key}" to refs.bib`) }] };
      }

      case 'cite_lint': {
        const { client } = await getClient(args.projectName);
        const r = await client.citeLint();
        const parts = [`Citations: ${r.cited} cited, ${r.defined} defined.`];
        parts.push(r.undefined.length ? `✗ undefined (${r.undefined.length}): ${r.undefined.join(', ')}` : '✓ no undefined citations');
        parts.push(r.unused.length ? `unused (${r.unused.length}): ${r.unused.join(', ')}` : '✓ no unused entries');
        return { content: [{ type: 'text', text: parts.join('\n') }] };
      }

      case 'checkpoint': {
        const { client } = await getClient(args.projectName);
        const r = await client.checkpoint(args.label);
        return { content: [{ type: 'text', text: `Checkpoint "${r.label}" at ${r.head.slice(0, 12)}. Roll back with restore("${r.label.replace('mcp-snap/', '')}").` }] };
      }

      case 'restore': {
        const config = await loadConfig();
        const { client } = await getClient(args.projectName);
        const r = await client.restore(args.label, { push: resolvePush(config.settings, args) });
        return { content: [{ type: 'text', text: `${mutationTail(r, `Restored "${r.label}" as a forward commit`)} Run verify_build to confirm.` }] };
      }

      case 'voice_lint': {
        const config = await loadConfig();
        const { client } = await getClient(args.projectName);
        const r = await client.voiceLint(args.filePath, { command: voiceLinterCommand(config) });
        return { content: [{ type: 'text', text: r.clean ? `✓ voice OK — ${args.filePath}${r.findings ? `\n${r.findings}` : ''}` : `voice findings in ${args.filePath}:\n${r.findings}` }] };
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
    return toolError(error);
  }
})());

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`overleaf-forge running on stdio (session cwd: ${SESSION_CWD})`);
}

// `overleaf-forge init`: scaffold the writable data home so a fresh install
// has a projects.json to edit and an editable copy of the bundled templates.
// Safe to re-run: never overwrites an existing config or template.
async function runInit() {
  await mkdir(DATA_HOME, { recursive: true });
  await mkdir(CONTEXTS_DIR, { recursive: true });

  if (existsSync(CONFIG_PATH)) {
    console.log(`Config already present: ${CONFIG_PATH} (left untouched)`);
  } else {
    let body = '{\n  "settings": {},\n  "projects": {}\n}\n';
    try { body = await readFile(path.join(PACKAGE_DIR, 'projects.example.json'), 'utf-8'); } catch {}
    await writeFile(CONFIG_PATH, body, 'utf-8');
    console.log(`Created ${CONFIG_PATH}`);
  }

  // Copy bundled templates the user hasn't already customised, so the scaffolds
  // are editable in place under the data home.
  const userTemplates = path.join(DATA_HOME, 'templates');
  await mkdir(userTemplates, { recursive: true });
  let bundled = [];
  try { bundled = await readdir(BUNDLED_TEMPLATES_DIR); } catch {}
  for (const name of bundled) {
    const dest = path.join(userTemplates, name);
    if (existsSync(dest)) continue;
    try { await copyFile(path.join(BUNDLED_TEMPLATES_DIR, name), dest); console.log(`Copied template ${name}`); } catch {}
  }

  console.log(`\nData home: ${DATA_HOME}`);
  console.log('Next: put your Overleaf git token and project id in projects.json,');
  console.log('or skip the file and pass OVERLEAF_GIT_TOKEN + OVERLEAF_PROJECT_ID as env vars in your MCP client config.');
}

// True when this file is the entry point. Both sides are realpath'd because npm
// installs the bin as a symlink (how `npx` runs it): Node resolves import.meta.url
// to the real target but leaves argv[1] as the symlink, so a raw string compare
// would wrongly read as "imported" and never start the server.
function isMainModule() {
  try {
    return Boolean(process.argv[1])
      && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch { return false; }
}

// Run directly (not imported by tests): dispatch the optional subcommand, else
// start the stdio server.
if (isMainModule()) {
  const onError = (error) => { console.error('Fatal error:', error); process.exit(1); };
  if (process.argv[2] === 'init') {
    runInit().catch(onError);
  } else {
    main().catch(onError);
  }
}
