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
