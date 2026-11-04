import type { Annotation, Paper, ReadingBlockPreference, ReadingLayout, ReadingLocation } from '../../src/lib/types';
import { validateAnnotation } from '../../src/lib/annotations';
import { store, type Store } from './store';
import { validateRecord } from '../generated/doi_ai';

export async function requirePaper(db: Store, paper_id: string): Promise<Paper> {
  const paper = await db.get<Paper>('paper', paper_id);
  if (!paper) throw new Error('That paper is no longer in the library.');
  return paper;
}

export const listPapers = () => store.transaction(async (db) => (await db.list<Paper>('paper'))
  .sort((a, b) => (b.last_opened_at ?? b.downloaded_at).localeCompare(a.last_opened_at ?? a.downloaded_at)));

export const markPaperOpened = (paper_id: string) => store.transaction(async (db) => {
  const paper = await requirePaper(db, paper_id);
  paper.last_opened_at = new Date().toISOString();
  await db.put('paper', paper_id, paper_id, paper);
  return paper;
});

export const saveReadingPosition = (location: ReadingLocation) => store.transaction(async (db) => {
  validateRecord('location', location);
  const paper = await requirePaper(db, location.paper_id);
  if (!Number.isInteger(location.page_number) || location.page_number < 1
    || !Number.isFinite(location.zoom) || location.zoom < 0.1 || location.zoom > 10
    || ![0, 90, 180, 270].includes(location.rotation)
    || !location.page_position.every((v) => Number.isFinite(v) && v >= 0 && v <= 1)) {
    throw new Error('Invalid reading position.');
  }
  paper.last_location = location;
  await db.put('paper', paper.paper_id, paper.paper_id, paper);
});

export const listAnnotations = (paper_id: string) => store.transaction((db) => db.list<Annotation>('annotation', paper_id));
export const saveAnnotation = (annotation: Annotation) => store.transaction(async (db) => {
  validateRecord('annotation', annotation);
  const paper = await requirePaper(db, annotation.target.paper_id);
  validateAnnotation(annotation, paper);
  const old = await db.get<Annotation>('annotation', annotation.annotation_id);
  if (old && old.target.paper_id !== paper.paper_id) throw new Error('That annotation belongs to another paper.');
  const saved = { ...annotation, created_at: old?.created_at ?? annotation.created_at, updated_at: new Date().toISOString() };
  await db.put('annotation', saved.annotation_id, paper.paper_id, saved);
  return saved;
});
export const deleteAnnotation = (annotation_id: string) => store.transaction((db) => db.remove('annotation', annotation_id));

export const getReadingLayout = (paper_id: string, layout_version: number) => store.transaction(async (db) => {
  const paper = await requirePaper(db, paper_id);
  const layout = await db.get<ReadingLayout>('layout', paper_id);
  return layout?.pdf_hash === paper.pdf_hash && layout.layout_version === layout_version ? layout : null;
});
export const saveReadingLayout = (paper_id: string, layout: ReadingLayout) => store.transaction(async (db) => {
  validateRecord('layout', layout);
  const paper = await requirePaper(db, paper_id);
  if (layout.pdf_hash !== paper.pdf_hash || layout.layout_version !== 5) throw new Error('The reading layout belongs to another PDF revision.');
  await db.put('layout', paper_id, paper_id, layout);
});

const preferenceKey = (preference: ReadingBlockPreference) => JSON.stringify([preference.pdf_hash, preference.page_number, preference.source_rect]);
export const listReadingBlockPreferences = (paper_id: string) => store.transaction(async (db) =>
  await db.get<ReadingBlockPreference[]>('preferences', paper_id) ?? []);
export const saveReadingBlockPreferences = (paper_id: string, preferences: ReadingBlockPreference[]) => store.transaction(async (db) => {
  const paper = await requirePaper(db, paper_id);
  const current = await db.get<ReadingBlockPreference[]>('preferences', paper_id) ?? [];
  const merged = new Map(current.map((p) => [preferenceKey(p), p]));
  for (const p of preferences) {
    if (p.pdf_hash !== paper.pdf_hash || !p.source_rect.every(Number.isFinite)) throw new Error('Invalid reading block preference.');
    if (p.split_lines) merged.set(preferenceKey(p), p); else merged.delete(preferenceKey(p));
  }
  await db.put('preferences', paper_id, paper_id, [...merged.values()]);
});
export const saveReadingBlockPreference = (paper_id: string, preference: ReadingBlockPreference) => saveReadingBlockPreferences(paper_id, [preference]);
export const resetReadingBlockPreference = (paper_id: string, preference: ReadingBlockPreference) => saveReadingBlockPreferences(paper_id, [{ ...preference, split_lines: false }]);
