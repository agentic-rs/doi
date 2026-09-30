import type { PdfSourceRect, ReferenceItem } from './types';
import { normalizePdfText, safeReferenceUrl } from './pdf-geometry';
import { publicationVenue } from './reference-presentation';
export { referenceAtDestination, referencesForText } from './citation-index';

export interface PageText {
  page_number: number;
  text: string;
  lines?: Array<{ text: string; source_rect: PdfSourceRect }>;
}

interface SourceLine { text: string; page_number: number; source_rect: PdfSourceRect | null }
const heading_pattern = /^(?:\d+\.?\s+)?(?:references|bibliography|literature cited)\s*$/i;
const end_pattern = /^(?:appendix\b|attention visualizations|supplement(?:ary|al)\b|acknowledg(?:e)?ments\b|author biographies\b|[A-Z]\.?\s+(?:appendix|proof|additional|supplementary)\b)/i;
const label_pattern = /^(?:\[([\p{L}\d][\p{L}\d+_.:–-]{0,30})\]|(\d{1,3})[.)](?=\s|$))\s*/u;
const year_pattern = /\b((?:18|19|20)\d{2}[a-z]?)\b/;
const id_pattern = /^(?:\d{2}(?:0[1-9]|1[0-2])\.\d{4,5}|[a-z][a-z-]*(?:\.[A-Za-z]{2})?\/\d{2}(?:0[1-9]|1[0-2])\d{3})(?:v[1-9]\d{0,3})?$/;

export function hasReferenceHeading(page: PageText): boolean {
  const lines = page.lines?.map((line) => line.text) ?? page.text.split(/\r?\n/);
  return lines.some((line) => heading_pattern.test(line.trim()));
}

function trimPunctuation(value: string): string {
  let text = value.replace(/[.,;:]+$/, '');
  while (/[)\]}>"']$/.test(text) && (!text.endsWith(')') || (text.match(/\(/g)?.length ?? 0) < (text.match(/\)/g)?.length ?? 0))) text = text.slice(0, -1).replace(/[.,;:]+$/, '');
  return text;
}

/** Match the same official hosts and identifier grammar as native validation. */
export function arxivIdFromUrl(value: string): string | null {
  try {
    const trimmed = trimPunctuation(value.trim().replace(/^[<"']+/, ''));
    const url = new URL(/^(?:www\.|export\.)?arxiv\.org\//i.test(trimmed) ? `https://${trimmed}` : trimmed);
    if (!['http:', 'https:'].includes(url.protocol) || !['arxiv.org', 'www.arxiv.org', 'export.arxiv.org'].includes(url.hostname.toLowerCase()) || url.username || url.password || url.port) return null;
    const path = decodeURIComponent(url.pathname).replace(/\/+$/, '');
    const id = path.match(/^\/(?:abs|pdf|html)\/(.+?)(?:\.pdf)?$/)?.[1];
    return id && id_pattern.test(id) ? id : null;
  } catch { return null; }
}

function identifiers(text: string) {
  const urls = [...text.matchAll(/\b(?:[a-z][a-z\d+.-]*:\/\/[^\s<>"']+|(?:[a-z\d.-]+\.)?[a-z\d-]+\.[a-z]{2,}\/[^\s<>"']+)/gi)];
  let arxiv_id: string | null = null;
  let url: string | null = null;
  let unlinked = text;
  for (const match of [...urls].reverse()) unlinked = unlinked.slice(0, match.index) + ' ' + unlinked.slice(match.index! + match[0].length);
  for (const match of urls) {
    if (match.index && /[\w@/\\.-]/.test(text[match.index - 1])) continue;
    const clean = trimPunctuation(match[0]);
    arxiv_id ??= arxivIdFromUrl(clean);
    url ??= safeReferenceUrl(clean);
  }
  const labeled = unlinked.match(/\barxiv\s*:\s*([^\s,;]+)/i)?.[1];
  const corr = /\bCoRR\b/i.test(unlinked) ? unlinked.match(/\babs\/([^\s,;]+)/i)?.[1] : null;
  const explicit = trimPunctuation(labeled ?? corr ?? '');
  if (!arxiv_id && id_pattern.test(explicit)) arxiv_id = explicit;
  const raw_doi = text.match(/\b10\.\d{4,9}\/[^\s<>"']+/i)?.[0];
  return { arxiv_id, doi: raw_doi ? trimPunctuation(raw_doi) : null, url };
}

function authorList(text: string): string[] {
  // "Et al." describes omitted authors; it is never an author's surname.
  // Retain the complete printed list in citation_text, and index only names.
  const value = text.replace(/\s*([`´\u0300\u0301])(\p{L})/gu, (_, accent: string, letter: string) => `${letter}${/[`\u0300]/u.test(accent) ? '\u0300' : '\u0301'}`)
    .normalize('NFC').trim().replace(/[\s,(]+$/, '')
    .replace(/(?:,\s*|\s+)et\s+al\.?$/iu, '').replace(/[.\s,]+$/, '');
  if (!value || value.length > 900 || /\b(?:proceedings|journal|conference|preprint|volume|pages|https|arxiv)\b/i.test(value)) return [];
  // Do not consume a title before a year printed at the end of the entry.
  // Full stops inside names must belong to initials or a familiar name suffix.
  if (/\./.test(value.replace(/\b\p{Lu}\.(?=[\s,-]|\p{Lu}|$)/gu, '').replace(/\b(?:Jr|Sr|Dr|Prof)\./g, ''))) return [];
  const words = value.match(/[\p{L}][\p{L}\p{M}'’.-]*/gu) ?? [];
  if (!words.length || words.some((word) => !/^[\p{Lu}]/u.test(word) && !/^(?:and|van|von|de|del|der|den|da|di|dos|du|la|le|al|et)$/i.test(word))) return [];
  const parts = value.split(/,\s*(?:and\s+)?|\s+and\s+|\s*&\s*/).map((name) => name.trim()).filter(Boolean);
  const authors: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const initials = parts[index + 1];
    // Commas separate both authors and inverted names. Only combine an
    // unambiguous initials segment; "Smith, Jones" stays two named authors.
    if (initials && /^(?:\p{Lu}\.(?:\s*|-))*\p{Lu}\.?$/u.test(initials)) {
      authors.push(`${initials.replace(/\.?$/, '.')} ${parts[index]}`);
      index += 1;
    } else authors.push(parts[index]);
  }
  return authors;
}

function abbreviatedAuthorPrefix(text: string): { authors: string[]; remainder: string } | null {
  const marker = /\bet\s+al\.\s+/iu.exec(text);
  if (!marker || marker.index === undefined) return null;
  const end = marker.index + marker[0].length;
  const authors = authorList(text.slice(0, end));
  return authors.length ? { authors, remainder: text.slice(end) } : null;
}

function authorTitlePrefix(text: string): { authors: string[]; remainder: string } | null {
  const abbreviated = abbreviatedAuthorPrefix(text);
  if (abbreviated) return abbreviated;
  // The final initial in an inverted name is also the author/title boundary:
  // "Smith, J. and Jones, M. A useful paper." Generic sentence splitting
  // protects initials, so examine candidates using the author-list grammar.
  for (const boundary of text.matchAll(/\.\s+(?=[\p{L}\d])/gu)) {
    const end = boundary.index! + boundary[0].length;
    const remainder = text.slice(end);
    if (/^(?:\p{Lu}\.(?:[\s,-]|$)|and\b|et\s+al\b)/u.test(remainder)) continue;
    const authors = authorList(text.slice(0, end));
    if (!authors.length || authors.some((author) => !/[\p{L}'’-]{2,}$/u.test(author))) continue;
    return { authors, remainder };
  }
  return null;
}

function sentences(text: string): string[] {
  // Initials and common citation abbreviations are not sentence boundaries.
  return text.replace(/\b([A-Z])\./g, '$1\u0001').replace(/\b(et al|eds?|vol|pp)\./gi, '$1\u0001')
    .split(/\.\s+(?=[\p{Lu}\d]|arXiv\b|https?:)|(?<=[?!])\s+(?=[\p{Lu}])/u).map((part) => part.replaceAll('\u0001', '.').trim()).filter(Boolean);
}

function publicationYears(text: string): RegExpMatchArray[] {
  // Conference names may repeat the plain year before the final publication
  // year/suffix. Identifier digits (e.g. arXiv:2002.05202) are not dates.
  const publication = text.split(/\b(?:doi\s*:|10\.\d{4,9}\/)/i, 1)[0]
    .replace(/\bhttps?:\s*\/\/\S+/gi, (url) => ' '.repeat(url.length));
  const years = [...publication.matchAll(/(?<![\p{L}\d/.:])((?:18|19|20)\d{2}[a-z]?)(?![\p{L}\d]|\.\d)/gu)];
  if (!years.length && publication.length < text.length) {
    // Some styles place the date after the DOI. Require an explicit comma
    // separator so a wrapped DOI ending in year-like digits remains an ID.
    const trailing = /((?:18|19|20)\d{2}[a-z]?)(?=\.?\s*$)/u.exec(text);
    if (trailing && /,\s+$/.test(text.slice(0, trailing.index))) years.push(trailing);
  }
  return years;
}

function metadata(body: string) {
  // Bibliographies may end an entry with links back to citing pages. Keep
  // those in the original citation, but not in publication metadata. Require
  // a preceding publication year and a separate, terminal small-number list.
  const backrefs = /\.\s+\d{1,3}(?:\s*[,–—-]\s*\d{1,3})*\.?$/.exec(body);
  if (backrefs && publicationYears(body.slice(0, backrefs.index)).length) body = body.slice(0, backrefs.index + 1);
  const years = publicationYears(body);
  let year: RegExpMatchArray | undefined = years[0];
  let authors: string[] = [];
  let remainder = body;
  if (year && year.index !== undefined) {
    authors = authorList(body.slice(0, year.index));
    if (authors.length) remainder = body.slice(year.index + year[0].length).replace(/^[\s.)]+/, '');
  }
  if (!authors.length) {
    year = years.at(-1);
    const prefix = authorTitlePrefix(body);
    if (prefix) ({ authors, remainder } = prefix);
    else {
      const parts = sentences(body);
      authors = authorList(parts[0] ?? '');
      if (authors.length && parts.length > 1) remainder = parts.slice(1).join('. ');
      else authors = [];
    }
  }
  const parts = sentences(remainder);
  const title = authors.length && parts[0] && parts[0].length > 5 && !/^(?:https?:|arxiv\b|doi\b|CoRR\b)/i.test(parts[0])
    ? parts[0].replace(/,\s*(?:18|19|20)\d{2}[a-z]?\.?$/, '').replace(/[.\s]+$/, '') : null;
  const venue = title ? publicationVenue(parts.slice(1).join('. ')
    .replace(/(?:\bURL\s+)?https?:\/\/\S+|\barxiv\s*:\s*\S+|\bdoi\s*:\s*\S+/gi, '')
    .replace(/[,;.]?\s*\b(?:18|19|20)\d{2}[a-z]?\.?\s*$/, '')) || null : null;
  return { title, authors: title ? authors : [], publication_year: year?.[1] ?? null, venue, parse_confidence: title ? 'parsed' as const : 'raw' as const };
}

export function referenceFromText(citation_text: string, page_number: number, index: number): ReferenceItem | null {
  const text = normalizePdfText(citation_text);
  const parsing_text = normalizePdfText(citation_text
    .replace(/([\p{L}])-\s*\n\s*(?=[\p{Ll}])/gu, '$1')
    .replace(/\b(https?:)\s*\n\s*(\/\/)/gi, '$1$2'));
  const ids = identifiers(parsing_text
    .replace(/(arxiv\.org\/(?:abs|pdf|html)\/)\s+/gi, '$1')
    .replace(/\b([a-z][a-z-]*(?:\.[a-z]{2})?\/)\s+(?=\d{7})/gi, '$1')
    .replace(/(\b\d{4}\.)\s+(?=\d{4,5}\b)/g, '$1'));
  if (text.length < 12 && !ids.arxiv_id && !ids.doi && !ids.url) return null;
  const label = text.match(label_pattern);
  return {
    reference_id: `reference-${page_number}-${index}`, label: label?.[1] ?? label?.[2] ?? null,
    citation_text: text, page_number, source_rect: null, ...ids,
    ...metadata(parsing_text.slice(label?.[0].length ?? 0)),
  };
}

/** Split explicit bibliographies using printed labels or hanging indentation.
 * Without those signals, only recognizable author/year entries or links qualify. */
export function extractReferences(pages: PageText[]): ReferenceItem[] {
  const page_headers = new Map<string, number>();
  for (const page of pages) {
    const header = page.lines?.find((line) => line.text.trim());
    if (header) page_headers.set(header.text.trim(), (page_headers.get(header.text.trim()) ?? 0) + 1);
  }
  const all_lines: SourceLine[] = pages.flatMap<SourceLine>((page) => page.lines
    ? page.lines.filter((line, index) => index !== 0 || (page_headers.get(line.text.trim()) ?? 0) < 2 || heading_pattern.test(line.text.trim()))
      .map((line) => ({ ...line, page_number: page.page_number }))
    : page.text.split(/\r?\n/).map((text) => ({ text, page_number: page.page_number, source_rect: null })));
  let in_bibliography = false;
  let has_heading = false;
  const lines: SourceLine[] = [];
  for (const source of all_lines) {
    const line = { ...source, text: source.text.trim() };
    if (heading_pattern.test(line.text)) { in_bibliography = true; has_heading = true; continue; }
    if (in_bibliography && end_pattern.test(line.text)) break;
    if (in_bibliography && line.text && !/^\d+$/.test(line.text)) lines.push(line);
  }
  if (!has_heading) {
    const seen = new Set<string>();
    return all_lines.flatMap((line) => {
      const item = referenceFromText(line.text, line.page_number, seen.size);
      const key = item?.arxiv_id ?? item?.doi ?? item?.url;
      if (!item || !key || seen.has(key)) return [];
      seen.add(key);
      return [{ ...item, source_rect: line.source_rect }];
    });
  }
  const numbered = lines.some((line) => label_pattern.test(line.text));
  const clusters: Array<{ x: number; count: number }> = [];
  for (const line of lines) {
    if (!line.source_rect) continue;
    const x = line.source_rect[0];
    const group = clusters.find((cluster) => Math.abs(cluster.x - x) < 2);
    if (group) group.count += 1;
    else clusters.push({ x, count: 1 });
  }
  clusters.sort((a, b) => a.x - b.x);
  const hanging_starts = clusters.filter((cluster, index) => cluster.count >= 2 && clusters.slice(index + 1).some((next) => next.x - cluster.x >= 5 && next.x - cluster.x <= 18 && next.count >= 3));
  const groups: SourceLine[][] = [];
  let current: SourceLine[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const hanging = line.source_rect && hanging_starts.some((start) => Math.abs(start.x - line.source_rect![0]) < 2);
    const lookahead = lines.slice(index, index + 6).map((item) => item.text).join(' ').replace(/([\p{L}])-\s+(?=[\p{Ll}])/gu, '$1');
    const year = lookahead.match(year_pattern);
    const author_start = /^[\p{Lu}]/u.test(line.text) && year?.index !== undefined
      && (authorList(lookahead.slice(0, year.index)).length > 0 || abbreviatedAuthorPrefix(lookahead) !== null);
    const start = numbered ? label_pattern.test(line.text) : hanging_starts.length ? hanging : author_start;
    if (start && current.length) { groups.push(current); current = []; }
    if (start || current.length) current.push(line);
    else if (identifiers(line.text).arxiv_id || identifiers(line.text).doi || identifiers(line.text).url) groups.push([line]);
  }
  if (current.length) groups.push(current);
  return groups.flatMap((group, index) => {
    const first = group[0];
    const item = referenceFromText(group.map((line) => line.text).join('\n'), first.page_number, index);
    if (!item) return [];
    const origin = first.source_rect;
    const rects = origin ? group.filter((line) => line.page_number === first.page_number && line.source_rect && Math.abs(line.source_rect[0] - origin[0]) < 40).map((line) => line.source_rect!) : [];
    if (rects.length) item.source_rect = [Math.min(...rects.map((r) => r[0])), Math.min(...rects.map((r) => r[1])), Math.max(...rects.map((r) => r[2])), Math.max(...rects.map((r) => r[3]))];
    return [item];
  });
}
