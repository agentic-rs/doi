import { describe, expect, it } from 'vitest';
import { parseAnnotationSidecar, serializeAnnotations } from './annotations';
import type { Annotation, Paper } from './types';

const paper: Paper = {
  paper_id: '1706.03762v7', arxiv_id: '1706.03762', arxiv_version: 7,
  title: 'Example', authors: [], abstract: '', pdf_url: '', pdf_hash: 'a'.repeat(64),
  downloaded_at: '2026-09-27T00:00:00Z', last_location: null,
};
const annotation: Annotation = {
  schema_version: 1, annotation_id: 'test-id',
  target: {
    paper_id: paper.paper_id, pdf_hash: paper.pdf_hash,
    page_anchors: [{ page_number: 2, quad_points: [[10, 30, 20, 30, 20, 10, 10, 10]],
      text_quote: { exact_text: 'attention', prefix: 'use ', suffix: ' here', normalization_version: 1 } }],
  },
  body: { kind: 'note', content: 'A note' },
  created_at: '2026-09-27T00:00:00Z', updated_at: '2026-09-27T00:00:00Z',
};

describe('app annotation sidecar', () => {
  it('round trips a reviewed AI note together with its original answer and provenance', () => {
    const aiNote: Annotation = {
      ...annotation,
      body: {
        kind: 'ai_answer', question: 'Why does this matter?',
        answer: 'The complete explanation remains available.', note_content: 'My edited takeaway.',
        provider_id: 'https://provider.example/v1', model_id: 'test-model', context_text: 'Quoted context',
      },
    };
    expect(parseAnnotationSidecar(serializeAnnotations(paper, [aiNote]), paper)).toEqual([aiNote]);
    if (aiNote.body.kind !== 'ai_answer') throw new Error('Expected an AI note');
    delete aiNote.body.note_content;
    expect(parseAnnotationSidecar(serializeAnnotations(paper, [aiNote]), paper)).toEqual([aiNote]);
  });
  it('rejects invalid optional AI note content before importing', () => {
    const data = JSON.parse(serializeAnnotations(paper, [annotation]));
    data.annotations[0].body = {
      kind: 'ai_answer', question: 'Why?', answer: 'Explanation',
      provider_id: 'local', model_id: 'local-model', context_text: '',
    };
    for (const invalid of [null, 42, '', '  ', 'contains\0null', '字'.repeat(44_000)]) {
      data.annotations[0].body.note_content = invalid;
      expect(() => parseAnnotationSidecar(JSON.stringify(data), paper)).toThrow(/AI note/);
    }
  });
  it('round trips coordinates and content independently of the renderer', () => {
    expect(parseAnnotationSidecar(serializeAnnotations(paper, [annotation]), paper)).toEqual([annotation]);
  });
  it('keeps a whole-paper note independent from its cited passage and rejects broken links', () => {
    const citation = { citation_id: 'S2', anchor: annotation.target.page_anchors[0] };
    const pinned: Annotation = { ...annotation, target: { ...annotation.target, scope: 'paper', page_anchors: [] },
      body: { kind: 'note', content: 'My takeaway', citations: [citation], origin: { conversation_id: 'discussion', turn_id: 'question' } } };
    const data = serializeAnnotations(paper, [pinned]);
    expect(parseAnnotationSidecar(data, paper)).toEqual([pinned]);
    for (const mutate of [
      (n: Annotation) => { delete n.target.scope; },
      (n: Annotation) => { n.target.page_anchors.push(citation.anchor); },
      (n: Annotation) => { if (n.body.kind === 'note') n.body.citations!.push(citation); },
      (n: Annotation) => { if (n.body.kind === 'note') n.body.citations![0].anchor.quad_points = []; },
      (n: Annotation) => { if (n.body.kind === 'note') n.body.origin!.turn_id = ''; },
    ]) {
      const sidecar = JSON.parse(data);
      mutate(sidecar.annotations[0]);
      expect(() => parseAnnotationSidecar(JSON.stringify(sidecar), paper)).toThrow();
    }
  });
  it('rejects other PDF revisions and malformed geometry', () => {
    const data = serializeAnnotations(paper, [annotation]);
    expect(() => parseAnnotationSidecar(data, { ...paper, pdf_hash: 'b'.repeat(64) })).toThrow(/revision/);
    const invalid = JSON.parse(data);
    invalid.annotations[0].target.page_anchors[0].quad_points[0] = [0, 0];
    expect(() => parseAnnotationSidecar(JSON.stringify(invalid), paper)).toThrow(/geometry/);
  });
  it('rejects unsupported versions, invalid JSON and duplicate IDs before saving', () => {
    expect(() => parseAnnotationSidecar('{', paper)).toThrow(/JSON/);
    expect(() => parseAnnotationSidecar(serializeAnnotations(paper, [annotation]).replace('"schema_version": 1', '"schema_version": 2'), paper)).toThrow(/Unsupported/);
    expect(() => parseAnnotationSidecar(serializeAnnotations(paper, [annotation, annotation]), paper)).toThrow(/duplicate/);
  });
});
