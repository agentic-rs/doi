import { safeReferenceUrl } from './pdf-geometry';
import { arxivIdFromUrl } from './pdf-references';
import type { PaperUrlTarget, ReferenceItem } from './types';

export function classifyPaperUrl(value: string): PaperUrlTarget | null {
  const url = safeReferenceUrl(value);
  if (!url) return null;
  const arxiv_id = arxivIdFromUrl(url);
  return arxiv_id ? { kind: 'app', arxiv_id, url } : { kind: 'external', url };
}

export function referenceLinkTarget(reference: Pick<ReferenceItem, 'arxiv_id' | 'doi' | 'url'>): PaperUrlTarget | null {
  const url = reference.arxiv_id ? `https://arxiv.org/abs/${reference.arxiv_id}`
    : reference.doi ? `https://doi.org/${reference.doi}` : reference.url;
  return url ? classifyPaperUrl(url) : null;
}
