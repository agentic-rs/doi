import type { ReferenceItem } from './types';

function folded(value: string): string { return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase(); }
function escaped(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

export function referencesForText(text: string, references: ReferenceItem[]): ReferenceItem[] {
  const ids = new Set<string>();
  const labels = new Map<string, ReferenceItem[]>();
  for (const item of references) {
    if (item.label) labels.set(item.label, [...labels.get(item.label) ?? [], item]);
  }
  const add = (label: string) => {
    const matches = labels.get(label);
    if (matches?.length === 1) ids.add(matches[0].reference_id);
  };
  for (const group of text.matchAll(/\[([^\]\n]{1,100})\]/g)) {
    // Explicit equation/figure references are not bibliography citations.
    if (/(?:eq(?:uation)?s?|fig(?:ure)?s?|tables?|sections?)\.?\s*$/i.test(text.slice(Math.max(0, group.index! - 24), group.index))) continue;
    for (const part of group[1].split(/[,;]\s*/)) {
      const range = part.trim().match(/^(\d{1,4})\s*[-–—]\s*(\d{1,4})$/);
      if (range) {
        const first = Number(range[1]); const last = Number(range[2]);
        if (last >= first && last - first <= 100) for (let label = first; label <= last; label += 1) add(String(label));
      } else add(part.trim());
    }
  }
  const normalized = folded(text);
  const author_matches = new Map<string, ReferenceItem[]>();
  for (const item of references) {
    if (!item.authors.length || !item.publication_year) continue;
    const surname = folded(item.authors[0].split(/\s+/).at(-1)!.replace(/[.,]+$/, ''));
    if (surname.length < 2) continue;
    const key = `${surname}:${item.publication_year}`;
    author_matches.set(key, [...author_matches.get(key) ?? [], item]);
  }
  for (const [key, matches] of author_matches) {
    if (matches.length !== 1) continue;
    const [surname, year] = key.split(':');
    // Require a citation-shaped span: Smith (2020), Smith et al., 2020,
    // or Smith and Jones, 2020. Arbitrary prose between name/year is excluded.
    const pattern = new RegExp(`\\b${escaped(surname)}(?:\\s+et\\s+al\\.?|\\s+(?:and|&)\\s+[\\p{L}'’-]+)?\\s*[,([]\\s*${escaped(year)}\\b`, 'u');
    if (pattern.test(normalized)) ids.add(matches[0].reference_id);
  }
  return references.filter((item) => ids.has(item.reference_id));
}

export function referenceAtDestination(references: ReferenceItem[], page_number: number, point: [number, number]): ReferenceItem | null {
  const matches = references.filter((item) => {
    if (item.page_number !== page_number || !item.source_rect) return false;
    const [left, bottom, right, top] = item.source_rect;
    return point[0] >= left - 8 && point[0] <= right + 3 && point[1] >= bottom - 2 && point[1] <= top + 8;
  });
  return matches.length === 1 ? matches[0] : null;
}
