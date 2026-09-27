import type { ReferenceItem } from './types';
import { normalizePdfText, safeReferenceUrl } from './pdf-geometry';

export interface PageText {
  page_number: number;
  text: string;
}

const arxiv_pattern = /(?:arxiv\s*:\s*|arxiv\.org\/(?:abs|pdf)\/|\babs\/)((?:\d{4}\.\d{4,5}|[a-z][a-z.\-]+\/\d{7})(?:v\d+)?)/i;
const doi_pattern = /\b(10\.\d{4,9}\/[\w./:;()\-]+)\b/i;
const url_pattern = /https?:\/\/[^\s<>]+/i;
const heading_pattern = /^(?:\d+\.?\s+)?(?:references|bibliography|literature cited)\s*$/i;
const end_pattern = /^(?:appendix\b|attention visualizations\b|supplement(?:ary|al)\b|acknowledg(?:e)?ments\b|author biographies\b|[A-Z]\.?\s+(?:proof|additional|supplementary)\b)/i;

function cleanIdentifier(value: string): string {
  return value.replace(/[.,;:]+$/, '');
}

export function referenceFromText(citation_text: string, page_number: number, index: number): ReferenceItem | null {
  const text = normalizePdfText(citation_text);
  const arxiv_id = text.match(arxiv_pattern)?.[1] ?? null;
  const doi = text.match(doi_pattern)?.[1] ?? null;
  const raw_url = text.match(url_pattern)?.[0];
  const url = raw_url ? safeReferenceUrl(cleanIdentifier(raw_url)) : null;
  if (text.length < 12 && !arxiv_id && !doi && !url) return null;
  return {
    reference_id: `reference-${page_number}-${index}`,
    citation_text: text,
    page_number,
    arxiv_id: arxiv_id ? cleanIdentifier(arxiv_id) : null,
    doi: doi ? cleanIdentifier(doi) : null,
    url,
  };
}

/** Numbered bibliography extraction with a conservative URL/identifier fallback. */
export function extractReferences(pages: PageText[]): ReferenceItem[] {
  const references: ReferenceItem[] = [];
  const bibliography_lines: PageText[] = [];
  const has_heading = pages.some((page) => page.text.split(/\r?\n/).some((line) => heading_pattern.test(line.trim())));
  let bibliography = false;
  let current: { text: string; page_number: number } | null = null;
  const flush = () => {
    if (!current) return;
    const reference = referenceFromText(current.text, current.page_number, references.length);
    if (reference) references.push(reference);
    current = null;
  };

  for (const page of pages) {
    const lines = page.text.split(/\r?\n/);
    for (const raw_line of lines) {
      const line = raw_line.trim();
      if (heading_pattern.test(line)) {
        bibliography = true;
        continue;
      }
      if (bibliography && end_pattern.test(line)) {
        flush();
        bibliography = false;
      }
      if (!bibliography) continue;
      bibliography_lines.push({ page_number: page.page_number, text: line });
      if (/^(?:\[\d{1,4}\]|\d{1,4}[.)])\s*\S/.test(line)) {
        flush();
        current = { text: line, page_number: page.page_number };
      } else if (current && line && !/^\d+$/.test(line)) {
        current.text += ` ${line}`;
      }
    }
  }
  flush();
  // A parsed bibliography is authoritative. Links elsewhere in a paper may be
  // code repositories or datasets and shouldn't masquerade as citations.
  if (references.length) return references;

  // Some papers use author/year references or have no identifiable heading.
  // Only identifiable links become fallback entries; ordinary body lines don't.
  const seen = new Set(references.map((reference) => reference.arxiv_id ?? reference.doi ?? reference.url).filter(Boolean));
  for (const page of has_heading ? bibliography_lines : pages) {
    const lines = page.text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!arxiv_pattern.test(line) && !doi_pattern.test(line) && !url_pattern.test(line)) continue;
      const citation = `${lines[index - 1] ?? ''} ${line} ${lines[index + 1] ?? ''}`;
      const reference = referenceFromText(citation, page.page_number, references.length);
      const key = reference?.arxiv_id ?? reference?.doi ?? reference?.url;
      if (reference && key && !seen.has(key)) {
        seen.add(key);
        references.push(reference);
      }
    }
  }
  return references;
}
