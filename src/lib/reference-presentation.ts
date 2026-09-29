import type { ReferenceItem } from './types';

export function referenceSummary(reference: ReferenceItem): string {
  return reference.parse_confidence === 'parsed' && reference.title?.trim()
    ? reference.title : reference.citation_text;
}

export function publicationVenue(venue: string | null): string {
  return (venue ?? '')
    // Stop at pagination: publisher/address details after it aren't the venue.
    .replace(/[,;]?\s*\b(?:pages?|pp?\.)\s*(?=\d|[–—-]).*$/i, '')
    .replace(/[,;]?\s*\d+\s*(?:\([^)]*\))?\s*:\s*[\d–—-].*$/, '')
    .replace(/[,;]\s*\d+\s*[–—-]\s*\d+\s*\.?$/, '')
    .replace(/^[\s,;.]+|[\s,;.]+$/g, '')
    .trim();
}

export function referencePublication(reference: { arxiv_id: string | null; venue: string | null }): string {
  return reference.arxiv_id ? `arxiv:${reference.arxiv_id}` : publicationVenue(reference.venue);
}
