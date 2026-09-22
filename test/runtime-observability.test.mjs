import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observeTool, toolError, usageStats } from '../runtime-observability.js';

test.beforeEach(() => usageStats({ reset: true }));

test('records calls, duration, response bytes, cache hits, and failures without inputs', async () => {
  const observed = observeTool('render_pages', async input => ({ cacheHits: input.hits, content: 'done' }));
  const result = await observed({ hits: 2, secret: 'do-not-record' });
  assert.equal(result.cacheHits, 2);
  const stats = usageStats();
  assert.equal(stats.callCount, 1);
  assert.equal(stats.cacheHits, 2);
  assert.ok(stats.durationMs >= 0);
  assert.ok(stats.responseBytes > 0);
  assert.deepEqual(stats.byTool.render_pages, { callCount: 1, durationMs: stats.byTool.render_pages.durationMs, responseBytes: stats.responseBytes, cacheHits: 2, failures: 0 });
  assert.doesNotThrow(() => JSON.stringify(stats));
  assert.doesNotMatch(JSON.stringify(stats), /do-not-record|secret/);
});

test('records thrown failures and reset returns the previous snapshot', async () => {
  const observed = observeTool('broken', async () => { throw Object.assign(new Error('boom'), { code: 'INTERNAL' }); });
  await assert.rejects(observed(), /boom/);
  const snapshot = usageStats({ reset: true });
  assert.equal(snapshot.failures, 1);
  assert.equal(usageStats().callCount, 0);
});

test('classifies known failures, scrubs credentials, caps messages, and disables retries', () => {
  const result = toolError(Object.assign(new Error(`https://alice:super-secret@example.test/path ${'x'.repeat(2000)}`), { code: 'NETWORK' }));
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, 'NETWORK');
  assert.equal(result.structuredContent.error.retryable, true);
  assert.equal(result.structuredContent.error.maxAutomaticRetries, 0);
  assert.ok(result.structuredContent.error.message.length <= 1500);
  assert.doesNotMatch(result.structuredContent.error.message, /super-secret|alice/);
  assert.equal(toolError(new Error('merge conflict')).structuredContent.error.code, 'CONFLICT');
  assert.equal(toolError(Object.assign(new Error('Cannot find module x'), { code: 'MODULE_NOT_FOUND' })).structuredContent.error.code, 'MISSING_PACKAGE');
  assert.equal(toolError(new Error('nonsense')).structuredContent.error.code, 'INTERNAL');
});
