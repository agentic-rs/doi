import type { ReferenceItem } from './types';

function folded(value: string): string {
  // PDF fonts sometimes emit a detached accent as D´efossez or D ◌́efossez.
  // Repair only attached marks or a separated mark after one capital letter;
  // ordinary whitespace between words must remain a citation boundary.
  return value.replace(/(?<=\p{L})[`´](?=\p{L})/gu, '')
    .replace(/(?<![\p{L}\p{M}])(\p{Lu})[ \t]+[`´\u0300\u0301](?=\p{Ll})/gu, '$1')
    .normalize('NFKD')
    .replace(/\u00ad(?:[ \t]*\r?\n[ \t]*)?/g, '')
    .replace(/([\p{L}])-[ \t]*\r?\n[ \t]*(?=[\p{Ll}])/gu, '$1')
    .replace(/\p{M}/gu, '').replace(/[‘’ʼ]/g, "'").toLowerCase();
}
function escaped(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function surnameWords(author: string): string[] {
  const name = folded(author).replace(/\s+et\s+al\.?\s*$/u, '').split(',')[0].replace(/[.\s]+$/, '');
  const words = name.split(/\s+/);
  const surname = words.pop();
  if (!surname || surname.length < 2 || !/^[\p{L}][\p{L}'-]*$/u.test(surname)) return [];
  const parts = [surname];
  while (words.length && /^(?:van|von|de|del|der|den|da|di|dos|du|la|le|al|ten|ter)$/u.test(words.at(-1)!)) parts.unshift(words.pop()!);
  return parts;
}

function pairedAuthorPattern(item: ReferenceItem): string {
  const surname = surnameWords(item.authors[1] ?? '');
  if (!surname.length) return '';
  const last = escaped(surname.at(-1)!);
  // Multiword surnames are only accepted when those particles occur in the
  // actual second author, never as arbitrary prose between name and year.
  const particles = surname.slice(0, -1).map(escaped).join('\\s+');
  return `\\s+(?:and|&)\\s+${particles ? `(?:${particles}\\s+)?` : ''}${last}`;
}

function listedAuthorPattern(item: ReferenceItem): string {
  if (item.authors.length < 3 || item.authors.length > 8) return '';
  const names = item.authors.slice(1).map((author) => surnameWords(author).map(escaped).join('\\s+'));
  if (names.some((name) => !name)) return '';
  const last = names.pop()!;
  return `,\\s*${names.join(',\\s*')},?\\s+(?:and|&)\\s+${last}`;
}

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
  const parentheticals = [...normalized.matchAll(/\(([^()]{1,1500})\)|\[([^\[\]]{1,1500})\]/g)].map((match) => match[1] ?? match[2]);
  const author_matches = new Map<string, ReferenceItem[]>();
  for (const item of references) {
    if (!item.authors.length || !item.publication_year) continue;
    const surname = surnameWords(item.authors[0]).at(-1);
    if (!surname) continue;
    const key = `${surname}:${folded(item.publication_year)}`;
    author_matches.set(key, [...author_matches.get(key) ?? [], item]);
  }
  for (const [key, matches] of author_matches) {
    if (matches.length !== 1) continue;
    const [surname, year] = key.split(':');
    // Require a citation-shaped span; a grouped list contains complete years,
    // including suffixes, so 2025 cannot accidentally match 2025a.
    const citation_year = '(?:18|19|20)\\d{2}[a-z]?';
    const coauthors = ['\\s+et\\s+al\\.?', pairedAuthorPattern(matches[0]), listedAuthorPattern(matches[0])].filter(Boolean).join('|');
    const author = `(?<![\\p{L}\\p{N}'-])${escaped(surname)}(?:${coauthors})?`;
    const separator = '\\s*(?:(?:,\\s*)?(?:\\(|\\[)|,)\\s*';
    const years = `(${citation_year}(?:\\s*[,;]\\s*${citation_year}){0,19})(?![\\p{L}\\p{N}_–—-])`;
    const pattern = new RegExp(`${author}${separator}${years}`, 'gu');
    const bare = new RegExp(`${author}\\s+${years}(?=\\s*(?:[,;]|$))`, 'gu');
    if ([...normalized.matchAll(pattern), ...parentheticals.flatMap((group) => [...group.matchAll(bare)])]
      .some((match) => match[1].split(/\s*[,;]\s*/).includes(year))) ids.add(matches[0].reference_id);
  }
  return references.filter((item) => ids.has(item.reference_id));
}

export function referenceAtDestination(references: ReferenceItem[], page_number: number, point: [number, number]): ReferenceItem | null {
  const on_page = references.filter((item) => item.page_number === page_number && item.source_rect);
  // Bibliography anchors can sit in the margin before a hanging-indent entry.
  // Allow up to 32 PDF points for wider bibliography indents, but only at the
  // first line; extending the whole entry would capture unrelated destinations.
  // Prefer its first line: a right-column anchor may also intersect the body
  // of a long reference in the left column, which is not the intended target.
  const starts = on_page.filter((item) => {
    const [left, , , top] = item.source_rect!;
    return point[0] >= left - 32 && point[0] <= left + 3 && point[1] >= top - 2 && point[1] <= top + 8;
  });
  if (starts.length) return starts.length === 1 ? starts[0] : null;
  const matches = on_page.filter((item) => {
    const [left, bottom, right, top] = item.source_rect!;
    return point[0] >= left - 8 && point[0] <= right + 3 && point[1] >= bottom - 2 && point[1] <= top + 8;
  });
  return matches.length === 1 ? matches[0] : null;
}
