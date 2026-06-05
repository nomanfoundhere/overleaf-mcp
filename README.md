# Overleaf MCP Server

> **Acknowledgement.** Forked from [mjyoo2/OverleafMCP](https://github.com/mjyoo2/OverleafMCP), the original Overleaf MCP server. This is an independent fork that adds a bootstrap for recurring structured documents, per-project contexts, CWD autodetection, and a hardened git layer (no-shell `execFile`, credential-helper auth, `latexmk` compile, pull/recovery).

MCP server that exposes an Overleaf project to Claude via Overleaf's git integration. Read, write, push, and compile `.tex` from inside a Claude session.

## Layout

```
OverleafMCP/
├── overleaf-mcp-server.js     # MCP server
├── projects.json              # config (gitignored)
├── projects.example.json
├── writing-guidelines.md      # LaTeX + writing rules, surfaced via get_context
├── contexts/                  # per-project context md, surfaced via get_context
│   └── default.md
├── templates/
│   └── main.tex               # canonical full document (preamble + title + Chapters + bib + appendix)
├── package.json
└── README.md
```

## Configuration

`projects.json` shape:

```json
{
  "settings": {
    "gitToken": "olp_...",
    "repoDir": "/Users/you/PDFs/Overleaf GIT"
  },
  "projects": {
    "default": {
      "name": "My Paper",
      "projectId": "OVERLEAF_PROJECT_ID",
      "cwd": "/Users/you/path/where/claude/runs"
    }
  }
}
```

- `settings.gitToken` — global token, used by all projects (per-project `gitToken` overrides). Alternatively set `OVERLEAF_GIT_TOKEN`.
- `settings.repoDir` — where Overleaf clones land by default. Per-project `localPath` overrides.
- `projects.<key>.cwd` — directory you launch Claude from for this project. Used for auto-detecting which project to talk to when no `projectName` is supplied.

Project context (assignment-specific notes, terminology, deadlines) lives in `contexts/<key>.md`, **not** inside the JSON. Both `contexts/<key>.md` and `writing-guidelines.md` are re-read from disk on every `get_context` call — edit them mid-session, no restart needed.

## Adding a project

For any single Overleaf project, register it once — no JSON editing:

> Register a new project: key `thesis`, Overleaf id `abcd1234efgh5678`, name "Thesis".

That uses `register_project`, defaults `cwd` to the current session, and scaffolds `contexts/thesis.md`. To repoint an existing project's local clone, use `set_project_path` ("Set the local path for `thesis` to `/somewhere/else`"). From there all the general tools below work on it.

## Bootstrap for recurring structured documents

`bootstrap_ssa` automates the repetitive setup for **recurring structured documents** — work where each new instance lives in a predictable folder and follows a naming convention, so onboarding it is otherwise the same clone/register/scaffold dance every time. The built-in convention targets SSAs (a recurring TU/e assignment), but the same shape fits any recurring structured Overleaf work: lab notes, weekly reports, meeting minutes, journal entries.

Drop the Overleaf URL and a name into chat:

> Bootstrap `https://www.overleaf.com/project/abc123...` as `Y1 ABC123 SSA 5`.

By the current (SSA) convention, `bootstrap_ssa`:

1. Parses the name (`Y<year> <COURSE_CODE> SSA <num>`).
2. Locates the parent folder under `settings.academicRoot/Year <year>/Q*/<COURSE_CODE>*` (the code is the first whitespace-delimited token of the folder name, e.g. `ABC123 - Course Title`).
3. Creates `<parent>/<settings.ssaSubdir>/<name>/` (default subdir `MY SSAs`) and clones the Overleaf repo into `<workspace>/overleaf/`.
4. Registers the project (key = slug, e.g. `y1-4cbla30-ssa5`), scaffolds `contexts/<slug>.md` with a question template, and returns a checklist for Claude to fill the context via `update_context`.

Add `cleanAfterClone: true` (optionally `readUrl`) when the Overleaf project was duplicated from a previous instance: that runs `reset_ssa_content` against the fresh clone and pushes the wipe, so you start with the preamble intact and every chapter / appendix / bib entry / figure cleared. `templates/main.tex` holds a canonical full document you can seed a brand-new project with via `write_file`.

> **Adapting the convention.** The name parsing and folder rules are specific to the SSA scheme. To drive other recurring work (say `Notes 2026-W23`), adjust `parseSsaName` / `findCourseFolder` and the `bootstrap_ssa` handler to your own naming and folder layout — or skip the bootstrap and just `register_project` each instance. `settings.academicRoot` and `settings.ssaSubdir` configure where the bootstrap places workspaces.

## Tools

| Tool | Purpose |
| --- | --- |
| `bootstrap_ssa` | One-shot onboarding for a recurring structured document via the built-in naming/folder convention (currently SSAs): parse the name, find the parent folder, create the workspace, clone, register, scaffold context. `cleanAfterClone: true` wipes the body when the project was duplicated from a previous instance. See *Bootstrap for recurring structured documents*. |
| `reset_ssa_content` | Empty Chapters/ch*.tex, Chapters/app_*.tex, refs.bib, figures/* and optionally rewrite the title block in main.tex; commit + push. For starting a duplicated structured doc from a clean slate. Preamble untouched. |
| `get_context` | Read writing guidelines + active project context. Call at start of every writing session. |
| `list_projects` | List configured projects, show which one autodetects from CWD. |
| `register_project` | Add/overwrite a project entry. Defaults `cwd` to the current session. |
| `set_project_path` | Update `localPath` and/or `cwd` for an existing project. |
| `update_context` | Replace or append `contexts/<key>.md`. Takes effect immediately. |
| `list_files` | List files in the Overleaf repo (filter by extension). |
| `read_file` | Read a file. |
| `get_sections` | List section titles in a `.tex`. |
| `get_section_content` | Pull a single section body by title. |
| `edit_file` | Surgical anchored edit (oldString -> newString) + commit + push. Preferred over `write_file` for existing files: cheap, and conflict-safe — a missing anchor means the region changed on Overleaf, so it refuses instead of clobbering; non-overlapping concurrent edits auto-merge. |
| `write_file` | Create a new file or overwrite one wholesale + push. Existing-file overwrite needs `baseSha` (from `read_file`) or `overwrite: true`; a stale `baseSha` is refused, never merged. Prefer `edit_file` for edits. |
| `upload_file` | Upload binary file(s) (PNG/PDF figures) from a local disk path into the project + push. `write_file`/`edit_file` are text-only. Single (`srcPath`+`destPath`) or batch (`files: [{srcPath, destPath}]`, one commit). Existing files need `baseSha` (single) or `overwrite: true`. Path-confined to the repo. |
| `compile_file` | Compile with `latexmk` from the repo root (LuaLaTeX default), so the project `.latexmkrc`, reruns, and bib processing all apply; reports errors, undefined refs, and overfull boxes. |
| `verify_build` | Clean-from-scratch compile + a PASS/FAIL verdict on the done-bar: PASS only with a PDF and zero errors / undefined refs / undefined citations. Reports page count; overfull/underfull are warnings. The final gate before calling a writing task done. |
| `status_summary` | High-level project status. |

## Project autodetect

When a tool is called without `projectName`, the server picks the project whose `cwd` is the longest prefix of the current Claude session's working directory. Falls back to `projects.default`, then the first entry. To see which one resolves, call `list_projects` — the result tags the autodetected entry. When `projectName` **is** supplied it must resolve to a known key or name; an unresolvable `projectName` raises an error rather than silently falling through to autodetection, so a write never lands in the wrong project.

## Conflict safety

Edits never silently overwrite a concurrent Overleaf change. `edit_file` pulls first (so non-overlapping browser edits are absorbed) and matches an exact anchor; a missing anchor means the targeted region changed, and the edit refuses. `write_file` overwriting an existing file must pass the `baseSha` from `read_file` (a stale one is refused) or `overwrite: true` to force. On the rare push-race, `edit_file` lets git 3-way-merge and refuses only on a real overlap. Binary uploads (`upload_file`) use the same gate — new files create, existing files need `baseSha` (single mode) or `overwrite: true` — but never merge (a push race refuses and resets), and a `destPath` is always confined inside the project.

## Claude Desktop / Claude Code wiring

```json
{
  "mcpServers": {
    "overleaf": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/path/to/OverleafMCP/overleaf-mcp-server.js"]
    }
  }
}
```

## Getting Overleaf credentials

1. **Git token:** Overleaf → Account Settings → Git Integration → Create Token. Same token covers every project on that account, so it lives once in `settings.gitToken`.
2. **Project ID:** the part of `https://www.overleaf.com/project/<ID>`.

## Security

- `projects.json` is gitignored — never commit a real token.
- The git token is **never** placed in a command string or remote URL. Authenticated git operations (clone/pull/push) supply it through an inline credential helper that reads it from the environment, so it cannot leak into process listings or error output. The cloned `origin` URL is token-free, and any tokenized URL that might still surface in an error is redacted before it is returned. Rotate by updating `settings.gitToken`; it takes effect on the next call.
- All subprocess calls use `execFile` (no shell), so file paths, commit messages, and section titles cannot inject shell commands.

## License

MIT.
