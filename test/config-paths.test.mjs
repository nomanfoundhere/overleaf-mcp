import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveDataHome, synthesizeConfigFromEnv } from '../overleaf-mcp-server.js';

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
