import { WorkerMessageHandler } from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs';
import assets from '../generated/pdf-assets.json';

// Apell forbids worker URLs and network fetches. PDF.js supports an in-process
// worker handler; its asynchronous protocol remains intact on the main thread.
Object.assign(globalThis, { pdfjsWorker: { WorkerMessageHandler } });

class EmbeddedBinaryDataFactory {
  async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
    const directory = { cMapUrl: 'cmaps', standardFontDataUrl: 'standard_fonts', wasmUrl: 'wasm' }[kind];
    const value = (assets as Record<string, string>)[`${directory}/${filename}`];
    if (!value) throw new Error(`Missing embedded PDF asset: ${filename}`);
    return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  }
}

export const pdf_options = {
  BinaryDataFactory: EmbeddedBinaryDataFactory,
  useWorkerFetch: false,
  isEvalSupported: false,
  // The opaque applet cannot load blob font URLs under the host's CSP.
  disableFontFace: true,
  cMapPacked: true,
};
