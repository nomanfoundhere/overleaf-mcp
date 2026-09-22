# Overleaf workflow

This short guide is loaded by `get_context`. Apply the user's current instructions and existing project template.

## Personal overrides

This is the bundled generic guide. Place a `writing-guidelines.local.md` in the data home to replace it with personal rules (voice, house style, template conventions); that file is gitignored and read in preference to this one on every `get_context` call. Detailed personal references can sit beside it in a gitignored `references.local/` and be pointed to from the local guide.

Call `get_context` with the explicit project key when establishing the project in a session. Confirm the returned identity. Reuse guidance already read while it remains available and unchanged; do not also read the same file separately. Check file modification time or a content hash if freshness is uncertain. Reload affected guidance after a change, a project switch or lost context. Pass the returned `version` as `previousVersion` on a later `get_context` call: unchanged context returns a compact response. Changed context returns the updated body.

Keep project-specific context focused on constraints, sources, decisions and unresolved questions. Do not copy the shared rules into each project context or expand durable context files without authorization.

## Small-edit workflow

Synchronize once at the start only when remote changes matter. Afterwards, `list_files`, `read_file`, `get_sections`, `get_section_content`, `search_text`, `cite_lint`, the dependency tools and builds read the existing local clone only. They never pull, so a focused read cannot overwrite local work or spend a network round trip. A missing clone is an explicit `sync_project` task.

Read the target section and enough surrounding text to understand it, make the edit, check affected claims and rendered pages, run one final verification, then publish only when separately authorized. A wording edit stays within wording and its supporting claims. Do not expand it into a design review unless the requested edit changes a technical claim or exposes a concrete inconsistency; explain that dependency before broadening work. A front-matter edit normally starts with that file and the evidence supporting its changed claims, not the entire document archive. Broaden inspection when a changed value, label, assumption or shared component has downstream users.

Preserve the template, preamble and unrelated edits. Inspect the bibliography entries used by new or changed claims rather than repeatedly dumping the whole bibliography. Read source support before adding a claim; reuse already verified stable evidence when it still supports the wording. Refresh time-sensitive facts as needed. Never infer that an unread source supports a claim.

## One final verification gate

Batch a coherent set of edits before building. Compile during editing when needed to resolve a layout question, a compilation failure or another concrete uncertainty. For an intermediate check, `verify_build` with `clean: false` runs a quick incremental rebuild. Do not run it immediately before the final gate, which compiles from scratch anyway. A successful final `verify_build` on the latest source satisfies the compilation gate. A local LuaLaTeX build plus equivalent log checks is the fallback when MCP verification is unavailable.

Require a produced PDF, zero LaTeX errors, zero undefined citations/references and no newly introduced overfull/underfull boxes. Report page count. Re-run after changes that invalidate the successful check, not merely because another step in a checklist also says to build. Build tools operate locally without pulling. Call `sync_project` explicitly when remote changes are needed. `verify_build` reuses eligible unchanged success results, while `force: true` requests a rebuild. Executable configuration or incomplete dependency tracking disables reuse; a fresh build may clean auxiliary files. Preserve concurrent user edits and use the verified project/branch. `lint: true` (or a list of paths) adds the voice linter to the gate: findings fail the verdict the same way an undefined reference does.

`controlled: true` is an opt-in reproducible-build mode. It runs `latexmk -norc -no-shell-escape`, so project rc files cannot affect the result. Declare any necessary regular external files through absolute `externalInputs`; their content hashes enter the cache key. Do not enable it for projects that require `minted`, shell escape, Lua file access or their rc file. Those features remain ineligible for cached reuse.

Inspect changed PDF pages and their neighbours. Expand review when pagination changes affect subsequent layout, or when shared fonts, macros, numbering, contents, bibliography or figures change. Number-only page shifts do not alone require re-reading all unchanged prose. Check the latest rendered result, not an earlier screenshot.

## Delegation and reusable diagrams

When delegation is authorized and worth its overhead, give lighter agents bounded extraction, inventory or comparison tasks with specific files and compact outputs. Give them only the relevant context. Keep ambiguous physical design, critical derivations and judgment-heavy figure work with the primary agent unless a clear independent assignment justifies delegation. Do not create an agent merely to reread an already understood section. If repeated corrections erase the benefit, finish the task locally.

Before creating a diagram generator, inspect existing project figures and scripts. Reuse their established geometry, colours, notation and layout helpers where appropriate. Derive geometry from parameters and verify connections, directions, scale and label readability. Do not force an unsuitable old diagram onto a new mechanism or create a general graphics framework for a single figure.

## Compact evidence and stopping conditions

Use `get_section_content` with `bundle: true` for a local section plus its directly referenced equation/figure blocks, citation entries and asset paths. Use `dependency_index` when changed labels, values, citations or included files may affect other sections. It reports static links and unresolved dynamic constructs. Use `change_report` with its previous version to narrow the next read. Use `render_pages` with explicit page numbers to reuse a locally cached render of an unchanged PDF page. Inspect unresolved references and truncation flags; these tools are not recursive TeX interpreters.

For a coherent multi-file edit, first read each file's `baseRevision` and `contentHash`, then call `apply_changes`. It checks every input hash, verifies the complete candidate once in an isolated worktree and fast-forwards one local commit only on success. It handles UTF-8 source files, not binary assets. `publish_changes` separately re-verifies the exact clean revision and pushes it once when publication is authorized. It never pulls, merges, resets or retries a publish. Resolve a stale-source or conflict error with a fresh focused read rather than repeating the same request.

`edit_file`, `write_file`, `upload_file`, `add_citation` and `restore` commit locally unless `push: true` or `settings.autoPush` is set. Local commits accumulate, and each result reports HEAD and the unpublished count; `publish_changes` with that HEAD verifies once and pushes the whole stack. If Overleaf moved in the meantime, the push is refused: `sync_project` then reports both sides of the divergence without changing anything. `strategy: "rebase"` replays the local commits onto Overleaf and aborts to the untouched state on a conflict. `strategy: "reset"` discards local work only with `confirm` set to the reported head, after tagging the old head and any uncommitted edits as `mcp-backup/*`.

Build tools return compact verdicts and log paths by default; `verbose: true` adds a bounded tail. `usage_stats` reports in-process call counts, response bytes, durations and cache hits without recording document text. Response bytes are a comparison signal, not a billing estimate. Structured errors give a suggested next action and always declare zero automatic retries. Request focused search results, changed values, concise diffs and build verdicts. Keep full logs on disk; bring relevant error context into the conversation when needed. Batch independent reads and checks, inspect every result, and keep dependent edits and approvals sequential. Use reasonable polling intervals instead of repeated short waits.

Stop verification when the latest edit passes its relevant checks and no unresolved concern calls for another pass. Preserve source checks for new claims, independent checks of consequential calculations and visual review of changed diagrams. Usage savings must not come from hiding uncertainty, skipping these checks or claiming unmeasured savings. Existing publication authorization persists; do not infer new authorization from this workflow.
