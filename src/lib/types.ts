export interface ReadingLocation {
  paper_id: string;
  page_number: number;
  // Fractions of the rotated page viewport, from its top-left corner.
  page_position: [number, number];
  zoom: number;
  rotation: number;
}

export interface Paper {
  paper_id: string;
  arxiv_id: string;
  arxiv_version: number;
  title: string;
  authors: string[];
  abstract: string;
  pdf_url: string;
  pdf_hash: string;
  downloaded_at: string;
  last_location: ReadingLocation | null;
}

export interface TextQuote {
  exact_text: string;
  prefix: string;
  suffix: string;
  normalization_version: number;
}

// Four points in PDF user space: top-left, top-right, bottom-right, bottom-left.
export type QuadPoints = [number, number, number, number, number, number, number, number];

export interface PageAnchor {
  page_number: number;
  quad_points: QuadPoints[];
  text_quote: TextQuote;
}

export interface AnnotationTarget {
  paper_id: string;
  pdf_hash: string;
  page_anchors: PageAnchor[];
}

export type AnnotationBody =
  | { kind: 'note'; content: string }
  | {
      kind: 'ai_answer';
      question: string;
      answer: string;
      provider_id: string;
      model_id: string;
      context_text: string;
    };

export interface Annotation {
  schema_version: 1;
  annotation_id: string;
  target: AnnotationTarget;
  body: AnnotationBody;
  created_at: string;
  updated_at: string;
}

export interface SelectionContext {
  selected_text: string;
  context_text: string;
  page_anchors: PageAnchor[];
}

export interface ReferenceItem {
  reference_id: string;
  citation_text: string;
  page_number: number;
  arxiv_id: string | null;
  doi: string | null;
  url: string | null;
}

export interface ReferenceCandidate {
  title: string;
  arxiv_id: string | null;
  doi: string | null;
  url: string;
}

export interface AiSettings {
  base_url: string;
  model_id: string;
  has_api_key: boolean;
}

export interface AiRequest {
  request_id: string;
  paper_id: string;
  selected_text: string;
  context_text: string;
  question: string;
}

export interface AiAnswer {
  answer: string;
  provider_id: string;
  model_id: string;
  context_text: string;
}

export interface OperationProgress {
  request_id: string;
  phase: 'metadata' | 'download' | 'ready' | 'ai';
  message: string;
  received_bytes: number;
  total_bytes: number | null;
}

export type ReaderTarget =
  | { kind: 'internal'; location: ReadingLocation }
  | { kind: 'external'; url: string };

export interface PdfReaderProps {
  paper: Paper;
  pdf_data: Uint8Array;
  annotations: Annotation[];
  target_location: ReadingLocation | null;
  target_anchor?: PageAnchor | null;
  navigation_key: number;
  on_location_change: (location: ReadingLocation) => void;
  on_navigate: (target: ReaderTarget) => void;
  on_selection: (selection: SelectionContext | null) => void;
  on_references: (references: ReferenceItem[]) => void;
  on_error: (message: string) => void;
}
