import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { renderPages } from '../render-cache.js';

function pdfBytes(pageCount = 1) {
  const bodies = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${Array.from({ length: pageCount }, (_, i) => `${3 + i * 2} 0 R`).join(' ')}] /Count ${pageCount} >>`,
  ];
  for (let i = 0; i < pageCount; i += 1) {
    bodies.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] /Contents ${4 + i * 2} 0 R >>`);
    bodies.push('<< /Length 0 >>\nstream\n\nendstream');
  }
  const chunks = ['%PDF-1.4\n'];
  const offsets = [0];
  bodies.forEach((body, i) => {
    offsets.push(Buffer.byteLength(chunks.join('')));
    chunks.push(`${i + 1} 0 obj\n${body}\nendobj\n`);
  });
  const xref = Buffer.byteLength(chunks.join(''));
  chunks.push(`xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.from(chunks.join(''));
}

async function makeFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'render-cache-test-'));
  const cacheDir = path.join(root, 'cache');
  await writeFile(path.join(root, 'fixture.pdf'), pdfBytes(2));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, cacheDir, filePath: 'fixture.pdf' };
}

test('renders requested pages and reuses exact PDF/page/DPI cache entries', async t => {
  const fixture = await makeFixture(t);
  const first = await renderPages(fixture.root, { ...fixture, pages: [1], dpi: 90 });
  assert.equal(first.cacheHits, 0);
  assert.equal(first.files.length, 1);
  assert.match(first.files[0], /\.png$/);
  assert.ok((await readFile(first.files[0])).length > 100);

  const second = await renderPages(fixture.root, { ...fixture, pages: [1], dpi: 90 });
  assert.equal(second.cacheHits, 1);
  assert.deepEqual(second.files, first.files);
});

test('changed PDF content invalidates the requested page cache', async t => {
  const fixture = await makeFixture(t);
  const first = await renderPages(fixture.root, { ...fixture, pages: [1] });
  await writeFile(path.join(fixture.root, fixture.filePath), pdfBytes(2).subarray(0, -1));
  const second = await renderPages(fixture.root, { ...fixture, pages: [1] });
  assert.equal(second.cacheHits, 0);
  assert.notEqual(second.files[0], first.files[0]);
});

test('rejects invalid pages and project escaping paths', async t => {
  const fixture = await makeFixture(t);
  await assert.rejects(renderPages(fixture.root, { ...fixture, pages: [0] }), /positive integers/);
  await assert.rejects(renderPages(fixture.root, { ...fixture, filePath: '../outside.pdf', pages: [1] }), /inside project/);
});
