import { describe, expect, it } from 'vitest';
import type { Annotation, PageAnchor, QuadPoints, ReadingLayout } from './types';
import { mapReadingNotes } from './reading-notes';

function anchor(page_number: number, quad_points: QuadPoints[]): PageAnchor {
  return { page_number, quad_points, text_quote: { exact_text: 'Selected passage', prefix: '', suffix: '', normalization_version: 1 } };
}

function rectangle(left: number, bottom: number, right: number, top: number): QuadPoints {
  return [left, top, right, top, right, bottom, left, bottom];
}

function note(page_anchors: PageAnchor[], annotation_id = 'note'): Annotation {
  return {
    annotation_id, schema_version: 1, target: { paper_id: 'paper', pdf_hash: 'hash', page_anchors },
    body: { kind: 'note', content: 'My note' }, created_at: '', updated_at: '',
  };
}

const layout: ReadingLayout = {
  layout_version: 5, pdf_hash: 'hash', page_count: 3,
  blocks: [
    { block_id: 'left', page_number: 1, source_rect: [0, 0, 40, 100], kind: 'text', block_type: 'content', text: '', figure_label: null },
    { block_id: 'moved-figure', page_number: 2, source_rect: [0, 60, 100, 100], kind: 'figure', block_type: 'graph', text: '', figure_label: '1' },
    { block_id: 'gutter', page_number: 1, source_rect: [45, 0, 55, 100], kind: 'text', block_type: 'content', text: '', figure_label: null },
    { block_id: 'right', page_number: 1, source_rect: [60, 0, 100, 100], kind: 'text', block_type: 'content', text: '', figure_label: null },
    { block_id: 'later-page', page_number: 3, source_rect: [0, 0, 100, 100], kind: 'original', block_type: 'others', text: '', figure_label: null },
  ],
};

describe('reading note ownership', () => {
  it('tests individual quads across columns instead of attaching the intervening gutter', () => {
    const left_quad = rectangle(5, 10, 30, 20);
    const right_quad = rectangle(70, 40, 90, 50);
    const annotation = note([anchor(1, [left_quad, right_quad])]);
    const mapped = mapReadingNotes(layout, [annotation], 'paper', 'hash');
    expect([...mapped.keys()]).toEqual(['left', 'right']);
    expect(mapped.get('left')![0].anchor.quad_points).toEqual([left_quad]);
    expect(mapped.get('right')![0].anchor.quad_points).toEqual([right_quad]);
  });

  it('maps multiple anchors on the same page and deduplicates repeated or overlapping quads', () => {
    const annotation = note([
      anchor(1, [rectangle(10, 10, 20, 20), rectangle(15, 10, 30, 20)]),
      anchor(1, [rectangle(10, 10, 20, 20)]),
      anchor(1, [rectangle(70, 40, 90, 50)]),
    ]);
    const mapped = mapReadingNotes(layout, [annotation, annotation], 'paper', 'hash');
    expect([...mapped.keys()]).toEqual(['left', 'right']);
    expect(mapped.get('left')).toHaveLength(1);
    expect(mapped.get('right')).toHaveLength(1);
    expect(mapped.get('right')![0].anchor).toEqual(annotation.target.page_anchors[2]);
  });

  it('uses source pages for multipage notes even when figures are moved into earlier prose', () => {
    const annotation = note([anchor(3, [rectangle(20, 70, 30, 80)]), anchor(2, [rectangle(20, 70, 30, 80)])]);
    const mapped = mapReadingNotes(layout, [annotation], 'paper', 'hash');
    expect([...mapped.keys()]).toEqual(['moved-figure', 'later-page']);
    expect(mapped.get('moved-figure')![0].anchor.page_number).toBe(2);
    expect(mapped.get('later-page')![0].anchor.page_number).toBe(3);
  });

  it('retains legacy AI notes without altering the original body or anchor data', () => {
    const annotation = note([anchor(1, [rectangle(10, 10, 20, 20)])]);
    annotation.body = { kind: 'ai_answer', question: 'Why?', answer: 'Legacy answer', provider_id: '', model_id: '', context_text: '' };
    const original = structuredClone(annotation);
    expect(mapReadingNotes(layout, [annotation], 'paper', 'hash').get('left')![0].annotation).toBe(annotation);
    expect(annotation).toEqual(original);
  });

  it('leaves missing, out-of-page, whitespace, and boundary-only anchors unmatched', () => {
    const annotations = [
      note([], 'empty'), note([anchor(4, [rectangle(10, 10, 20, 20)])], 'unknown-page'),
      note([anchor(1, [rectangle(101, 10, 110, 20)])], 'outside'),
      note([anchor(1, [rectangle(40, 10, 44, 20)])], 'touching-edge'),
      note([anchor(1, [rectangle(10, 10, 10, 20)])], 'zero-area'),
      note([anchor(1, [rectangle(NaN, 10, 20, 20)])], 'invalid'),
    ];
    expect(mapReadingNotes(layout, annotations, 'paper', 'hash').size).toBe(0);
  });

  it('requires actual polygon overlap for a slanted selection, not just overlapping bounding boxes', () => {
    const diagonal: QuadPoints = [35, 110, 50, 95, 51, 96, 36, 111];
    const mapped = mapReadingNotes(layout, [note([anchor(1, [diagonal])])], 'paper', 'hash');
    expect([...mapped.keys()]).toEqual(['gutter']);
  });

  it('rejects annotations and reading layouts from another paper version', () => {
    const annotation = note([anchor(1, [rectangle(10, 10, 20, 20)])]);
    expect(mapReadingNotes(layout, [annotation], 'different-paper', 'hash').size).toBe(0);
    expect(mapReadingNotes(layout, [annotation], 'paper', 'different-hash').size).toBe(0);
    expect(mapReadingNotes({ ...layout, pdf_hash: 'stale-layout' }, [annotation], 'paper', 'hash').size).toBe(0);
    expect(mapReadingNotes(null, [annotation], 'paper', 'hash').size).toBe(0);
  });
});
