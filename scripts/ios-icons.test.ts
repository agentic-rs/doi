import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { syncIosIcons } from './ios-icons.ts';

function pngChunk(name: string, data: Buffer): Buffer {
  const bytes = Buffer.concat([Buffer.from(name), data]);
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, bytes, checksum]);
}

function makePng(width: number, height: number, color = 64): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = Buffer.alloc((width * 4 + 1) * height, color);
  for (let row = 0; row < height; row += 1) {
    rows[row * (width * 4 + 1)] = 0;
    for (let pixel = 0; pixel < width; pixel += 1) rows[row * (width * 4 + 1) + pixel * 4 + 4] = 255;
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(rows)), pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const temporary_directories: string[] = [];

function createIcons() {
  const directory = mkdtempSync(join(tmpdir(), 'papertrail-icons-test-'));
  temporary_directories.push(directory);
  const canonical_directory = join(directory, 'icons', 'ios');
  const apple_directory = join(directory, 'apple');
  const catalog_directory = join(apple_directory, 'Assets.xcassets', 'AppIcon.appiconset');
  mkdirSync(canonical_directory, { recursive: true });
  mkdirSync(catalog_directory, { recursive: true });
  const catalog = {
    images: [
      { filename: 'AppIcon-small.png', size: '1x1', scale: '2x', idiom: 'iphone' },
      { filename: 'AppIcon-large.png', size: '2x2', scale: '2x', idiom: 'ipad' },
    ],
    info: { version: 1, author: 'xcode' },
  };
  const catalog_file = join(catalog_directory, 'Contents.json');
  writeFileSync(catalog_file, JSON.stringify(catalog, null, 2));
  for (const [filename, size] of [['AppIcon-small.png', 2], ['AppIcon-large.png', 4]] as const) {
    writeFileSync(join(canonical_directory, filename), makePng(size, size));
    writeFileSync(join(catalog_directory, filename), makePng(size, size, 192));
  }
  return { canonical_directory, apple_directory, catalog_directory, catalog_file, catalog };
}

afterEach(() => {
  for (const directory of temporary_directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('iOS icon synchronization', () => {
  it('replaces generated default art with referenced canonical RGBA icons without changing the catalog', () => {
    const files = createIcons();
    const original_catalog = readFileSync(files.catalog_file);
    const original_source = readFileSync(join(files.canonical_directory, 'AppIcon-small.png'));
    expect(original_source[25]).toBe(6);
    const unreferenced = join(files.catalog_directory, 'Unreferenced.png');
    writeFileSync(unreferenced, 'leave untouched');
    expect(syncIosIcons(files.canonical_directory, files.apple_directory)).toEqual({ copied_count: 2, unchanged_count: 0 });
    for (const { filename } of files.catalog.images) {
      expect(readFileSync(join(files.catalog_directory, filename))).toEqual(readFileSync(join(files.canonical_directory, filename)));
    }
    expect(readFileSync(files.catalog_file)).toEqual(original_catalog);
    expect(readFileSync(join(files.canonical_directory, 'AppIcon-small.png'))).toEqual(original_source);
    expect(readFileSync(unreferenced, 'utf8')).toBe('leave untouched');
  });

  it('does not rewrite identical icons on repeated preparation', () => {
    const files = createIcons();
    syncIosIcons(files.canonical_directory, files.apple_directory);
    const destination = join(files.catalog_directory, 'AppIcon-small.png');
    const previous_date = new Date('2000-01-01T00:00:00Z');
    utimesSync(destination, previous_date, previous_date);
    expect(syncIosIcons(files.canonical_directory, files.apple_directory)).toEqual({ copied_count: 0, unchanged_count: 2 });
    expect(statSync(destination).mtimeMs).toBe(previous_date.getTime());
  });

  it.each(['missing', 'wrong size', 'not PNG'])('does not copy earlier icons if a later source is %s', (problem) => {
    const files = createIcons();
    const invalid_source = join(files.canonical_directory, 'AppIcon-large.png');
    if (problem === 'missing') rmSync(invalid_source);
    else writeFileSync(invalid_source, problem === 'wrong size' ? makePng(2, 2) : Buffer.from('not an image'));
    const previous_small = readFileSync(join(files.catalog_directory, 'AppIcon-small.png'));
    const previous_large = readFileSync(join(files.catalog_directory, 'AppIcon-large.png'));
    expect(() => syncIosIcons(files.canonical_directory, files.apple_directory)).toThrow();
    expect(readFileSync(join(files.catalog_directory, 'AppIcon-small.png'))).toEqual(previous_small);
    expect(readFileSync(join(files.catalog_directory, 'AppIcon-large.png'))).toEqual(previous_large);
  });

  it('supports the 83.5-point iPad slot and restores a missing destination image', () => {
    const files = createIcons();
    files.catalog.images[1].size = '83.5x83.5';
    writeFileSync(files.catalog_file, JSON.stringify(files.catalog));
    writeFileSync(join(files.canonical_directory, 'AppIcon-large.png'), makePng(167, 167));
    rmSync(join(files.catalog_directory, 'AppIcon-large.png'));
    expect(syncIosIcons(files.canonical_directory, files.apple_directory).copied_count).toBe(2);
    const copied = readFileSync(join(files.catalog_directory, 'AppIcon-large.png'));
    expect(copied.readUInt32BE(16)).toBe(167);
    expect(copied.readUInt32BE(20)).toBe(167);
  });

  it('rejects filenames outside the catalog before writing any icon', () => {
    const files = createIcons();
    files.catalog.images[1].filename = '../elsewhere.png';
    writeFileSync(files.catalog_file, JSON.stringify(files.catalog));
    const previous = readFileSync(join(files.catalog_directory, 'AppIcon-small.png'));
    expect(() => syncIosIcons(files.canonical_directory, files.apple_directory)).toThrow(/own directory/);
    expect(readFileSync(join(files.catalog_directory, 'AppIcon-small.png'))).toEqual(previous);
  });
});
