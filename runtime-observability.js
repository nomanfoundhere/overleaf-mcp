const totals = {
  callCount: 0,
  durationMs: 0,
  responseBytes: 0,
  cacheHits: 0,
  failures: 0,
  byTool: {},
};

const ERROR_CODES = new Map([
  ['LOCAL_CLONE', { retryable: false, nextAction: 'Check the local clone path and synchronize the project explicitly.' }],
  ['CONFLICT', { retryable: false, nextAction: 'Resolve the repository conflict, then retry the requested operation.' }],
  ['STALE_SOURCE', { retryable: false, nextAction: 'Read the latest revision and affected files before preparing a new batch.' }],
  ['BUILD_FAILED', { retryable: false, nextAction: 'Inspect the build log and correct the reported failure before rebuilding.' }],
  ['NETWORK', { retryable: true, nextAction: 'Check the network connection and retry when the service is reachable.' }],
  ['MISSING_PACKAGE', { retryable: false, nextAction: 'Install the missing package or dependency, then retry.' }],
  ['INVALID_INPUT', { retryable: false, nextAction: 'Correct the input arguments and retry.' }],
  ['INTERNAL', { retryable: false, nextAction: 'Inspect the server logs for the underlying failure.' }],
]);

const scrub = value => String(value)
  .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, '$1***@')
  .replace(/\bgit:[^\s/@]+@/gi, 'git:***@')
  .slice(0, 1500);

function classify(error) {
  const rawCode = String(error?.code ?? '').toUpperCase();
  if (ERROR_CODES.has(rawCode)) return rawCode;
  if (/^STALE_/.test(rawCode)) return 'STALE_SOURCE';
  if (/^VERIFICATION_/.test(rawCode)) return 'BUILD_FAILED';
  if (/^INVALID_|SYMLINK_PATH|DUPLICATE_PATH/.test(rawCode)) return 'INVALID_INPUT';
  if (rawCode === 'DIRTY_CHECKOUT') return 'CONFLICT';
  const text = `${rawCode} ${error?.message ?? error}`.toLowerCase();
  if (/local.?clone|clone failed|clone path|repository clone/.test(text)) return 'LOCAL_CLONE';
  if (/conflict|non-fast-forward|merge conflict/.test(text)) return 'CONFLICT';
  if (/network|econn|etimedout|enotfound|enetunreach|ehostunreach|fetch failed|socket/.test(text)) return 'NETWORK';
  if (/missing package|module_not_found|cannot find module|package .*not found/.test(text)) return 'MISSING_PACKAGE';
  if (/invalid input|invalid argument|bad argument|validation|must be|expected .* but/.test(text)) return 'INVALID_INPUT';
  return 'INTERNAL';
}

const responseBytes = result => {
  try {
    return Buffer.byteLength(JSON.stringify(result) ?? String(result), 'utf8');
  } catch {
    return Buffer.byteLength(String(result), 'utf8');
  }
};

function blankStats() {
  return { callCount: 0, durationMs: 0, responseBytes: 0, cacheHits: 0, failures: 0, byTool: {} };
}

export function usageStats({ reset = false } = {}) {
  const snapshot = structuredClone(totals);
  if (reset) {
    Object.assign(totals, blankStats());
  }
  return snapshot;
}

function record(name, elapsed, result, failed) {
  const tool = totals.byTool[name] ??= { callCount: 0, durationMs: 0, responseBytes: 0, cacheHits: 0, failures: 0 };
  const bytes = responseBytes(result);
  const hits = failed ? 0 : Number(result?.cacheHits ?? result?.structuredContent?.cacheHits ?? (result?.structuredContent?.reused || result?.structuredContent?.unchanged ? 1 : 0));
  const safeHits = Number.isFinite(hits) && hits > 0 ? hits : 0;
  for (const target of [totals, tool]) {
    target.callCount += 1;
    target.durationMs += elapsed;
    target.responseBytes += bytes;
    target.cacheHits += safeHits;
    if (failed) target.failures += 1;
  }
}

export function observeTool(name, asyncFn) {
  if (typeof name !== 'string' || !name) throw new TypeError('tool name is required');
  if (typeof asyncFn !== 'function') throw new TypeError('asyncFn must be a function');
  return async function observedTool(...args) {
    const started = performance.now();
    try {
      const result = await asyncFn.apply(this, args);
      record(name, performance.now() - started, result, result?.isError === true || result?.structuredContent?.pass === false);
      return result;
    } catch (error) {
      record(name, performance.now() - started, null, true);
      throw error;
    }
  };
}

export function toolError(error) {
  const code = classify(error);
  const policy = ERROR_CODES.get(code);
  const message = scrub(error?.message ?? error);
  return {
    isError: true,
    content: [{ type: 'text', text: `Error: ${message}` }],
    structuredContent: {
      error: {
        code,
        message,
        retryable: policy.retryable,
        nextAction: policy.nextAction,
        maxAutomaticRetries: 0,
      },
    },
  };
}
