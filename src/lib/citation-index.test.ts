import { describe, expect, it } from 'vitest';
import { arxivIdFromUrl, referenceFromText } from './pdf-references';
import { referenceAtDestination, referencesForText } from './citation-index';

const numbered = [2, 5, 6, 7].map((number) => referenceFromText(`[${number}] Jane Doe. A useful paper. Journal, 2020.`, 10, number)!);

describe('citation associations', () => {
  it('uses actual labels, groups and bounded ranges, deduplicating repeated citations', () => {
    expect(referencesForText('Earlier work [2, 5–7] also cited [2].', numbered).map((r) => r.label)).toEqual(['2', '5', '6', '7']);
    expect(referencesForText('Equations [2] and Figure [5]. Values [1–9999].', numbered)).toEqual([]);
  });
  it('does not choose a reference when its printed label is ambiguous', () => {
    expect(referencesForText('See [2].', [numbered[0], { ...numbered[0], reference_id: 'duplicate' }])).toEqual([]);
  });
  it('matches citation-shaped author/year spans and preserves year suffixes', () => {
    const refs = [referenceFromText('Jane Doe and John Smith. 2018a. A useful paper. Journal.', 10, 0)!, referenceFromText('Jane Doe and Mary Jones. 2018b. Another useful paper. Journal.', 10, 1)!];
    expect(referencesForText('Doe et al. (2018a) and Doe and Jones, 2018b.', refs)).toEqual(refs);
    expect(referencesForText('Doe studied this for a long time before 2018a.', refs)).toEqual([]);
    expect(referencesForText('Doe (2018a)', [...refs, { ...refs[0], reference_id: 'duplicate' }])).toEqual([]);
  });
  it('requires an unambiguous nearby destination on the same page', () => {
    const ref = { ...numbered[0], source_rect: [50, 600, 260, 640] as [number, number, number, number] };
    expect(referenceAtDestination([ref], 10, [46, 645])).toBe(ref);
    expect(referenceAtDestination([ref], 9, [50, 640])).toBeNull();
    expect(referenceAtDestination([ref], 10, [50, 700])).toBeNull();
    expect(referenceAtDestination([ref, { ...ref, reference_id: 'overlap' }], 10, [50, 640])).toBeNull();
  });
});

describe('arXiv URL normalization', () => {
  it.each([
    ['https://arxiv.org/html/1706.03762v7/', '1706.03762v7'],
    ['https://export.arxiv.org/pdf/hep-th/9901001v3.pdf/).', 'hep-th/9901001v3'],
    ['HTTPS://WWW.ARXIV.ORG/abs/math.GT%2F0309136?download=1#page=3', 'math.GT/0309136'],
    ['arxiv.org/abs/1706.03762v2', '1706.03762v2'],
  ])('normalizes %s', (url, id) => expect(arxivIdFromUrl(url)).toBe(id));
  it.each(['https://evil.test/arxiv.org/abs/1706.03762', 'https://arxiv.org.evil.test/abs/1706.03762', 'https://user@arxiv.org/abs/1706.03762', 'https://arxiv.org:8443/abs/1706.03762', 'ftp://arxiv.org/abs/1706.03762', 'https://arxiv.org/abs/1706.03762v0', 'https://arxiv.org/abs/1706.03762.pdf.pdf', 'https://arxiv.org/abs/1706.03762/extra'])('rejects %s', (url) => expect(arxivIdFromUrl(url)).toBeNull());
});
