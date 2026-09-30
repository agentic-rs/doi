import { describe, expect, it } from 'vitest';
import { extractReferences, referenceFromText } from './pdf-references';

describe('bibliography extraction', () => {
  it('joins wrapped numbered references over a page break and stops at the appendix', () => {
    const references = extractReferences([
      { page_number: 7, text: 'References\n[1] A. Author. Attention is all you need.\narXiv:1706.03762v7\n[2] B. Author. A long' },
      { page_number: 8, text: 'citation continued across pages. doi:10.1000/182\n[3] Another useful title.\nAppendix A\nThis is body text.' },
    ]);
    expect(references).toHaveLength(3);
    expect(references[0].arxiv_id).toBe('1706.03762v7');
    expect(references[1].citation_text).toContain('citation continued across pages');
    expect(references[1].page_number).toBe(7);
    expect(references[1].doi).toBe('10.1000/182');
    expect(references[2].citation_text).not.toContain('This is body text');
  });

  it('supports old-style arXiv IDs and links ending in .pdf', () => {
    const reference = referenceFromText('Useful paper: https://arxiv.org/pdf/hep-th/9901001v2.pdf.', 10, 0);
    expect(reference?.arxiv_id).toBe('hep-th/9901001v2');
    expect(reference?.url).toBe('https://arxiv.org/pdf/hep-th/9901001v2.pdf');
  });

  it('keeps links in the appendix out of an identified bibliography', () => {
    const references = extractReferences([{ page_number: 9, text: 'References\n[1] A paper arXiv:2401.12345.\n[2] A second paper.\nAppendix A\nUnnumbered source\nhttps://doi.org/10.5555/example.\nBody text does not become a reference.' }]);
    expect(references).toHaveLength(2);
  });

  it('does not let DOI lines turn a hanging bibliography into a numbered one', () => {
    const line = (text: string, x: number, y: number) => ({ text, source_rect: [x, y, 270, y + 10] as [number, number, number, number] });
    const references = extractReferences([{ page_number: 10, text: '', lines: [
      line('References', 50, 760),
      line('Hendrycks, D. and Gimpel, K. Gaussian error linear', 50, 740),
      line('units (gelus). arXiv preprint arXiv:1606.08415, 2016.', 60, 726),
      line('Smith, J. and Jones, M. A useful research paper.', 50, 700),
      line('Example Journal, 2025. DOI:', 60, 686),
      line('10.18653/v1/2025.example-1.2.', 60, 672),
    ] }]);
    expect(references).toHaveLength(2);
    expect(references.map((reference) => reference.label)).toEqual([null, null]);
    expect(references[0]).toMatchObject({ title: 'Gaussian error linear units (gelus)', authors: ['D. Hendrycks', 'K. Gimpel'], arxiv_id: '1606.08415' });
    expect(references[1]).toMatchObject({ title: 'A useful research paper', authors: ['J. Smith', 'M. Jones'], doi: '10.18653/v1/2025.example-1.2' });
    expect(referenceFromText('10.18653/v1/2025.example-1.2.', 10, 0)?.label).toBeNull();
  });

  it.each(['1. ', '2) ', '[3]'])('still recognizes an explicit numeric label %s', (label) => {
    expect(referenceFromText(`${label}Jane Smith. A useful paper. Example Journal, 2025.`, 10, 0)?.label).toBe(label.match(/\d+/)?.[0]);
  });

  it('ignores repeated running headers inside wrapped entries and stops at a lettered appendix', () => {
    const line = (text: string, x: number, y: number) => ({ text, source_rect: [x, y, 270, y + 10] as [number, number, number, number] });
    const references = extractReferences([
      { page_number: 9, text: '', lines: [
        line('High-Fidelity Simultaneous Speech-To-Speech Translation', 100, 780),
        line('References', 50, 760),
        line('Smith, J., Jones, M., and', 50, 740),
      ] },
      { page_number: 10, text: '', lines: [
        line('High-Fidelity Simultaneous Speech-To-Speech Translation', 100, 780),
        line('Doe, A. A useful research paper.', 60, 760),
        line('Example Journal, 2025.', 60, 746),
        line('Smith, J. Another useful paper.', 50, 724),
        line('Example Journal, 2024.', 60, 710),
      ] },
      { page_number: 11, text: '', lines: [
        line('High-Fidelity Simultaneous Speech-To-Speech Translation', 100, 780),
        line('A. Appendix', 50, 760),
        line('Figure 7. Example of contextual alignments.', 50, 700),
        line('Associated input timestamps.', 60, 686),
      ] },
    ]);
    expect(references).toHaveLength(2);
    expect(references[0]).toMatchObject({ authors: ['J. Smith', 'M. Jones', 'A. Doe'], title: 'A useful research paper' });
    expect(references.every((reference) => !/High-Fidelity|Figure 7|Appendix/.test(reference.citation_text))).toBe(true);
  });

  it('uses identifiable links as fallback for an unnumbered bibliography', () => {
    const references = extractReferences([{ page_number: 9, text: 'References\nAuthor (2020). A useful paper https://doi.org/10.5555/example.\nAppendix A\nSource https://github.com/example/project' }]);
    expect(references).toHaveLength(1);
    expect(references[0].doi).toBe('10.5555/example');
  });

  it('does not turn arbitrary body paragraphs into bibliography entries', () => {
    expect(extractReferences([{ page_number: 1, text: '1. We define our method.\n2. This is an ordinary heading.' }])).toEqual([]);
  });

  it('recognizes CoRR identifiers and avoids appending unnumbered supplement figures', () => {
    const references = extractReferences([
      { page_number: 10, text: 'References\n[1] A paper. CoRR, abs/1409.0473, 2014.' },
      { page_number: 11, text: 'Attention VisualizationsInput-Input Layer5\nThe plot contains many words.' },
    ]);
    expect(references).toHaveLength(1);
    expect(references[0].arxiv_id).toBe('1409.0473');
    expect(references[0].citation_text).not.toContain('plot');
  });
});

it('keeps printed labels, parsed metadata, and the original wrapped citation distinct', () => {
  const item = referenceFromText('[VSP17] Jane Doe and John Smith. A long attention-\nbased title. arXiv preprint arXiv:1706.03762, 2017.', 5, 0)!;
  expect(item.label).toBe('VSP17');
  expect(item.title).toBe('A long attentionbased title');
  expect(item.authors).toEqual(['Jane Doe', 'John Smith']);
  expect(item.publication_year).toBe('2017');
  expect(item.venue).toBe('arXiv preprint');
  expect(item.citation_text).toContain('attention- based title');
});

it('splits a hanging-indent bibliography with wrapped authors and year suffixes across columns', () => {
  const lines = [
    { text: 'References', source_rect: [50, 760, 150, 772] as [number, number, number, number] },
    { text: 'Jane Doe, John Smith, and Mary', source_rect: [50, 730, 260, 740] as [number, number, number, number] },
    { text: 'Jones. 2018a. A useful first title.', source_rect: [60, 716, 265, 726] as [number, number, number, number] },
    { text: 'In Proceedings of Examples.', source_rect: [60, 702, 245, 712] as [number, number, number, number] },
    { text: 'John Smith and Jane Doe.', source_rect: [50, 680, 250, 690] as [number, number, number, number] },
    { text: '2018b. A useful second title.', source_rect: [60, 666, 255, 676] as [number, number, number, number] },
    { text: 'Example Journal.', source_rect: [60, 652, 220, 662] as [number, number, number, number] },
    { text: 'Mary Jones and Jane Doe.', source_rect: [320, 730, 530, 740] as [number, number, number, number] },
    { text: '2019. A third useful title.', source_rect: [330, 716, 535, 726] as [number, number, number, number] },
    { text: 'In Proceedings of Examples.', source_rect: [330, 702, 525, 712] as [number, number, number, number] },
    { text: 'John Smith and Mary Jones.', source_rect: [320, 680, 530, 690] as [number, number, number, number] },
    { text: '2020. A fourth useful title.', source_rect: [330, 666, 535, 676] as [number, number, number, number] },
    { text: 'Example Journal.', source_rect: [330, 652, 520, 662] as [number, number, number, number] },
    { text: 'Appendix', source_rect: [320, 620, 500, 640] as [number, number, number, number] },
  ];
  const refs = extractReferences([{ page_number: 10, text: '', lines }]);
  expect(refs).toHaveLength(4);
  expect(refs[0]).toMatchObject({ label: null, title: 'A useful first title', publication_year: '2018a', authors: ['Jane Doe', 'John Smith', 'Mary Jones'], source_rect: [50, 702, 265, 740] });
  expect(refs[2].source_rect).toEqual([320, 702, 535, 740]);
  expect(refs[3].citation_text).not.toContain('Appendix');
});

it('does not treat a publication year as a numbered bibliography label', () => {
  const refs = extractReferences([{ page_number: 8, text: 'References\nJane Doe and John Smith.\n2020. A useful title. Example Journal.\nMary Jones. 2021. Another useful title. Example Journal.' }]);
  expect(refs).toHaveLength(2);
  expect(refs.map((item) => item.label)).toEqual([null, null]);
});

it('parses wrapped arXiv URLs and balanced DOI punctuation', () => {
  const item = referenceFromText('A related paper. https://arxiv.org/pdf/\nhep-th/9901001v2.pdf. DOI:10.1000/test(part).', 4, 0)!;
  expect(item.arxiv_id).toBe('hep-th/9901001v2');
  expect(item.doi).toBe('10.1000/test(part)');
});

it.each([
  ['Journal of Examples, 6(Nov):1817–1853, 2020.', 'Journal of Examples'],
  ['In Proceedings of the 27th Example Conference, pages 1929–1958. ACL, 2020.', 'In Proceedings of the 27th Example Conference'],
  ['In Example Conference (Volume 1: Long Papers), pp. 47– 52, 2020.', 'In Example Conference (Volume 1: Long Papers)'],
])('extracts a publication venue without pagination from %s', (publication, venue) => {
  const item = referenceFromText(`Jane Doe. 2020. A useful paper. ${publication}`, 8, 0)!;
  expect(item.venue).toBe(venue);
  expect(item.citation_text).toContain(publication);
});

describe('abbreviated and inverted author lists', () => {
  it.each([
    'Jane Smith et al. (2025). A useful research paper. Example Journal.',
    'Jane Smith et al. 2025. A useful research paper. Example Journal.',
    'Jane Smith et al. A useful research paper. Example Journal, 2025.',
    'Jane Smith et al. A Useful Research Paper. Example Journal, 2025.',
  ])('indexes named authors without treating et al. as a surname: %s', (citation) => {
    expect(referenceFromText(citation, 10, 0)).toMatchObject({
      authors: ['Jane Smith'], publication_year: '2025', title: expect.stringMatching(/^A useful research paper$/i),
      venue: 'Example Journal', parse_confidence: 'parsed', citation_text: citation,
    });
  });

  it('keeps every named author before the omitted-author marker', () => {
    expect(referenceFromText('Jane Smith, Mary Jones, et al. A useful research paper. Example Journal, 2025.', 10, 0))
      .toMatchObject({ authors: ['Jane Smith', 'Mary Jones'], title: 'A useful research paper', publication_year: '2025', venue: 'Example Journal' });
  });

  it.each([
    ['Smith, J., Jones, M., and Doe, A. (2025). A useful research paper. Example Journal.', ['J. Smith', 'M. Jones', 'A. Doe']],
    ['Smith, J. R., Jones, M.-L., et al. A useful research paper. Example Journal, 2025.', ['J. R. Smith', 'M.-L. Jones']],
    ['Smith, Jones, and Doe (2025). A useful research paper. Example Journal.', ['Smith', 'Jones', 'Doe']],
  ])('preserves inverted initials and ordinary author separators: %s', (citation, authors) => {
    expect(referenceFromText(citation, 10, 0)).toMatchObject({ authors, title: 'A useful research paper', publication_year: '2025', venue: 'Example Journal' });
  });

  it('splits abbreviated unnumbered entries whose year follows the title', () => {
    const references = extractReferences([{ page_number: 10, text: 'References\nJane Smith et al. A useful research paper.\nExample Journal, 2025.\nMary Jones et al. Another useful research paper.\nExample Journal, 2024.' }]);
    expect(references).toHaveLength(2);
    expect(references[0]).toMatchObject({ authors: ['Jane Smith'], title: 'A useful research paper', publication_year: '2025' });
    expect(references[1]).toMatchObject({ authors: ['Mary Jones'], title: 'Another useful research paper', publication_year: '2024' });
  });

  it('keeps wrapped author lists and abbreviated endings together in a hanging bibliography', () => {
    const line = (text: string, x: number, y: number) => ({ text, source_rect: [x, y, 260, y + 10] as [number, number, number, number] });
    const references = extractReferences([{ page_number: 10, text: '', lines: [
      line('References', 50, 760),
      line('Jane Smith, Mary Jones,', 50, 740),
      line('and John Doe, et al. A useful research paper.', 60, 726),
      line('Example Journal, 2025.', 60, 712),
      line('Smith, J., Jones, M., et al.', 50, 690),
      line('Another useful research paper.', 60, 676),
      line('Example Journal, 2024.', 60, 662),
    ] }]);
    expect(references).toHaveLength(2);
    expect(references[0]).toMatchObject({ authors: ['Jane Smith', 'Mary Jones', 'John Doe'], title: 'A useful research paper', publication_year: '2025', source_rect: [50, 712, 260, 750] });
    expect(references[1]).toMatchObject({ authors: ['J. Smith', 'M. Jones'], title: 'Another useful research paper', publication_year: '2024' });
  });

  it('does not mistake prose mentioning et al. for a parsed author list', () => {
    expect(referenceFromText('The methods introduced by Smith et al. (2025) were used for these experiments.', 10, 0))
      .toMatchObject({ authors: [], title: null, parse_confidence: 'raw' });
  });

  it.each([
    ['Hendrycks, D. and Gimpel, K. Gaussian error linear units (gelus). arXiv preprint arXiv:1606.08415, 2016.', ['D. Hendrycks', 'K. Gimpel'], 'Gaussian error linear units (gelus)', '2016'],
    ['Smith, J. R. and Jones, M.-L. A useful research paper. Example Journal, 2025.', ['J. R. Smith', 'M.-L. Jones'], 'A useful research paper', '2025'],
    ['Jane A. Smith and Mary B. Jones. A useful research paper. Example Journal, 2025.', ['Jane A. Smith', 'Mary B. Jones'], 'A useful research paper', '2025'],
    ['Jain, A. N., McNair, A. E., and Tebelskis, J. The JANUS system. Example Journal, 1991.', ['A. N. Jain', 'A. E. McNair', 'J. Tebelskis'], 'The JANUS system', '1991'],
  ])('finds the title after final initials without truncating names: %s', (citation, authors, title, year) => {
    expect(referenceFromText(citation, 10, 0)).toMatchObject({ authors, title, publication_year: year, parse_confidence: 'parsed' });
  });

  it('normalizes detached PDF accents without altering the printed citation', () => {
    const citation = 'D ́efossez, A., Mazar ́e, L., and Rivi`ere, M. A useful research paper. Example Journal, 2025.';
    expect(referenceFromText(citation, 10, 0)).toMatchObject({
      authors: ['A. Défossez', 'L. Mazaré', 'M. Rivière'], title: 'A useful research paper', citation_text: citation,
    });
  });

  it.each([
    ['Shazeer, N. Glu variants improve transformer. arXiv preprint arXiv:2002.05202, 2020.', '2020'],
    ['Keskar, N. S., McCann, B., and Socher, R. A useful research paper. CoRR, abs/1909.05858, 2019.', '2019'],
    ['Jia, Y., Ramanovich, M. T., and Zen, H. A useful research paper. In LREC 2022, pp. 6691–6703. Example Association, 2022b. doi: 10.18653/V1/2022.example.1.', '2022b'],
    ['Smith, J. (2020a). A useful research paper. Proceedings of Examples 2019, pp. 1999–2001.', '2020a'],
    ['Smith, J. A useful research paper. Example Journal, 2022. doi: 10.1109/TASLP.2021. 3129994.', '2022'],
    ['Smith, J. A useful research paper. CoRR, abs/2002.05202.', null],
    ['Smith, J. A useful research paper. DOI:10.1234/foo, 2025.', '2025'],
    ['Smith, J. A useful research paper. DOI:10.1234/foo, 2025b.', '2025b'],
    ['Smith, J. A useful research paper. DOI:10.1234/foo. 2025.', null],
    ['Smith, J. A useful research paper. DOI:10.1234/foo,2025.', null],
  ])('distinguishes publication years and suffixes from identifier digits: %s', (citation, year) => {
    expect(referenceFromText(citation, 10, 0)?.publication_year).toBe(year);
  });
});
