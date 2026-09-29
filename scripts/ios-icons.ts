import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const png_signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

interface IconSlot {
  filename?: unknown;
  size?: unknown;
  scale?: unknown;
}

interface IconCopy {
  source: Buffer;
  destination: string;
  changed: boolean;
}

function validateDimensions(source: Buffer, slot: IconSlot, filename: string): void {
  if (source.length < 33 || !source.subarray(0, 8).equals(png_signature)
    || source.readUInt32BE(8) !== 13 || source.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error(`The iOS icon ${filename} must be a PNG image.`);
  }
  const size = typeof slot.size === 'string' ? slot.size.match(/^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/) : null;
  const scale = typeof slot.scale === 'string' ? slot.scale.match(/^(\d+(?:\.\d+)?)x$/) : slot.scale === undefined ? ['1x', '1'] : null;
  if (!size || !scale) throw new Error(`The iOS icon catalog has an invalid size or scale for ${filename}.`);
  const width = Number(size[1]) * Number(scale[1]);
  const height = Number(size[2]) * Number(scale[1]);
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0
    || source.readUInt32BE(16) !== width || source.readUInt32BE(20) !== height) {
    throw new Error(`The iOS icon ${filename} must be ${width}×${height} pixels.`);
  }
  // RGBA is allowed: the canonical icons have an alpha channel with fully
  // opaque pixels. A channel's presence alone does not imply transparency.
}

export function syncIosIcons(canonical_directory: string, apple_directory: string): {
  copied_count: number;
  unchanged_count: number;
} {
  const catalog_directory = join(apple_directory, 'Assets.xcassets', 'AppIcon.appiconset');
  const catalog = JSON.parse(readFileSync(join(catalog_directory, 'Contents.json'), 'utf8')) as { images?: unknown };
  if (!Array.isArray(catalog.images)) throw new Error('The iOS app icon catalog must contain an images list.');
  const copies = new Map<string, IconCopy>();
  // Load and validate every referenced source before replacing any catalog
  // image. A missing/wrong-sized icon must not leave a partially updated set.
  for (const slot of catalog.images as IconSlot[]) {
    if (!slot || typeof slot !== 'object') throw new Error('The iOS app icon catalog contains an invalid image slot.');
    if (slot.filename === undefined) continue;
    const filename = slot.filename;
    if (typeof filename !== 'string' || filename !== basename(filename) || filename.includes('\\') || !filename.endsWith('.png')) {
      throw new Error('The iOS app icon catalog must reference PNG filenames in its own directory.');
    }
    const source = readFileSync(join(canonical_directory, filename));
    validateDimensions(source, slot, filename);
    const destination = join(catalog_directory, filename);
    let previous: Buffer | undefined;
    try {
      previous = readFileSync(destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    copies.set(filename, { source, destination, changed: !previous?.equals(source) });
  }
  if (copies.size === 0) throw new Error('The iOS app icon catalog does not reference any PNG images.');
  let copied_count = 0;
  for (const copy of copies.values()) {
    if (!copy.changed) continue;
    writeFileSync(copy.destination, copy.source);
    copied_count += 1;
  }
  return { copied_count, unchanged_count: copies.size - copied_count };
}
