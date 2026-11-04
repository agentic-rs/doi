import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { pdf_options } from './pdf';

function samplePdf() {
  const stream = 'BT /F1 24 Tf 30 110 Td (Paper Reader in Apell) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 160] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let text = '%PDF-1.4\n';
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(text.length);
    text += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = text.length;
  text += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(text);
}

it('renders and extracts text with embedded font data and no worker URL or asset fetch', async () => {
  const require = createRequire(import.meta.url);
  const canvas_module = require(require.resolve('@napi-rs/canvas', { paths: [require.resolve('pdfjs-dist/package.json')] })) as {
    createCanvas: (width: number, height: number) => HTMLCanvasElement & { toBuffer: (format: string) => Buffer };
  };
  const task = getDocument({ data: samplePdf(), ...pdf_options });
  const document = await task.promise;
  try {
    const page = await document.getPage(1);
    const text = await page.getTextContent();
    expect(text.items.map((item) => 'str' in item ? item.str : '').join('')).toBe('Paper Reader in Apell');
    const viewport = page.getViewport({ scale: 2 });
    const canvas = canvas_module.createCanvas(viewport.width, viewport.height);
    await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport }).promise;
    const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
    expect(pixels.filter((value, index) => index % 4 !== 3 && value < 128).length).toBeGreaterThan(100);
    writeFileSync('artifacts/pdf-smoke.png', canvas.toBuffer('image/png'));
  } finally { await task.destroy(); }
});
