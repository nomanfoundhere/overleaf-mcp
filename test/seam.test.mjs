import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OverleafGitClient } from '../overleaf-mcp-server.js';

test('class is importable without launching the server', () => {
  const c = new OverleafGitClient('id123', 'tok', '/tmp/x', '/tmp/fake-remote');
  assert.equal(c.gitUrl, '/tmp/fake-remote');          // override wins
});

test('gitUrl defaults to the Overleaf URL when no override', () => {
  const c = new OverleafGitClient('id123', 'tok', '/tmp/x');
  assert.equal(c.gitUrl, 'https://git.overleaf.com/id123');
});
