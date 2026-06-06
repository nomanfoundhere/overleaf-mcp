#!/usr/bin/env node
// Example prose linter for overleaf-forge's `voice_lint` tool.
//
// Contract: take a file path as the last argument, print findings to stderr,
// exit 2 if anything was found and 0 if clean. `voice_lint` runs whatever
// command settings.voiceLinter (or $OVERLEAF_VOICE_LINTER) points at; this
// script is the bundled default so the tool works with no configuration.
//
// The checks are deliberately generic writing hygiene, chosen to rarely
// false-positive on LaTeX. Replace them with your own house style: copy this
// file, edit CHECKS, and point settings.voiceLinter at your copy
// (e.g. "node /path/to/your-linter.mjs").
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) process.exit(0);
let text;
try { text = readFileSync(file, 'utf8'); } catch { process.exit(0); }

// [regex, label]. Each is a documented, broadly-defensible prose check.
const CHECKS = [
  [/\b(TODO|FIXME|XXX)\b/,                              'leftover marker (TODO/FIXME/XXX)'],
  [/\b(\w+)\s+\1\b/i,                                   'repeated word'],
  [/\bin order to\b/i,                                  "wordy: 'in order to' -> 'to'"],
  [/\b(very|really|quite|basically|actually) \w/i,      'filler intensifier (often cuttable)'],
];

// Skip code/verbatim environments and comment lines so source does not false-positive.
const SKIP_BEGIN = /\\begin\{(lstlisting|verbatim|minted|Verbatim)\}/;
const SKIP_END   = /\\end\{(lstlisting|verbatim|minted|Verbatim)\}/;

const findings = [];
let skipping = false;
text.split(/\r?\n/).forEach((line, i) => {
  if (SKIP_BEGIN.test(line)) { skipping = true; return; }
  if (SKIP_END.test(line))   { skipping = false; return; }
  if (skipping || line.trimStart().startsWith('%')) return;
  for (const [rx, label] of CHECKS) {
    if (rx.test(line)) findings.push(`${i + 1}: ${label}\n    > ${line.trim().slice(0, 90)}`);
  }
});

if (findings.length) {
  process.stderr.write(
    `voice-lint (bundled example): ${findings.length} finding(s)\n` +
    findings.map(f => '  ' + f).join('\n') + '\n' +
    '(this is the generic example linter; set settings.voiceLinter for your own rules)\n',
  );
  process.exit(2);
}
process.exit(0);
