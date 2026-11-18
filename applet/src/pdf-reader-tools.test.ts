import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import init, { hashBytes } from '../generated/doi_ai';
import { createPdfReaderTools } from './pdf-reader-tools';
import { makePdf } from './test-pdf';

const file = vi.hoisted(() => ({ bytes: new Uint8Array(), pdf_hash: '', read: vi.fn() }));
vi.mock('./store', () => ({ store: { transaction: (run: (db: unknown) => Promise<unknown>) => run({
  get: () => ({ paths: ['papers/fixture/0'], size_bytes: file.bytes.length }),
}) } }));
vi.mock('./library', () => ({ requirePaper: () => ({ pdf_hash: file.pdf_hash }) }));
vi.mock('../vendor/apell-sdk', () => ({ fs: { read: file.read } }));

const readers: ReturnType<typeof createPdfReaderTools>[] = [];
function readerFor(contents: string[][]) {
  file.bytes = makePdf(contents);
  file.pdf_hash = hashBytes(file.bytes);
  const reader = createPdfReaderTools({ paper_id: 'fixture', pdf_hash: file.pdf_hash });
  readers.push(reader);
  return reader;
}
const signal = new AbortController().signal;
beforeAll(async () => { await init({ module_or_path: readFileSync('applet/generated/doi_ai_bg.wasm') }); });
beforeEach(() => { file.read.mockReset().mockImplementation(async () => ({ bytes: file.bytes })); });
afterEach(async () => { await Promise.all(readers.splice(0).map(reader => reader.close())); });

it('lazily searches the local revision and returns the same anchored quote as reading its page', async () => {
  const reader = readerFor([['An introduction.'], ['Proof of the result.', 'The normalized variance is v/n.'], []]);
  expect(file.read).not.toHaveBeenCalled();
  const result = await reader.execute({ name: 'search_document', query: 'NORMALIZED variance' }, signal);
  expect(result.passages).toHaveLength(1);
  const [source] = result.passages;
  expect(source.page_number).toBe(2);
  expect(source.text_quote.exact_text).toContain('The normalized variance is v/n.');
  expect(source.quad_points).toHaveLength(2);
  const [x,y,right,top,,,left,bottom] = source.quad_points[0];
  expect([x,left]).toEqual([40,40]); expect(right).toBeGreaterThan(40);
  expect(y).toBe(top); expect(top).toBeGreaterThan(740); expect(bottom).toBeLessThan(740);
  expect((await reader.execute({ name: 'read_page', page_number: 2 }, signal)).passages).toEqual([source]);
  expect(await reader.execute({ name: 'read_page', page_number: 3 }, signal)).toMatchObject({ passages: [], message: expect.stringContaining('no readable text') });
  expect(file.read).toHaveBeenCalledTimes(1);
  await reader.close();
  await expect(reader.execute({ name: 'read_page', page_number: 1 }, signal)).rejects.toThrow('ended');
});

it('limits and pages long text, searches across excerpt boundaries, and treats punctuation literally', async () => {
  const lines = Array.from({ length: 31 }, (_, i) => `Sentence ${i + 1}.`);
  const reader = readerFor([lines]);
  const first = await reader.execute({ name: 'read_page', page_number: 1 }, signal);
  expect(first.passages).toHaveLength(4);
  expect(first.message).toContain('offset 4');
  const next = await reader.execute({ name: 'read_page', page_number: 1, offset: 4 }, signal);
  expect(next.passages[0]).not.toEqual(first.passages[0]);
  const spanning = first.passages[0].text_quote.exact_text.split(' ').at(-1) + ' ' + first.passages[1].text_quote.exact_text.split(' ').slice(0,2).join(' ');
  expect((await reader.execute({ name: 'search_document', query: spanning }, signal)).passages).toEqual(first.passages.slice(0,2));
  expect((await reader.execute({ name: 'search_document', query: '.*' }, signal)).passages).toEqual([]);
  await expect(reader.execute({ name: 'read_page', page_number: 0 }, signal)).rejects.toThrow('start at 1');
  await expect(reader.execute({ name: 'read_page', page_number: 1, offset: 100 }, signal)).rejects.toThrow('offsets start at 0');
  await expect(reader.execute({ name: 'search_document', query: '   ' }, signal)).rejects.toThrow('phrase');
});

it('continues a bounded search past page 24 and never reads another revision', async () => {
  const reader = readerFor([...Array.from({ length: 24 }, () => []), ['Only on the last page.']]);
  const result = await reader.execute({ name: 'search_document', query: 'last page' }, signal);
  expect(result.passages).toEqual([]);
  expect(result.message).toContain('start_page 25');
  expect((await reader.execute({ name: 'search_document', query: 'last page', start_page: 25 }, signal)).passages[0].page_number).toBe(25);
  const stale = readerFor([['Original.']]);
  file.pdf_hash = 'a'.repeat(64);
  await expect(stale.execute({ name: 'read_page', page_number: 1 }, signal)).rejects.toThrow('different revision');
  const damaged = readerFor([['Original.']]);
  file.bytes[0] ^= 1;
  await expect(damaged.execute({ name: 'read_page', page_number: 1 }, signal)).rejects.toThrow('integrity check');
});

it('stops a pending file read immediately and never opens PDF.js after cancellation', async () => {
  const reader = readerFor([['Source.']]);
  const controller = new AbortController();
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  file.read.mockImplementation(async () => { started(); await new Promise<void>(resolve => { release = resolve; }); return { bytes: file.bytes }; });
  const pending = reader.execute({ name: 'read_page', page_number: 1 }, controller.signal);
  await ready;
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  release();
  await expect(reader.execute({ name: 'read_page', page_number: 1 }, signal)).rejects.toThrow('ended');
});
