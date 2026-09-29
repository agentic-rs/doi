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
      { page_number: 11, text: 'Attention Visualizations Input-Input Layer5\nThe plot contains many words.' },
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
