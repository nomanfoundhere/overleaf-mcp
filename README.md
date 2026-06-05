# Overleaf MCP Server

MCP server that exposes an Overleaf project to Claude via Overleaf's git integration. Read, write, push, and compile `.tex` from inside a Claude session.

## Layout

```
OverleafMCP/
├── overleaf-mcp-server.js     # MCP server
├── projects.json              # config (gitignored)
├── projects.example.json
├── writing-guidelines.md      # LaTeX + SSA rules, surfaced via get_context
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

## One-shot SSA bootstrap

The fastest path. Drop the Overleaf URL and the SSA name into chat:

> Bootstrap `https://www.overleaf.com/project/abc123...` as `Y1 ABC123 SSA 5`.

That triggers `bootstrap_ssa`, which:

1. Parses the SSA name (`Y<year> <COURSE_CODE> SSA <num>`).
2. Locates the course folder under `settings.academicRoot/Year <year>/Q*/<COURSE_CODE>*`. Folder convention: course code is the first whitespace-delimited token (e.g. `ABC123 - Course Title`).
3. Creates `<course>/<settings.ssaSubdir>/<ssaName>/` (default subdir `MY SSAs`).
4. Clones the Overleaf repo into `<workspace>/overleaf/`.
5. Registers the project in `projects.json` (key = slug, e.g. `y1-4cbla30-ssa5`).
6. Scaffolds `contexts/<slug>.md` with a question template.
7. Returns a checklist of context questions for Claude to walk through with you, then writes the populated context via `update_context`.

Add `cleanAfterClone: true` (and optionally `readUrl`) when the Overleaf project was just duplicated from a previous SSA — that runs `reset_ssa_content` against the fresh clone and pushes the wipe, so you start with the preamble intact and every chapter / appendix / bib entry / figure cleared.

The canonical full main.tex (preamble + title block + Chapters input + ToC tcolorbox + bibliography + appendix) lives in `templates/main.tex`. If you want to seed a brand-new Overleaf project with it, read `templates/main.tex` and `write_file` to `main.tex` after bootstrap.

`settings.academicRoot` and `settings.ssaSubdir` configure where SSAs land.

## Adding a project without editing JSON (manual)

For non-SSA projects:

> Register a new project: key `thesis`, Overleaf id `abcd1234efgh5678`, name "Thesis".

That uses `register_project`, defaults `cwd` to the current session, and scaffolds `contexts/thesis.md`.

To repoint an existing project's local clone:

> Set the local path for `ssa4` to `/somewhere/else`.

That uses `set_project_path`.

## Tools

| Tool | Purpose |
| --- | --- |
| `bootstrap_ssa` | One-shot: parse `Y<year> <COURSE> SSA <num>`, find the course folder, create the workspace, clone Overleaf, register, scaffold context. Pass `cleanAfterClone: true` when you've duplicated a previous SSA in the Overleaf UI and want the body wiped immediately. |
| `reset_ssa_content` | Empty Chapters/ch*.tex, Chapters/app_*.tex, refs.bib, figures/* and optionally rewrite the title block in main.tex. Commits + pushes. Run after duplicating a previous SSA in Overleaf. Preamble is untouched. |
| `get_context` | Read writing guidelines + active project context. Call at start of every writing session. |
| `list_projects` | List configured projects, show which one autodetects from CWD. |
| `register_project` | Add/overwrite a project entry. Defaults `cwd` to the current session. |
| `set_project_path` | Update `localPath` and/or `cwd` for an existing project. |
| `update_context` | Replace or append `contexts/<key>.md`. Takes effect immediately. |
| `list_files` | List files in the Overleaf repo (filter by extension). |
| `read_file` | Read a file. |
| `get_sections` | List section titles in a `.tex`. |
| `get_section_content` | Pull a single section body by title. |
| `write_file` | Write + commit + push to Overleaf. Always follow with `compile_file`. |
| `compile_file` | Compile with `latexmk` from the repo root (LuaLaTeX default), so the project `.latexmkrc`, reruns, and bib processing all apply; reports errors, undefined refs, and overfull boxes. |
| `status_summary` | High-level project status. |

## Project autodetect

When a tool is called without `projectName`, the server picks the project whose `cwd` is the longest prefix of the current Claude session's working directory. Falls back to `projects.default`, then the first entry. To see which one resolves, call `list_projects` — the result tags the autodetected entry. When `projectName` **is** supplied it must resolve to a known key or name; an unresolvable `projectName` raises an error rather than silently falling through to autodetection, so a write never lands in the wrong project.

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

## Origin

Forked from [mjyoo2/OverleafMCP](https://github.com/mjyoo2/OverleafMCP). This version (v2) adds the SSA bootstrap, per-project contexts, CWD autodetection, and hardens the git layer (no-shell `execFile`, credential-helper auth, `latexmk` compile, pull/recovery). Maintained independently; upstream is unmaintained.

## License

MIT.
