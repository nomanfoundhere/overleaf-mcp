import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveDataHome, synthesizeConfigFromEnv, mergeSettings } from '../overleaf-mcp-server.js';

const HOMEDIR_M = '/home/user';

const HOME = '/home/user';
const PKG = '/opt/pkg';

// --- resolveDataHome precedence: env override → package dir → ~/.overleaf-mcp ---

test('resolveDataHome: $OVERLEAF_MCP_HOME wins over everything', () => {
  const home = resolveDataHome({
    env: { OVERLEAF_MCP_HOME: '/custom/home' },
    packageDir: PKG, homeDir: HOME, hasPackageConfig: true,
  });
  assert.equal(home, '/custom/home');
});

test('resolveDataHome: ~ in the override expands to the real home', () => {
  const home = resolveDataHome({
    env: { OVERLEAF_MCP_HOME: '~/mcp-data' },
    packageDir: PKG, homeDir: HOME, hasPackageConfig: false,
  });
  assert.equal(home, path.join(HOME, 'mcp-data'));
});

test('resolveDataHome: existing package projects.json keeps state in the package dir', () => {
  // Backward compat: an existing local clone must not move its config.
  const home = resolveDataHome({
    env: {}, packageDir: PKG, homeDir: HOME, hasPackageConfig: true,
  });
  assert.equal(home, PKG);
});

test('resolveDataHome: fresh install (no package config, no override) → ~/.overleaf-mcp', () => {
  const home = resolveDataHome({
    env: {}, packageDir: PKG, homeDir: HOME, hasPackageConfig: false,
  });
  assert.equal(home, path.join(HOME, '.overleaf-mcp'));
});

test('resolveDataHome: blank/whitespace override is ignored', () => {
  const home = resolveDataHome({
    env: { OVERLEAF_MCP_HOME: '   ' },
    packageDir: PKG, homeDir: HOME, hasPackageConfig: false,
  });
  assert.equal(home, path.join(HOME, '.overleaf-mcp'));
});

// --- synthesizeConfigFromEnv: env-only single-project mode ----------------------

const REPOS = '/home/user/.overleaf-mcp/repos';

test('synthesizeConfigFromEnv: returns null without both token and project id', () => {
  assert.equal(synthesizeConfigFromEnv({}, REPOS), null);
  assert.equal(synthesizeConfigFromEnv({ OVERLEAF_GIT_TOKEN: 't' }, REPOS), null);
  assert.equal(synthesizeConfigFromEnv({ OVERLEAF_PROJECT_ID: 'p' }, REPOS), null);
});

test('synthesizeConfigFromEnv: token + project id yields a single default project', () => {
  const cfg = synthesizeConfigFromEnv(
    { OVERLEAF_GIT_TOKEN: 'olp_x', OVERLEAF_PROJECT_ID: 'abc123' },
    REPOS,
  );
  assert.equal(cfg.settings.gitToken, 'olp_x');
  assert.equal(cfg.settings.repoDir, REPOS);
  assert.equal(cfg.projects.default.projectId, 'abc123');
  assert.equal(cfg.projects.default.name, 'Overleaf Project');
  assert.equal(cfg.projects.default.localPath, path.join(REPOS, 'default'));
});

test('synthesizeConfigFromEnv: OVERLEAF_PROJECT_NAME overrides the default name', () => {
  const cfg = synthesizeConfigFromEnv(
    { OVERLEAF_GIT_TOKEN: 't', OVERLEAF_PROJECT_ID: 'p', OVERLEAF_PROJECT_NAME: 'My Thesis' },
    REPOS,
  );
  assert.equal(cfg.projects.default.name, 'My Thesis');
});

// --- mergeSettings: the configure tool's merge + ~ expansion ---

test('mergeSettings: only provided keys change, others preserved', () => {
  const cur = { repoDir: '/r', academicRoot: '/a', gitToken: 'tok' };
  const { settings, provided } = mergeSettings(cur, { ssaSubdir: 'MY SSAs' }, HOMEDIR_M);
  assert.deepEqual(provided, ['ssaSubdir']);
  assert.equal(settings.ssaSubdir, 'MY SSAs');
  assert.equal(settings.repoDir, '/r');
  assert.equal(settings.gitToken, 'tok');
});

test('mergeSettings: no args changes nothing', () => {
  const cur = { repoDir: '/r' };
  const { settings, provided } = mergeSettings(cur, {}, HOMEDIR_M);
  assert.deepEqual(provided, []);
  assert.deepEqual(settings, cur);
});

test('mergeSettings: ~ expands for path fields, not for command/name fields', () => {
  const { settings } = mergeSettings({}, {
    templatesDir: '~/tpl', repoDir: '~/repos', academicRoot: '~/school',
    voiceLinter: '~/bin/lint.sh --flag', ssaSubdir: 'MY SSAs',
  }, HOMEDIR_M);
  assert.equal(settings.templatesDir, path.join(HOMEDIR_M, 'tpl'));
  assert.equal(settings.repoDir, path.join(HOMEDIR_M, 'repos'));
  assert.equal(settings.academicRoot, path.join(HOMEDIR_M, 'school'));
  assert.equal(settings.voiceLinter, '~/bin/lint.sh --flag'); // command: left as-is
  assert.equal(settings.ssaSubdir, 'MY SSAs');
});

test('mergeSettings: empty string clears a field (revert to bundled default)', () => {
  const { settings, provided } = mergeSettings({ templatesDir: '/old' }, { templatesDir: '' }, HOMEDIR_M);
  assert.deepEqual(provided, ['templatesDir']);
  assert.equal(settings.templatesDir, '');
});

test('mergeSettings: unknown keys are ignored', () => {
  const { settings, provided } = mergeSettings({}, { bogus: 'x', repoDir: '/r' }, HOMEDIR_M);
  assert.deepEqual(provided, ['repoDir']);
  assert.equal(settings.bogus, undefined);
});
