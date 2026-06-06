# overleaf-forge

[![npm](https://img.shields.io/npm/v/overleaf-forge.svg)](https://www.npmjs.com/package/overleaf-forge) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](#license) ![Node](https://img.shields.io/badge/node-%E2%89%A518-43853d.svg)

A [Model Context Protocol](https://modelcontextprotocol.io) server that lets an AI assistant (Claude Code, Claude Desktop, or any MCP client) read, edit, compile, and verify an [Overleaf](https://www.overleaf.com) project over Overleaf's built-in **git** integration. The model edits a local clone with surgical, conflict-safe operations and pushes to Overleaf; nothing depends on scraping the web UI.

> **Acknowledgement.** Forked from [mjyoo2/OverleafMCP](https://github.com/mjyoo2/OverleafMCP), the original Overleaf MCP server. This fork adds conflict-safe editing, binary/figure upload, a clean-build PASS/FAIL gate, citation and voice linting, snapshots, a bootstrap for recurring structured documents, per-project contexts, and a hardened git layer (no-shell `execFile`, credential-helper auth, error redaction).

## Why

Editing a LaTeX project through an AI normally means one of two bad options: paste files back and forth by hand, or let the model overwrite whole files and hope it didn't clobber an edit you made in the browser. This server removes both. It treats Overleaf's git remote as the source of truth and gives the model **anchored edits** (replace an exact string, refuse if it moved), a **conflict gate** (a stale or concurrent change is detected, never silently overwritten), and a **build verdict** (compile from scratch, PASS only on zero errors and zero undefined references), so an editing session is safe to run unattended and provable when it's done.

## Token economy

Safety is one motivation; keeping a large document out of the model's context window is the other, and it drove most of the tool design. A 50 KB chapter is about 12K to 13K tokens, so the cost of a naive workflow is dominated by moving that whole file in and out.

Rough token cost per operation on such a chapter, and the cut each tool buys:

| Operation (on a ~50 KB chapter) | Whole-file workflow | overleaf-forge | Reduction |
| --- | --- | --- | --- |
| One surgical edit | ~25K (read + write the file) | ~0.15K (`edit_file`) | ~99% |
| A dozen edits (one revision pass) | ~170K | ~3K | ~98% |
| One compile check | ~1.5K (raw `latexmk` log) | ~0.02K (`verify_build` verdict) | ~99% |
| Locating a passage | ~13K (read the whole file) | ~2K (`get_section_content` / `search_text`) | ~85% |

Figures are order-of-magnitude, for a chapter this size; the absolute numbers scale with file size, the percentages roughly hold.

- **Anchored edits instead of whole-file rewrites.** Changing one phrase by reading the whole file and writing it back costs roughly 25K tokens per edit: the file into context, then the file back out as the write payload. `edit_file` sends only the old and new strings and returns a one-line confirmation, on the order of 100 tokens. Across a dozen edits to a single chapter that is the difference between roughly 170K tokens and 3K.
- **A one-line build verdict instead of a raw log.** `verify_build` returns `✓ PASS — 24 pages` rather than the `latexmk` output. A raw log runs to hundreds or thousands of tokens per compile, and a multi-pass log buries the true final state under transient undefined-reference warnings from early passes (the exact trap `verify_build` classifies away by reading the final log). Over a session of repeated compiles that is a few thousand tokens against a few dozen.
- **Section and grep reads instead of the whole file.** `get_section_content` returns one section and `search_text` returns the matching lines, so locating something costs 1K to 3K tokens rather than the full 13K.

For an iterative edit, build, and review loop on a large document the tool traffic runs about an order of magnitude lighter than a read-and-rewrite-the-whole-file approach. The gain is workflow-dependent: a single full-file rewrite is a wash, since `write_file` moves the same bytes either way. It is the repeated, surgical work that compounds, which is exactly the shape of writing and revising a paper.

## Features

- **Surgical, conflict-safe edits**: `edit_file` replaces an exact anchor and refuses if the region changed on Overleaf; non-overlapping concurrent edits auto-merge via git.
- **No silent clobbering**: full-file `write_file` requires a freshness token (`baseSha`) or an explicit `overwrite` to replace an existing file.
- **Binary / figure upload**: push PNG/PDF figures from disk (single or a whole set in one commit), byte-exact, path-confined to the project.
- **Build verification**: `verify_build` compiles from scratch with `latexmk` and returns PASS/FAIL on the real "done" bar (a PDF, zero errors, zero undefined references/citations) with the page count.
- **Citation tooling**: append BibTeX entries with duplicate-key protection; lint for undefined and unused citations.
- **Section-aware reading**: list sections and pull a single section's body by title.
- **Project grep**: `search_text` over tracked files.
- **Snapshots**: `checkpoint` a rollback point before a risky edit; `restore` it as a forward commit (no force-push, no history rewrite).
- **Recurring-document bootstrap**: one call to clone, register, and scaffold a new instance of a structured document (see [Bootstrap](#bootstrap-for-recurring-structured-documents)).
- **Per-project context**: durable notes and writing guidelines surfaced to the model at the start of a session.
- **Hardened git layer**: every subprocess runs through `execFile` (no shell), the token is supplied via an environment-backed credential helper and never appears in a command or an error, and tokenized URLs are redacted from any error returned.

## Requirements

- Node.js ≥ 18 (ESM).
- `git` on `PATH`.
- A LaTeX distribution with `latexmk` (only for `compile_file` / `verify_build`; the rest works without it). The default engine is LuaLaTeX; `latexmk` is expected at `/Library/TeX/texbin` (MacTeX) or otherwise on `PATH`.
- An Overleaf account with **Git integration** enabled (a paid feature at time of writing).

## Install

**Recommended: npx.** Nothing to clone, nothing to keep updated by hand. The whole install is a few lines of JSON in your MCP client, plus two values from Overleaf.

1. Get your two values: an Overleaf **git token** (Account Settings → Git Integration → create token) and your **project id** (the `<ID>` in `https://www.overleaf.com/project/<ID>`).
2. Add this block to your client's config file (locations in the table below):

```json
{
  "mcpServers": {
    "overleaf": {
      "command": "npx",
      "args": ["-y", "overleaf-forge@latest"],
      "env": {
        "OVERLEAF_GIT_TOKEN": "olp_xxxxxxxxxxxxxxxxxxxxxxxx",
        "OVERLEAF_PROJECT_ID": "0123456789abcdef01234567"
      }
    }
  }
}
```

3. Restart the client (or reload its MCP servers). That's it.

`npx` fetches and runs the published package on demand. The token and project id are the entire setup for a single project, with no config file (this is **env-only mode**). `@latest` means each client restart picks up the newest published version automatically; pin `overleaf-forge@2.7.1` instead to freeze a version. For multiple projects, per-project contexts, or the SSA bootstrap, see [Configuration](#configuration).

An MCP server is not an app you launch yourself: the client starts it as a subprocess, so "installing" it just means making its command available to the client. The `npx` form above needs no install step. If you would rather have a real command on your `PATH`, install it globally:

```bash
npm install -g overleaf-forge
```

and set `"command": "overleaf-forge"` with no `args` (keep the same `env` block). A global install does not auto-update: refresh it yourself with `npm update -g overleaf-forge`. `npx` is recommended precisely because it skips that step.

To hack on the server instead, run it from source:

```bash
git clone https://github.com/nomanfoundhere/overleaf-mcp.git
cd overleaf-mcp
npm install
```

Then use `"command": "node", "args": ["/absolute/path/to/overleaf-mcp-server.js"]` in the client config in place of the `npx` form.

### Wiring into specific clients

The `mcpServers` schema is identical across clients; only the file location differs. Put the `npx` block above inside each.

| Client | Config file |
| --- | --- |
| Claude Code | `~/.claude.json` |
| Claude Desktop | `claude_desktop_config.json` (Settings → Developer → Edit Config) |
| LM Studio | `~/.lmstudio/mcp.json` (or the app's *Edit mcp.json*) |
| Cursor and others on the Cursor `mcp.json` convention | their `mcp.json` |

Restart the client (or reload its MCP servers) after editing, so it spawns the server with the new config.

## Updating

**As a user.** With `overleaf-forge@latest` in your config (the recommended form), restart the client or reload its MCP servers and it fetches the newest published version. If you pinned a version (`overleaf-forge@2.7.1`), change the number. If `npx` seems to keep running an old version, clear its cache with `npx clear-npx-cache` and restart. If you installed globally instead, update with `npm update -g overleaf-forge`.

**As the maintainer (publishing a new release).** From the repository:

```bash
npm version patch        # or minor / major; bumps package.json and tags
npm publish              # enter your npm 2FA one-time code when prompted
git push --follow-tags   # push the commit and the version tag
```

Anyone on `@latest` picks the new version up on their next client restart.

## Configuration

Two modes, smallest first.

### Env-only mode (one project, no files)

Set `OVERLEAF_GIT_TOKEN` and `OVERLEAF_PROJECT_ID` in the client's `env` block (as in Install). The server builds a single `default` project from them and lands clones under `~/.overleaf-mcp/repos/`. This covers the common single-project case completely.

| Env var | Meaning |
| --- | --- |
| `OVERLEAF_GIT_TOKEN` | Overleaf git token. Required, here or in `projects.json`. |
| `OVERLEAF_PROJECT_ID` | The id from `https://www.overleaf.com/project/<ID>`. Its presence triggers env-only mode. |
| `OVERLEAF_PROJECT_NAME` | Optional display name for the synthesized project. |
| `OVERLEAF_MCP_HOME` | Optional. Override the data home (default `~/.overleaf-mcp`). |
| `OVERLEAF_MCP_TEMPLATES` | Optional. Override the templates directory. |
| `OVERLEAF_VOICE_LINTER` | Optional. Prose-linter command for `voice_lint` (alternative to `settings.voiceLinter`). |

### Config-file mode (multiple projects, contexts, bootstrap)

For more than one project, per-project contexts, or the SSA bootstrap, use a `projects.json`. Scaffold it:

```bash
npx overleaf-forge init
```

That creates `~/.overleaf-mcp/projects.json` from the example and copies the editable templates into `~/.overleaf-mcp/templates/`. Then fill in the config:

```json
{
  "settings": {
    "gitToken": "olp_xxxxxxxxxxxxxxxxxxxxxxxx",
    "repoDir": "/Users/you/Overleaf"
  },
  "projects": {
    "default": {
      "name": "My Paper",
      "projectId": "0123456789abcdef01234567",
      "cwd": "/Users/you/path/where/you/run/the/client"
    }
  }
}
```

| Setting | Meaning |
| --- | --- |
| `settings.gitToken` | Overleaf git token, used by every project (or set `OVERLEAF_GIT_TOKEN`). A per-project `gitToken` overrides it. |
| `settings.repoDir` | Where project clones land by default (`repoDir/<name>`). A per-project `localPath` overrides it. |
| `settings.templatesDir` | Optional. Directory of scaffold templates, overriding the bundled defaults. |
| `settings.voiceLinter` | Optional. A prose-linter command (or set `OVERLEAF_VOICE_LINTER`) that `voice_lint` runs on a file. No default. |
| `projects.<key>.projectId` | The id from `https://www.overleaf.com/project/<ID>`. |
| `projects.<key>.cwd` | Directory you launch the client from for this project; used to auto-detect the active project. |
| `projects.<key>.localPath` | Explicit clone location (optional). |

`projects.json` is re-read on every call, so registering a project or rotating the token takes effect immediately, with no restart. (Code changes do need a restart; the server loads its `.js` once at startup.)

### Where files live

User state (the `projects.json`, per-project `contexts/`, customised `templates/`, and the git clones) lives in the **data home**, resolved as: `$OVERLEAF_MCP_HOME` if set, else the package directory when it already holds a `projects.json` (so an existing local clone keeps working untouched), else `~/.overleaf-mcp`. Bundled, read-only defaults (the templates and the stock writing-guidelines) ship inside the package; a copy you place in the data home overrides the bundled one.

### Getting Overleaf credentials

1. **Git token**: Overleaf → Account Settings → Git Integration → create a token. One token covers every project on the account.
2. **Project ID**: the id segment of the project URL: `https://www.overleaf.com/project/<ID>`.

### Per-project context (optional but recommended)

Assignment-specific notes (terminology, deadlines, structure constraints, pinned decisions) live in `contexts/<key>.md` under the data home, and shared writing rules in `writing-guidelines.md`. Both are re-read on every `get_context` call, so you can edit them mid-session. `get_context` is the intended first call of a writing session.

### Customising the templates

The SSA bootstrap scaffolds from two templates: `main.tex` (the document skeleton) and `context-scaffold.md` (the project-questions checklist). Defaults ship with the package. To change them, run `npx overleaf-forge init` (which copies both into `~/.overleaf-mcp/templates/`) and edit them in place, or point `settings.templatesDir` / `OVERLEAF_MCP_TEMPLATES` at your own directory. The tokens `__SSA_NAME__`, `__SSA_TITLE__`, `__SSA_DATE__`, and `__OVERLEAF_READ_URL__` are substituted at scaffold time. A missing template falls back to the built-in default, so a partial templates directory never breaks the bootstrap.

## Install via an AI agent

Hand this to an agent (Claude Code, Cursor, etc.) to set up the server in the current client:

```text
Install the Overleaf MCP server (npm package: overleaf-forge).
1. Find this client's MCP config file (Claude Code ~/.claude.json, Claude Desktop's
   claude_desktop_config.json, or LM Studio ~/.lmstudio/mcp.json).
2. Add an "overleaf" entry under mcpServers:
     command: "npx", args: ["-y", "overleaf-forge"]
   with an env block containing OVERLEAF_GIT_TOKEN and OVERLEAF_PROJECT_ID.
3. Ask me for my Overleaf git token (Account Settings → Git Integration) and the
   project id from my project URL. Do not invent them.
4. For multiple projects or the SSA bootstrap, run `npx overleaf-forge init`
   and edit ~/.overleaf-mcp/projects.json instead of the env block.
5. Tell me to restart or reload MCP servers in the client, then call status_summary
   to confirm it connected.
```

## Quick start

A typical editing session, in the model's words:

1. *"Read the context for this project."* → `get_context`
2. *"Show me the sections in `Chapters/ch2.tex`."* → `get_sections`
3. *"In `Chapters/ch2.tex`, change `\section{Intro}` to `\section{Introduction}`."* → `edit_file` (anchored, conflict-safe)
4. *"Add a figure: upload `~/plots/fig1.png` to `figures/fig1.png`."* → `upload_file`
5. *"Verify the build."* → `verify_build` → `✓ PASS — 12 pages`

Every write commits and pushes to Overleaf; `verify_build` is the gate before calling the work done.

## Conflict safety

Edits never silently overwrite a concurrent Overleaf change.

- **`edit_file`** pulls the latest first (so a non-overlapping browser edit is absorbed), then replaces an exact anchor string. If the anchor is gone, the region changed since you read it, and the edit refuses rather than guessing. On the rare push race, git performs a real 3-way merge and the edit refuses only on a true overlap.
- **`write_file`** (full-file create or overwrite) creates a new file freely. To overwrite an existing file it requires either the `baseSha` you got from `read_file` (a stale one is refused) or an explicit `overwrite: true`. It never merges a wholesale replacement; a push race refuses and resets.
- **`upload_file`** uses the same gate for binaries, never merges, and confines every destination path inside the project clone.
- An explicit `projectName` that doesn't resolve is an **error**, never a silent fall-through to a different project, so a write cannot land in the wrong repo.

## Bootstrap for recurring structured documents

`bootstrap_ssa` automates the repetitive setup for documents you create on a recurring schedule, where each instance lives in a predictable folder and follows a naming convention. The built-in convention targets SSAs (the recurring coursework format this fork was built around), but the same shape fits lab notes, weekly reports, meeting minutes, or journal entries.

> Bootstrap `https://www.overleaf.com/project/abc123` as `Y1 ABC123 SSA 5`.

By the built-in convention this parses the name, locates the parent course folder under `settings.academicRoot/Year <year>/Q*/<COURSE>*`, creates `<parent>/<ssaSubdir>/<name>/`, clones the Overleaf repo into an `overleaf/` subfolder, registers the project, and scaffolds a context file with a question template. Pass `cleanAfterClone: true` when the project was duplicated from a previous instance to wipe the body (chapters, appendices, bib, figures) while keeping the preamble.

**Adapting it.** The parsing and folder rules are specific to the SSA scheme; to drive other recurring work, adjust `parseSsaName` / `findCourseFolder` and the `bootstrap_ssa` handler, or skip the bootstrap entirely and `register_project` each instance.

## Tools

**Project setup & context**

| Tool | Purpose |
| --- | --- |
| `get_context` | Read the writing guidelines + the active project's context. Intended first call of a session. |
| `list_projects` | List configured projects; mark which one auto-detects from the current directory. |
| `register_project` | Add or overwrite a project entry without hand-editing JSON. |
| `set_project_path` | Update a project's `localPath` and/or `cwd`. |
| `update_context` | Replace or append `contexts/<key>.md`. Takes effect immediately. |
| `bootstrap_ssa` | One-shot onboarding for a recurring structured document (see above). |
| `reset_ssa_content` | Empty chapters/appendices/`refs.bib`/figures and optionally rewrite the title block; commit + push. Preamble untouched. |

**Reading & search**

| Tool | Purpose |
| --- | --- |
| `read_file` | Read a file. The first line carries the file's `baseSha` (its git blob hash) for conflict-safe writes. |
| `list_files` | List files in the project, filtered by extension. |
| `get_sections` | List `\section` / `\subsection` / `\subsubsection` entries in a `.tex`. |
| `get_section_content` | Pull a single section's body by title (level-aware: a section keeps its subsections). |
| `search_text` | Grep tracked files. Regex by default; `fixed` for a literal, `ignoreCase`, `extension` to scope. Returns `file:line:match`. |
| `status_summary` | File count, main file, section count. |

**Editing & figures**

| Tool | Purpose |
| --- | --- |
| `edit_file` | Anchored `oldString` → `newString` edit + commit + push. Conflict-safe; auto-merges non-overlapping concurrent edits. Preferred for existing files. |
| `write_file` | Create a new file, or overwrite one wholesale. Existing-file overwrite needs `baseSha` or `overwrite: true`. |
| `upload_file` | Upload binary file(s) (figures) from a local path. Single or batch (one commit). Byte-exact, path-confined, same conflict gate. |

**Building & verification**

| Tool | Purpose |
| --- | --- |
| `compile_file` | Compile with `latexmk` from the repo root, so the project `.latexmkrc`, reruns, and bibliography all apply; reports errors, undefined refs, overfull boxes. |
| `verify_build` | Clean-from-scratch compile + PASS/FAIL verdict: PASS only with a PDF and zero errors / undefined references / undefined citations. Reports page count. The done-bar gate. |

**Citations, snapshots, voice**

| Tool | Purpose |
| --- | --- |
| `add_citation` | Append a BibTeX entry to `refs.bib` (refuses a duplicate key) + push. |
| `cite_lint` | Report undefined (`\cite` with no entry) and unused (entry never cited) citations. Read-only. |
| `checkpoint` | Mark a local rollback point (a `mcp-snap/<label>` tag) before a risky edit. |
| `restore` | Roll back to a checkpoint via a forward commit + push (no force, no history rewrite). |
| `voice_lint` | Run a configured prose linter (`settings.voiceLinter`) on a `.tex`. Read-only, advisory. |

## How it works

Each project is a normal git clone of its Overleaf repo, kept under `repoDir` (or `localPath`). On every operation the server pulls the latest, performs the read/edit/build locally, and pushes. Git runs through `execFile` with argument arrays (no shell), so file paths, commit messages, and patterns can't inject commands. Authentication uses an inline git credential helper that reads the token from the process environment, so the token is never written into a remote URL, a command line, or an error message; the clone's `origin` stays token-free. `compile_file` and `verify_build` shell out to `latexmk` from the repo root so the project's own `.latexmkrc` governs the build.

## Testing & development

```bash
npm install
node --test            # run the full suite
node --check overleaf-mcp-server.js
```

Tests run the real client against a throwaway local bare repository that stands in for Overleaf, so the full edit/merge/conflict/upload/snapshot behaviour is exercised with no network and no real account. The `verify_build` log classifier is unit-tested on captured log strings; a single integration test compiles a trivial document and auto-skips when `latexmk` isn't installed, so the suite is green on any machine.

## Security

- `projects.json` is gitignored; never commit a real token.
- The token is supplied to git through an environment-backed credential helper and never appears in a command string, a remote URL, or an error. Any tokenized URL that could surface in an error is redacted before it is returned. Rotate by updating `settings.gitToken`; it applies on the next call.
- All subprocess calls use `execFile` (no shell), so paths, commit messages, and section titles cannot inject shell commands.
- `upload_file` destinations are resolved and confined inside the project clone (no `..` escape, no absolute paths, not the `.git` directory).

## Origin & credits

Forked from [mjyoo2/OverleafMCP](https://github.com/mjyoo2/OverleafMCP). The original established the git-integration approach and the base read/write/compile tools; this fork reworked the edit path for conflict safety, hardened the git layer, and added the verification, figure, citation, snapshot, voice, bootstrap, and context tooling.

## License

MIT. See [LICENSE](LICENSE) if present, or treat this as MIT per the upstream project.
