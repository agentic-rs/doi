import { describe, expect, it } from 'vitest';
import {
  classifyReadingDocument,
  classifyReadingRegion,
  readingPageEvidence,
  type ReadingPageEvidence,
  type ReadingRegionEvidence,
  type ReadingTextLine,
} from './reading-block-classification';
import type { ReadingBlock, ReadingBlockType } from './types';

const page: ReadingPageEvidence = {
  page_number: 2, width: 600, height: 800, scale: 1, body_font_size: 10, body_start: Infinity,
};

function line(text: string, x = 50, y = 100, width = 450, font_size = 10): ReadingTextLine {
  return { text, rect: [x, y, x + width, y + font_size], font_size, horizontal: true };
}

function region(lines: ReadingTextLine[], overrides: Partial<ReadingRegionEvidence> = {}): ReadingRegionEvidence {
  return {
    rect: lines.length ? [
      Math.min(...lines.map((item) => item.rect[0])), Math.min(...lines.map((item) => item.rect[1])),
      Math.max(...lines.map((item) => item.rect[2])), Math.max(...lines.map((item) => item.rect[3])),
    ] : [50, 100, 500, 300],
    lines, graphic_pixels: 0, graphic_rect: null, ...overrides,
  };
}

function block(block_id: string, page_number: number, text: string, block_type: ReadingBlockType = 'content', overrides: Partial<ReadingBlock> = {}): ReadingBlock {
  return {
    block_id, page_number, text, block_type, source_rect: [50, 550, 500, 600],
    kind: 'text', figure_label: null, ...overrides,
  };
}

describe('semantic labels for existing Reading crops', () => {
  it('keeps prose and its inline mathematics together as content', () => {
    const evidence = region([
      line('We calculate y = Wx + b for each token before applying the final normalization step.'),
      line('The resulting vectors retain the structure of the original document.', 50, 114),
    ]);
    expect(classifyReadingRegion(evidence, page, null)).toBe('content');
  });

  it.each([
    'y = Wx + b',
    'Attention(Q, K, V) = softmax(QK / √d)V',
    'L = ∑ log p(x), where x ∈ D',
  ])('recognizes displayed mathematics: %s', (text) => {
    expect(classifyReadingRegion(region([line(text, 140, 180, 280)]), page, null)).toBe('equation');
  });

  it('labels plots without text as graphs and blank crops as others', () => {
    expect(classifyReadingRegion(region([], { graphic_pixels: 1800, graphic_rect: [60, 110, 490, 290] }), page, null)).toBe('graph');
    expect(classifyReadingRegion(region([]), page, null)).toBe('others');
  });

  it('keeps an identified multipart figure and its caption a graph', () => {
    expect(classifyReadingRegion(region([
      line('Figure 2. Results for two model families and multiple evaluation conditions.'),
    ], { rect: [50, 100, 500, 400], graphic_pixels: 3000, graphic_rect: [50, 110, 500, 350] }), page, '2')).toBe('graph');
  });

  it.each([
    ['Table 2. Accuracy by model.', 'table'],
    ['Table A.2: Evaluation settings.', 'table'],
    ['Figure 3. The proposed architecture.', 'graph'],
  ] as const)('recognizes the caption %s', (text, expected) => {
    expect(classifyReadingRegion(region([line(text)]), page, null)).toBe(expected);
  });

  it('does not turn a wrapped prose mention into a table caption', () => {
    const evidence = region([
      line('The complete experimental comparison is summarized in the following'),
      line('Table 6. In this table, each model uses the same training corpus.', 50, 114),
    ]);
    expect(classifyReadingRegion(evidence, page, null)).toBe('content');
  });

  it('recognizes aligned table cells with uncertainty values before treating ± as math', () => {
    const evidence = region([
      line('Model', 50, 100, 90), line('Accuracy', 240, 100, 75), line('Latency', 400, 100, 65),
      line('Baseline', 50, 120, 90), line('82.4 ± 0.3', 240, 120, 75), line('21 ± 2', 400, 120, 65),
      line('Proposed', 50, 140, 90), line('87.1 ± 0.2', 240, 140, 75), line('18 ± 1', 400, 140, 65),
    ]);
    expect(classifyReadingRegion(evidence, page, null)).toBe('table');
  });

  it('does not mistake two aligned prose columns for a table', () => {
    const evidence = region([
      line('The method preserves local context', 50, 100, 200), line('Our analysis examines model behavior', 320, 100, 220),
      line('Training examples use shared labels', 50, 114, 200), line('Each condition uses identical inputs', 320, 114, 220),
      line('Readers can inspect individual predictions', 50, 128, 200), line('We report the observed differences', 320, 128, 220),
    ]);
    expect(classifyReadingRegion(evidence, page, null)).toBe('content');
  });

  it.each(['2.3 Training procedure', 'B Additional experiments', 'References', 'Abstract'])('recognizes heading %s', (text) => {
    expect(classifyReadingRegion(region([line(text)]), page, null)).toBe('title');
  });

  it('recognizes a larger document title but leaves ordinary first-page metadata as others', () => {
    const first_page = { ...page, page_number: 1, body_start: 200 };
    expect(classifyReadingRegion(region([line('A Study of Neural Speech Models', 80, 50, 440, 18)]), first_page, null)).toBe('title');
    expect(classifyReadingRegion(region([line('Alice Smith and Bob Jones', 100, 100, 400)]), first_page, null)).toBe('others');
    expect(classifyReadingRegion(region([line('Department of Computing, Example University', 100, 125, 400)]), first_page, null)).toBe('others');
    expect(classifyReadingRegion(region([line('Our method learns representations from paired speech and text examples.', 50, 220)]), first_page, null)).toBe('content');
  });

  it('does not confuse bibliography author initials or publication years with headings', () => {
    for (const text of [
      'A Smith, B Jones, and C Brown. 2025. Learning from speech.',
      'A. Smith and B. Jones. 2025. Learning from speech.',
      '12 Smith and Jones. 2025. Learning from speech.',
    ]) {
      expect(classifyReadingRegion(region([line(text)]), page, null)).toBe('content');
    }
  });

  it('retains algorithms, page numbers, and mixed prose with a plot as others', () => {
    expect(classifyReadingRegion(region([line('Algorithm 1 Training procedure')]), page, null)).toBe('others');
    expect(classifyReadingRegion(region([line('12', 295, 765, 10)]), page, null)).toBe('others');
    expect(classifyReadingRegion(region([
      line('The curve shows how the training error changes throughout the optimization procedure.'),
    ], { rect: [50, 100, 500, 400], graphic_rect: [50, 150, 500, 380], graphic_pixels: 6000 }), page, null)).toBe('others');
  });

  it('uses body prose, rather than short superscripts, to estimate the page font', () => {
    const evidence = readingPageEvidence([
      line('A Large Document Title', 50, 40, 500, 20),
      line('Abstract', 50, 180, 100, 12),
      line('This paragraph provides enough ordinary text to represent the document body.', 50, 200, 500, 10),
      ...Array.from({ length: 20 }, (_, index) => line(String(index), 500, 210 + index * 8, 6, 5)),
    ], 1, 600, 800, 1);
    expect(evidence.body_font_size).toBe(10);
    expect(evidence.body_start).toBe(180);
  });
});

describe('document context for semantic Reading labels', () => {
  it('preserves nonnumeric footers within bibliography pages, including nonzero PDF origins', () => {
    const blocks = [
      block('p2-heading', 2, 'References', 'title'),
      block('p2-entry', 2, 'A Smith and B Jones. 2025. Learning from speech.'),
      block('p2-footer', 2, 'Published by Example Society', 'others', { source_rect: [50, 120, 400, 130] }),
      block('p3-continuation', 3, 'Proceedings of the International Conference on Learning Representations.', 'others'),
    ];
    expect(classifyReadingDocument(blocks, new Map([[2, [0, 100, 600, 900]]])).map((item) => item.block_type))
      .toEqual(['title', 'reference', 'others', 'reference']);
  });

  it('labels bibliography continuations across pages and stops at an appendix', () => {
    const blocks = [
      block('p1-body', 1, 'Smith et al. (2025) motivate the approach used in this paper.'),
      block('p2-heading', 2, 'References', 'title'),
      block('p2-entry', 2, 'A Smith and B Jones. 2025. Learning from speech.'),
      block('p3-continuation', 3, 'Proceedings of the International Conference on Learning Representations.'),
      block('p3-entry', 3, 'Brown, C. 2024. A study of language models.'),
      block('p4-heading', 4, 'Appendix A Additional experiments', 'title'),
      block('p4-body', 4, 'These additional experiments examine the effect of model capacity.'),
    ];
    expect(classifyReadingDocument(blocks).map((item) => item.block_type)).toEqual([
      'content', 'title', 'reference', 'reference', 'reference', 'title', 'content',
    ]);
  });

  it('keeps repeated running headers and page numbers out of bibliography entries', () => {
    const header = (id: string, number: number) => block(id, number, 'Neural Speech Models', 'content', { source_rect: [50, 760, 500, 770] });
    const blocks = [
      header('p2-header', 2), block('p2-heading', 2, 'References', 'title'),
      block('p2-entry', 2, 'A Smith and B Jones. 2025. Learning from speech.'),
      block('p2-footer', 2, '2', 'others', { source_rect: [295, 20, 305, 30] }),
      header('p3-header', 3), block('p3-entry', 3, 'C Brown. 2024. A study of language models.'),
    ];
    expect(classifyReadingDocument(blocks).map((item) => item.block_type)).toEqual([
      'others', 'title', 'reference', 'others', 'others', 'reference',
    ]);
  });

  it('uses others for a crop mixing a bibliography heading and entry while continuing the reference section', () => {
    const blocks = [
      block('p2-mixed', 2, 'References\nA Smith and B Jones. 2025. Learning from speech.'),
      block('p2-entry', 2, 'C Brown. 2024. A study of language models.'),
    ];
    expect(classifyReadingDocument(blocks).map((item) => item.block_type)).toEqual(['others', 'reference']);
  });

  it('does not relabel inline citations as bibliography entries without a reference section', () => {
    const blocks = [block('p1-body', 1, 'Smith et al. (2025) and [12] report similar results for this setting.')];
    expect(classifyReadingDocument(blocks)[0].block_type).toBe('content');
  });

  it('preserves source crops, IDs, order, and rendering kinds without mutating input', () => {
    const blocks = [
      block('p2-figure', 2, 'Figure 3. Experimental results.', 'graph', { kind: 'figure', figure_label: '3', source_rect: [32, 10, 520, 430] }),
      block('p2-heading', 2, 'References', 'title'),
      block('p2-entry', 2, 'A Smith and B Jones. 2025. Learning from speech.', 'content', { source_rect: [44, 62, 268, 115] }),
      block('p3-scan', 3, '', 'others', { kind: 'original', source_rect: [0, 0, 612, 792] }),
    ];
    const original = structuredClone(blocks);
    const result = classifyReadingDocument(blocks);
    const withoutType = (item: ReadingBlock) => {
      const { block_type: _block_type, ...source } = item;
      return source;
    };
    expect(result.map(withoutType)).toEqual(original.map(withoutType));
    expect(result[2].block_type).toBe('reference');
    expect(blocks).toEqual(original);
  });
});
