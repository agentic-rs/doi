import { describe, expect, it } from 'vitest';
import { arxivIdFromUrl, referenceFromText } from './pdf-references';
import { referenceAtDestination, referencesForText } from './citation-index';

const numbered = [2, 5, 6, 7].map((number) => referenceFromText(`[${number}] Jane Doe. A useful paper. Journal, 2020.`, 10, number)!);

describe('citation associations', () => {
  it('matches grouped parenthetical author/year citations without commas before years', () => {
    const refs = [
      referenceFromText('Chu, Y.; Xu, J.; and Yang, Q. 2023. Qwen-audio technical report. arXiv:2311.07919.', 8, 0)!,
      referenceFromText('Tang, C.; Yu, W.; and Sun, G. 2023. A useful speech model. Journal.', 9, 1)!,
      referenceFromText('Xie, Z.; and Wu, C. 2024a. A useful first paper. Journal.', 9, 2)!,
      referenceFromText('Xie, Z.; and Wu, C. 2024b. A useful second paper. Journal.', 9, 3)!,
    ];
    expect(referencesForText('Earlier work (Chu et al. 2023; Tang et\nal. 2023; Xie and Wu 2024a).', refs)).toEqual(refs.slice(0, 3));
    expect(referencesForText('[Chu, Xu, and Yang 2023; Xie & Wu 2024b]', refs)).toEqual([refs[0], refs[3]]);
    expect(referencesForText('(Chu, Xu and Yang 2023)', refs)).toEqual([refs[0]]);
    expect(referencesForText('Chu et al. 2023 results; Xie and Wu 2024a experiments.', refs)).toEqual([]);
    expect(referencesForText('(Xie and Other 2024a; Tang et al. 2023abcd)', refs)).toEqual([]);
    expect(referencesForText('(Chu et al. 2023–2024)', refs)).toEqual([]);
    expect(referencesForText('(Chu et al. 2023)', [...refs, { ...refs[0], reference_id: 'ambiguous' }])).toEqual([]);
  });
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
  it.each([
    ['Alec Radford', 'Rad-\nford et al. (2025)'],
    ['Alec Radford', 'Rad\u00ad\nford et al. (2025)'],
    ['John O’Connor', "O'Connor et al. (2025)"],
    ["John O'Connor", 'O’Connor et al. (2025)'],
    ['Jan Łukasiewicz', 'Łukasiewicz et al. (2025)'],
    ['Anne Østby', 'Østby et al. (2025)'],
    ['Alexandre Défossez', 'D´efossez et al. (2025)'],
    ['Alexandre Défossez', 'D \u0301efossez et al. (2025)'],
    ['Jane Smith', 'Smith et\u00a0al.\n(2025)'],
    ['Jane Smith et al.', 'Smith et al. (2025)'],
  ])('matches %s despite PDF name typography in %s', (author, text) => {
    const reference = { ...numbered[0], authors: [author], publication_year: '2025' };
    expect(referencesForText(text, [reference])).toEqual([reference]);
  });
  it('uses the parsed second surname for multiword two-author citations', () => {
    const reference = referenceFromText('Erik F Tjong Kim Sang and Fien De Meulder. 2003. A useful paper. Journal.', 10, 0)!;
    expect(referencesForText('Tjong Kim Sang and\nDe Meulder (2003)', [reference])).toEqual([reference]);
    expect(referencesForText('Tjong Kim Sang & De Meulder, 2003', [reference])).toEqual([reference]);
    expect(referencesForText('Sang and Other (2003)', [reference])).toEqual([]);
    expect(referencesForText('Sang and the research by De Meulder (2003)', [reference])).toEqual([]);
  });
  it('matches complete grouped years and comma-before-parenthesis citations', () => {
    const refs = ['2024', '2025', '2025a', '2025b'].map((year, index) => ({
      ...numbered[0], reference_id: `smith-${index}`, authors: ['Jane Smith'], publication_year: year,
    }));
    expect(referencesForText('Smith et al. (2024, 2025)', refs)).toEqual(refs.slice(0, 2));
    expect(referencesForText('Smith et al., (2025a; 2025b)', refs)).toEqual(refs.slice(2));
    expect(referencesForText('Smith et al., 2025a', refs)).toEqual([refs[2]]);
    expect(referencesForText('Smith et al. (2024, 2025)', [...refs, { ...refs[1], reference_id: 'duplicate' }])).toEqual([refs[0]]);
  });
  it('does not match surnames inside another name or years inside prose', () => {
    const reference = { ...numbered[0], authors: ['Jane Smith'], publication_year: '2025' };
    for (const text of ['Goldsmith et al. (2025)', "O'Smith et al. (2025)", 'Gold-Smith et al. (2025)', 'ŁSmith et al. (2025)', 'Smith studied this in 2025', 'Smith et al. (2025–2026)', 'Smith et al. (2025abcd)']) {
      expect(referencesForText(text, [reference]), text).toEqual([]);
    }
    const accented = { ...reference, authors: ['Alexandre Défossez'] };
    expect(referencesForText('D efossez et al. (2025)', [accented])).toEqual([]);
    expect(referencesForText('Défossez studied this before 2025.', [accented])).toEqual([]);
  });
  it('requires an unambiguous nearby destination on the same page', () => {
    const ref = { ...numbered[0], source_rect: [50, 600, 260, 640] as [number, number, number, number] };
    expect(referenceAtDestination([ref], 10, [46, 645])).toBe(ref);
    expect(referenceAtDestination([ref], 9, [50, 640])).toBeNull();
    expect(referenceAtDestination([ref], 10, [50, 700])).toBeNull();
    expect(referenceAtDestination([ref, { ...ref, reference_id: 'overlap' }], 10, [50, 640])).toBeNull();
  });
  it('matches margin anchors at an entry start before an adjacent column body', () => {
    const left = { ...numbered[0], source_rect: [55.44, 680, 291, 780] as [number, number, number, number] };
    const right = { ...numbered[1], source_rect: [307.44, 660, 540, 725] as [number, number, number, number] };
    expect(referenceAtDestination([left, right], 10, [287.515, 726.932])).toBe(right);
    expect(referenceAtDestination([left], 10, [35.515, 781.354])).toBe(left);
    // Ordinary explicit destinations inside a reference still use its body.
    expect(referenceAtDestination([left, right], 10, [330, 680])).toBe(right);
    expect(referenceAtDestination([right], 10, [274, 726.932])).toBeNull();
    expect(referenceAtDestination([right], 10, [287.515, 740])).toBeNull();
  });
  it('rejects ambiguous entry starts instead of falling back to a body match', () => {
    const left = { ...numbered[0], source_rect: [55, 600, 291, 760] as [number, number, number, number] };
    const right = { ...numbered[1], source_rect: [307, 620, 540, 725] as [number, number, number, number] };
    const overlap = { ...right, reference_id: 'overlapping-start', source_rect: [309, 660, 540, 727] as [number, number, number, number] };
    expect(referenceAtDestination([left, right, overlap], 10, [287, 728])).toBeNull();
  });
  it('matches wide hanging-indent anchors at the first line of wrapped references', () => {
    // Moshi (2410.00037v2) puts its citation destinations 27.273 PDF points
    // before entries, including this eight-line Brown et al. reference.
    const reference = {
      ...numbered[0], page_number: 43,
      source_rect: [90, 556.133, 522.006, 661.8861] as [number, number, number, number],
    };
    expect(referenceAtDestination([reference], 43, [62.727, 664.526])).toBe(reference);
    expect(referenceAtDestination([reference], 43, [62.727, 661.768])).toBe(reference);
    // An unrelated link in the margin or above the entry remains navigation.
    expect(referenceAtDestination([reference], 43, [62.727, 635])).toBeNull();
    expect(referenceAtDestination([reference], 43, [62.727, 675])).toBeNull();
    expect(referenceAtDestination([reference], 43, [57, 664.526])).toBeNull();
    expect(referenceAtDestination([reference], 42, [62.727, 664.526])).toBeNull();
  });
  it('keeps wide start anchors unambiguous across adjacent columns and entries', () => {
    const left = { ...numbered[0], source_rect: [55, 600, 291, 760] as [number, number, number, number] };
    const right = { ...numbered[1], source_rect: [307, 640, 540, 725] as [number, number, number, number] };
    const next = { ...numbered[2], source_rect: [307, 580, 540, 625] as [number, number, number, number] };
    expect(referenceAtDestination([left, right, next], 10, [279.727, 727.64])).toBe(right);
    expect(referenceAtDestination([left, right, next], 10, [279.727, 627.64])).toBe(next);
    const overlap = { ...right, reference_id: 'overlapping-start', source_rect: [310, 660, 540, 727] as [number, number, number, number] };
    expect(referenceAtDestination([left, right, next, overlap], 10, [279.727, 727.64])).toBeNull();
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
