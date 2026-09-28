import type { Annotation, Paper } from './types';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const string = (value: unknown): value is string => typeof value === 'string';

export function validateAnnotation(value: unknown, paper: Pick<Paper, 'paper_id' | 'pdf_hash'>): asserts value is Annotation {
  if (!record(value) || value.schema_version !== 1 || !string(value.annotation_id) || !value.annotation_id.trim()
    || !string(value.created_at) || !string(value.updated_at)
    || !Number.isFinite(Date.parse(value.created_at)) || !Number.isFinite(Date.parse(value.updated_at))) {
    throw new Error('Invalid annotation record or unsupported schema version.');
  }
  const target = value.target;
  if (!record(target) || target.paper_id !== paper.paper_id || target.pdf_hash !== paper.pdf_hash) {
    throw new Error('These annotations belong to a different paper or PDF revision.');
  }
  if (!Array.isArray(target.page_anchors) || !target.page_anchors.length || target.page_anchors.length > 100) {
    throw new Error('Annotations require at least one valid page anchor.');
  }
  for (const anchor of target.page_anchors) {
    if (!record(anchor) || !Number.isInteger(anchor.page_number) || Number(anchor.page_number) < 1
      || !Array.isArray(anchor.quad_points) || !anchor.quad_points.length || anchor.quad_points.length > 10_000
      || !anchor.quad_points.every((quad: unknown) => Array.isArray(quad) && quad.length === 8 && quad.every(Number.isFinite))) {
      throw new Error('Invalid annotation page geometry.');
    }
    const quote = anchor.text_quote;
    if (!record(quote) || !string(quote.exact_text) || !string(quote.prefix) || !string(quote.suffix)
      || quote.normalization_version !== 1) {
      throw new Error('Invalid annotation text anchor.');
    }
  }
  const body = value.body;
  if (!record(body) || (body.kind !== 'note' && body.kind !== 'ai_answer')) {
    throw new Error('Unsupported annotation content.');
  }
  if (body.kind === 'note' ? !string(body.content)
    : !['question', 'answer', 'provider_id', 'model_id', 'context_text'].every((key) => string(body[key]))) {
    throw new Error('Invalid annotation content.');
  }
  if (body.kind === 'ai_answer' && body.note_content !== undefined
    && (!string(body.note_content) || !body.note_content.trim() || body.note_content.includes('\0')
      || new TextEncoder().encode(body.note_content).byteLength > 128 * 1024)) {
    throw new Error('Invalid AI note content.');
  }
}

export function serializeAnnotations(paper: Paper, annotations: Annotation[]): string {
  annotations.forEach((annotation) => validateAnnotation(annotation, paper));
  return JSON.stringify({
    format: 'papertrail_annotations',
    schema_version: 1,
    paper_id: paper.paper_id,
    pdf_hash: paper.pdf_hash,
    exported_at: new Date().toISOString(),
    annotations,
  }, null, 2);
}

export function parseAnnotationSidecar(text: string, paper: Paper): Annotation[] {
  if (new TextEncoder().encode(text).byteLength > 8 * 1024 * 1024) throw new Error('Annotation files must be smaller than 8 MB.');
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error('This file is not valid JSON.'); }
  if (!record(parsed) || parsed.format !== 'papertrail_annotations' || parsed.schema_version !== 1
    || parsed.paper_id !== paper.paper_id || parsed.pdf_hash !== paper.pdf_hash) {
    throw new Error('Unsupported annotation file, or a different paper/PDF revision.');
  }
  if (!Array.isArray(parsed.annotations) || parsed.annotations.length > 10_000) throw new Error('Invalid annotation collection.');
  const ids = new Set<string>();
  for (const annotation of parsed.annotations) {
    validateAnnotation(annotation, paper);
    if (ids.has(annotation.annotation_id)) throw new Error('The annotation file contains duplicate IDs.');
    ids.add(annotation.annotation_id);
  }
  return parsed.annotations as Annotation[];
}
