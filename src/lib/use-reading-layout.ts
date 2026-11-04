import { useCallback, useEffect, useState } from 'react';
import type { PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { ReadingLayout } from './types';
import { buildReadingLayout, READING_LAYOUT_VERSION } from './reading-layout';
import { getReadingLayout, nativeAvailable, saveReadingLayout } from './backend';

export function useReadingLayout(pages: PDFPageProxy[] | null, pdf_hash: string, paper_id: string, enabled: boolean) {
  const [cached, setCached] = useState<{ pages: PDFPageProxy[]; layout: ReadingLayout } | null>(null);
  const [progress, setProgress] = useState({ completed: 0, total: 0 });
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const layout = cached?.pages === pages ? cached.layout : null;
  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    if (!enabled || !pages || layout) return;
    const controller = new AbortController();
    const { signal } = controller;
    setError(null);
    setProgress({ completed: 0, total: pages.length });
    void (async () => {
      // A cache failure must not make an otherwise readable paper unavailable.
      const saved = nativeAvailable() ? await getReadingLayout(paper_id, READING_LAYOUT_VERSION).catch(() => null) : null;
      if (signal.aborted) return;
      const result = saved?.layout_version === READING_LAYOUT_VERSION && saved.pdf_hash === pdf_hash && saved.page_count === pages.length ? saved
        : await buildReadingLayout(pages, pdf_hash, signal, (completed, total) => {
          if (!signal.aborted) setProgress({ completed, total });
        });
      if (signal.aborted) return;
      setCached({ pages, layout: result });
      if (result !== saved && nativeAvailable()) void saveReadingLayout(paper_id, result).catch(() => undefined);
    })().catch((failure: unknown) => {
      if (!signal.aborted) setError(failure instanceof Error ? failure.message : String(failure));
    });
    return () => controller.abort();
  }, [enabled, pages, paper_id, pdf_hash, layout, attempt]);

  return { layout, progress, error, retry };
}
