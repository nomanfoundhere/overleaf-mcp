# Overleaf Writing Guidelines

This file is read on every `get_context` call. It is the single source of truth for **LaTeX mechanics, SSA structure, and enforcement**. Authorial voice rules live in the user's global `CLAUDE.md` — this file deliberately does not duplicate them. If you are not certain you have read `CLAUDE.md` already this session, stop and read it before writing prose.

---

## 0. Pre-flight — read before any edit

Before drafting or modifying any `.tex`:

1. Call `get_context` for the active project (it autodetects from CWD; no need to pass `projectName`).
2. Call `status_summary` and skim what already exists. Read the surrounding section with `get_section_content` rather than guessing.
3. Read `refs.bib` if you intend to cite. New citations need a `refs.bib` entry — do not invent `\cite{}` keys.
4. If preamble or package availability is in doubt, read the project's `main.tex` preamble before adding any `\usepackage{}` or environment.

Skipping this step is the most common cause of "Claude wrote good-looking LaTeX that doesn't build."

---

## 1. End-of-write enforcement checklist

**Before declaring a writing task complete, walk this list literally.** Do not paraphrase, do not skim — read each item and check the file.

- [ ] **Em-dashes:** zero `—` characters in the prose (search the file). Replace with comma, parenthesis, colon, or sentence break. (Exception: none. The rule has no exceptions in this project.)
- [ ] **`\autoref{}` everywhere:** zero bare `\ref{}` or `\pageref{}` in the file. Cross-refs use `\autoref{}`. The preamble loads `hyperref` for this — there is no excuse.
- [ ] **All tables are `longtable`.** No bare `tabular`, no `tabularx`. Header row repeats via `\endhead`.
- [ ] **Display math:** no `\[ ... \]`. Only `equation`, `align`, `gather`, or `multline`. `\allowdisplaybreaks` is on globally — do not add it locally.
- [ ] **No math-mode font commands:** no `\mathrm`, `\mathbf`, `\mathit`, `\mathsf`, `\mathcal` unless absolutely required for disambiguation (and even then prefer `siunitx`).
- [ ] **`siunitx` for units:** no `m/s`, no `kg`, no `\%` typed by hand next to numbers. Use `\SI{}{}` and `\si{}`.
- [ ] **No `\emph`, no `\\` for spacing, no `\newline`.** Use `\vspace{}` / structure instead.
- [ ] **Every non-trivial number is interpreted in the sentence that contains it** (see SSA rules below).
- [ ] **Every factual claim that isn't common knowledge has a `\cite{}`** and a matching `refs.bib` entry. No raw URLs in the prose.
- [ ] **`compile_file` succeeds.** Run it on the project entrypoint (usually `main.tex`). If it fails, fix and re-run before reporting done. A successful diff is not the same as a successful build.
- [ ] **Voice check against CLAUDE.md** — re-read the "Phrases to avoid wholesale" list and grep for them in your changes.

This checklist exists because the rules below get skimmed. Run it.

---

## 2. LaTeX mechanics

### 2.1 Engine and preamble

- **Engine:** LuaLaTeX. Required for `plex-otf` and `emoji`. Do not switch engines without being asked.
- **Font:** IBM Plex Sans via `plex-otf`, sans-serif default family.
- The canonical full main.tex (preamble + title block + Chapters input + tcolorbox-wrapped ToC + bibliography + appendix) lives in `templates/main.tex`. **Read it before adding any new package or environment.** Do not rebuild from memory and do not reorder preamble blocks — package order is load-bearing (e.g. `hyperref` must load before `cleveref`, `mathastext` before `siunitx`).
- The preamble already includes `\allowdisplaybreaks`. All equations break across pages by default — never add it locally.
- The preamble already loads `hyperref`, so `\autoref{}` is available everywhere. There is never a reason to use `\ref{}`.
- The preamble already loads `longtable`. Use `longtable` for any multi-row data table — even short ones — so future row additions don't require switching environments.

### 2.2 Section structure and ToC

- `\section{}` — main chapters.
- `\subsection{}` — major divisions.
- `\subsubsection{}` — minor divisions.
- `\paragraph{}` — named items inside a section (categories, design options, listed configurations). These appear in the ToC and give an at-a-glance view of contents. The SSA1 thermal-storage section is the model.
- Do not go deeper than `\paragraph` unless strictly necessary.
- The ToC must be readable as a standalone outline of what the document contains. If your ToC reads as a generic skeleton ("Introduction / Method / Results / Conclusion"), the document is under-structured.

### 2.3 Cross-references

- Always `\autoref{}`. Never bare `\ref{}` or `\pageref{}`.
- Label conventions: `sec:`, `fig:`, `tab:`, `eq:`, `app:`. Be consistent within a document.

### 2.4 Math

- Inline: `$ ... $`.
- Display: `equation`, `align`, `gather`, `multline`. Never `\[ \]`.
- No math-mode font commands (`\mathrm`, `\mathbf`, `\mathit`, `\mathsf`, …). Variables stay in default math italic.
- Use `annotate-equations` to label variables on **first introduction** of an equation, and to annotate non-obvious steps (a substitution, a change of variable, a physical interpretation). Do **not** annotate trivial algebra.
- Symbol consistency: pick a symbol per quantity at the start of the document and do not redefine it. If you must reuse a letter, declare scope explicitly.

### 2.5 Text formatting

- `\textbf{}`, `\textit{}`, `\texttt{}` allowed but sparingly. Reshape the sentence before reaching for `\textbf{}`.
- File names, paths, variable names, code inline: `\verb|...|` or `\texttt{}`.
- No `\emph{}` — italic does not sit well with the sans font.

### 2.6 Spacing and breaks

- No `\newline`, no `\\` for spacing in prose. Use `\vspace{}`, `\parskip`, or proper structure.
- Use `\noindent` only when typographically necessary, not as a habit.

### 2.7 Citations

- `biblatex` with `style=ieee` and `backend=biber`. Cite with `\cite{}`.
- Numeric, ordered by appearance.
- Every non-obvious factual claim needs a citation.
- Cite the primary source. If a textbook cites a paper, cite the paper.
- No raw URLs in prose. URLs live only in the `refs.bib` entry.

### 2.8 Code

- `minted` with `style=fruity`.
- Short focused snippets in the body when explaining code line-by-line; the full script goes in the appendix and is referenced with `\autoref{app:...}`.
- Do not paste entire files into the main flow. If a snippet runs longer than ~25 lines, ask whether it should be appendix-shaped.

### 2.9 Figures

- Captions below figures (`\caption` after `\includegraphics`).
- Place images near the referencing text. Do not force floats far from context.
- Subfigures via `subcaption` package when needed.
- PDF-page extracts (slide screenshots, report pages used as figures) wrap in `\fbox{}` to frame them as external documents.
- Photographs, diagrams, plots: no `\fbox{}`.
- Every figure is referenced from the prose with `\autoref{}` and is interpreted, not just shown.

### 2.10 Tables

- **Default environment is `longtable`.** Not `tabular`, not `tabularx`. Even a three-row table goes in `longtable` so a later row addition does not force an environment swap. The preamble already loads it and configures page-breaking.
- `booktabs` rules (`\toprule`, `\midrule`, `\bottomrule`). No vertical rules.
- Header row is repeated on every page with `\endfirsthead` / `\endhead`. Skipping this on a `longtable` means the second-page rows appear with no column labels — wrong, even when the table happens to fit on one page in the current draft.
- Numbers align by decimal where it aids comparison (`siunitx` `S` column).

### 2.11 Units and quantities

- All physical quantities in prose, math, captions, and tables go through `siunitx`. No hand-typed `kg/s`, no `100\,\mathrm{W}`.
- Use `\num{}` for bare numbers that need formatting (thousands separators).

### 2.12 `tcolorbox`

- Use for callouts, notes, highlighted derivations.
- Always include `breakable` so boxes split across pages.

### 2.13 Appendices

- Long tables and full code listings live in the appendix.
- Reference each appendix item from the main text with `\autoref{}`. An appendix that is never referenced is dead weight — either reference it or cut it.

---

## 3. SSA writing style

**Applies to any project whose name contains "SSA". These rules override the general register when they conflict.** Voice rules in CLAUDE.md generally agree with what follows, with the explicit exception that first-person is allowed and expected here (CLAUDE.md flags this as the SSA exception).

### 3.1 Voice and person

First person throughout: "I did X", "I wrote Y", "I felt Z". When work was genuinely collaborative, name people and say who did what. Do not absorb others' contributions into "we" and do not undersell your own. Informal but substantive: "I reckon", "basically", "sort of", "in my view", "I guess" carry meaning about confidence and framing — do not suppress them. If something surprised you, or an approach was scrapped, say so and say why.

### 3.2 Directness

Lead with the finding, then explain. Do not build to a reveal. "Thermal storage is eliminated. Three independent arguments support this, each sufficient on its own" is the model — not three paragraphs of build-up landing on "therefore, thermal storage is eliminated." Especially in Details sections. Exception: derivations and process-heavy sections (CAD, coding, collaborative analysis) are naturally chronological and should stay that way.

### 3.3 Hedging

Natural hedging is welcome — "in practice", "roughly", "in principle", "at the time". Informal hedges ("I think", "tbh", "lowkey", "I reckon", "I feel that") are OK in process narration, transitions, and meta-commentary. They must vanish when you make a technical claim or run a formal argument. Never "I think the greedy policy might be optimal" — write "the greedy policy is provably optimal for a lossless store." Flag unexpected results explicitly: "Perhaps the core idea still works, but at the very least this specific configuration is probably not tenable."

### 3.4 Intuition before formalism

For any non-trivial concept, give the intuitive picture first, then the formal version. Not optional. The intuitive version should stand alone for someone skipping the maths. Then, if needed: "Formal argument." Never present a derivation or result without first explaining what it captures physically or geometrically.

### 3.5 Process transparency

The Summary especially should document how the work actually happened, including course corrections. "At the time, the plan was X. After the Wednesday meeting, Z was locked in" is exactly right. Do not sand the narrative into a clean linear story when reality was not linear. Show reasoning, not just conclusions. Cross-reference other SSAs explicitly by number: "Going back to SSA 3...", "Building on SSA 4...". Cross-reference figures with page numbers in long documents: "as seen in Figure 3 on pg. 5". It is fine to flag unfinished work at submission and to flag known bugs openly.

### 3.6 Motivation before method

WHY before HOW. "Since the first deadline was tight, I did most of this before the first meeting" tells the reader something. "I did the analysis in Python" without context tells them nothing. The reader must understand the design goal or problem before the method appears.

### 3.7 Numbers need immediate interpretation

Never leave a number dangling. Every figure is followed in the same sentence (or the next clause) by what it means in context: "74.8 GWh, clearly not realistic at any real scale"; "284.8 hours, which immediately rules out any technology limited to daily or weekly cycling." The number and its implication are one unit. Applies to derived quantities, experimental results, and design parameters alike.

### 3.8 Parenthetical asides

Natural parenthetical commentary, including informal practical remarks, is welcome. "(Uploading 417 charts individually wasn't working out so I used Claude to package it)" is the right register for the Summary. These ground the document in what actually happened.

### 3.9 Internal cross-referencing

Reference earlier sections when building on them. Do not re-derive, point back. "The six-month deficit established in Section 1" is fine and expected. The same holds across a series: "Going back to the analysis in an earlier SSA..."

### 3.10 Meta-commentary

Flagging why a section exists, what changed partway through, or what a result does or does not imply is a legitimate move: "A note on the utility of this section: by the time this was written, we had already decided on pumped hydro — but documenting the thermal storage reasoning is likely useful for future deliverables." Flag your own bugs and unresolved issues rather than hiding them.

### 3.11 Section-specific tone

- **Goals** — bullet points only. Outcome-oriented and precise. One sentence per goal. No padding.
- **Summary** — narrative, roughly chronological, reads like a lab notebook written by someone who can write. Dense but connected paragraphs. Documents how work actually unfolded, including pivots.
- **Conclusion / Recommendation** — tight. Lead with the recommendation or key result. No preamble. Numbers with context. Trade-offs stated plainly.
- **Problems Faced** — genuinely honest. If something was hard, say specifically what and why. "The derivation was difficult and tedious." "I ran out of time before finishing the implementation." "No significant problems were faced" is acceptable when true — but do not invent problems and do not sanitise real ones.
- **Future Work** — forward-looking and practical. Specific, not vague: not "refine the design" but "export as .dxf and .3mf, check the full assembly with the cart, make changes if necessary." May include work that was supposed to be in this SSA but was not finished, and things unrelated to the main topic.
- **Details / Content sections** — technical but readable. Always interpret figures and tables after presenting them. Never let a result sit without commentary. Process narration ("I first tried X, then messaged Y, and we concluded Z") is documentation, not padding.

### 3.12 References and citations (SSA)

All sources — papers, books, datasheets, Wikipedia, YouTube videos — go in `refs.bib` and are cited with `\cite{}`, appearing as `[1]`, `[2]`, etc. Never paste raw URLs into prose. The URL may appear in the bibliography entry but not in the running text. Every non-obvious factual claim needs a citation. Wikipedia is acceptable for definitions and overviews. Cite primary sources where available.

---

## 4. Common failure modes (negative examples)

### 4.1 AI-voice leaking in

Bad — generic AI register:

> It is important to note that thermal storage offers a number of significant advantages. Furthermore, this technology has been shown to play a key role in modern energy systems, highlighting its potential to revolutionize the field.

Why it is bad: "It is important to note", "a number of", "furthermore", "play a key role", "highlighting", "revolutionize" — every phrase is from the CLAUDE.md "phrases to avoid" list. Awe-marker stacking, no content.

Good — same point, SSA register:

> Thermal storage looked viable on paper: high round-trip efficiency at the scales documented in [3], and a low marginal cost above ~50 MWh. The first deadline made testing this in detail tight, and by the Wednesday meeting it was clear the cycling profile we actually needed (sub-daily, partial-state) was outside the operating envelope of every candidate in [3]–[5]. That is what eliminated it.

### 4.2 Number dangling

Bad:

> The system achieves 74.8 GWh of storage. This is a large value.

Good:

> The system would require 74.8 GWh of storage — roughly the daily consumption of a mid-sized European city, clearly not realistic at any real scale.

### 4.3 LaTeX that compiles but is wrong-shape

Bad:

```latex
The result is \mathbf{x} = 12.4 m/s as shown in Ref. \ref{fig:result}.
\[ y = \alpha x + \beta \]
```

Wrong on four counts: `\mathbf{}`, hand-typed units, bare `\ref{}` (and "Ref." prefix), `\[ \]`. Correct form:

```latex
The result is $x = \SI{12.4}{\meter\per\second}$ as shown in \autoref{fig:result}.
\begin{equation}
  y = \alpha x + \beta
  \label{eq:linear-model}
\end{equation}
```

### 4.4 Build broke and nobody noticed

If `compile_file` returned anything other than `✓ PDF written to ...`, the task is not done. Do not paper over a missing package or undefined reference by silently removing the line that triggered it — fix the underlying cause (missing `\usepackage{}`, missing `\label{}`, missing `refs.bib` entry).

---

## 5. When you are unsure

- Re-read this file (`get_context`) rather than guessing.
- Read the surrounding section before editing it.
- Read the preamble before adding a package.
- Run `compile_file` after every meaningful change, not only at the end.
- If a rule here conflicts with something the user just said in conversation, the user's most recent instruction wins — but flag the conflict explicitly so they can confirm.
