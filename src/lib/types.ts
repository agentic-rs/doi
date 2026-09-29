export type PdfZoomMode = 'fit_width' | 'custom';
export type ReaderMode = 'pdf' | 'reading';

// Source rectangles are [left, bottom, right, top] in PDF user space.
export type PdfSourceRect = [number, number, number, number];

export interface ReadingBlock {
  block_id: string;
  page_number: number;
  source_rect: PdfSourceRect;
  kind: 'text' | 'figure' | 'original';
  text: string;
  figure_label: string | null;
}

export interface ReadingLayout {
  layout_version: 1;
  pdf_hash: string;
  page_count: number;
  blocks: ReadingBlock[];
}

export interface ReadingLocation {
  paper_id: string;
  page_number: number;
  // Fractions of the rotated page viewport, from its top-left corner.
  page_position: [number, number];
  zoom: number;
  // Older saved locations have only a numeric zoom and retain custom scaling.
  zoom_mode?: PdfZoomMode;
  rotation: number;
  reader_mode?: ReaderMode;
  reading_block_id?: string | null;
}

export type ReaderOrientation = 'portrait' | 'landscape';

export interface ReaderCapabilities {
  supports_orientation: boolean;
  device_kind: 'phone' | 'tablet' | 'desktop' | 'unknown';
}

export interface PaperMetadata {
  paper_id: string;
  arxiv_id: string;
  arxiv_version: number;
  title: string;
  authors: string[];
  abstract: string;
  pdf_url: string;
}

export interface Paper extends PaperMetadata {
  pdf_hash: string;
  downloaded_at: string;
  last_opened_at?: string | null;
  last_location: ReadingLocation | null;
}

export interface PaperPreview {
  preview_id: string;
  metadata: PaperMetadata;
  library_paper: Paper | null;
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
      // Missing on legacy annotations, which display the complete answer.
      note_content?: string;
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
  label: string | null;
  citation_text: string;
  title: string | null;
  authors: string[];
  publication_year: string | null;
  venue: string | null;
  parse_confidence: 'parsed' | 'raw';
  page_number: number;
  source_rect: PdfSourceRect | null;
  arxiv_id: string | null;
  doi: string | null;
  url: string | null;
}

export interface ReferenceCandidate {
  title: string;
  authors: string[];
  publication_year: string | null;
  venue: string | null;
  match_kind: 'identifier' | 'suggestion';
  arxiv_id: string | null;
  doi: string | null;
  url: string;
}

export type AiProviderKind = 'openai' | 'deepseek' | 'zai' | 'zai_coding_plan'
  | 'zhipu' | 'zhipu_coding_plan' | 'openai_compatible';

export interface AiSettings {
  provider_kind: AiProviderKind;
  base_url: string;
  model_id: string;
  has_api_key: boolean;
}

export interface AiModel {
  model_id: string;
  display_name: string;
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
  thinking: string;
  note_proposal: string | null;
  proposal_warning: string | null;
  provider_id: string;
  model_id: string;
  context_text: string;
}

export interface AiConversationTurn {
  turn_id: string;
  question: string;
  answer: string;
  phase: 'pending' | 'complete' | 'incomplete';
  provider_id: string;
  model_id: string;
  error: string | null;
  created_at: string;
}

export interface AiNoteDraft {
  note_id: string;
  content: string;
  answer: string;
  question: string;
  provider_id: string;
  model_id: string;
  context_text: string;
  created_at: string;
  saved_annotation_id: string | null;
  source_turn_count: number;
}

export interface AiConversation {
  conversation_id: string;
  target: AnnotationTarget;
  selected_text: string;
  context_text: string;
  paper_title: string;
  created_at: string;
  updated_at: string;
  turns: AiConversationTurn[];
  note_draft: AiNoteDraft | null;
  active_request_id: string | null;
  active_operation: 'answer' | 'note' | null;
}

export interface AiConversationRequest {
  request_id: string;
  conversation_id: string;
  question: string;
  source?: SelectionContext & { paper_id: string; pdf_hash: string };
}

export interface AiConversationResponse {
  conversation: AiConversation;
  thinking: string;
}

export interface AiConversationSaveResult {
  conversation: AiConversation;
  annotation: Annotation;
}

export interface AiStreamEvent {
  request_id: string;
  kind: 'status' | 'thinking_delta' | 'answer_delta';
  text: string;
}

export interface OperationProgress {
  request_id: string;
  phase: 'metadata' | 'download' | 'ready' | 'ai' | 'waiting';
  message: string;
  received_bytes: number;
  total_bytes: number | null;
  retry_at?: string | null;
}

export type ReaderTarget =
  | { kind: 'internal'; location: ReadingLocation }
  | { kind: 'reference'; reference: ReferenceItem }
  | { kind: 'external'; url: string };

export interface PdfReaderProps {
  paper: Paper;
  pdf_data: Uint8Array;
  annotations: Annotation[];
  target_location: ReadingLocation | null;
  target_anchor?: PageAnchor | null;
  navigation_key: number;
  controls_visible?: boolean;
  on_toggle_controls?: () => void;
  viewport_key?: number;
  initial_fit_width?: boolean;
  reading_active?: boolean;
  on_location_change: (location: ReadingLocation) => void;
  on_navigate: (target: ReaderTarget) => void;
  on_selection: (selection: SelectionContext | null) => void;
  on_references: (references: ReferenceItem[], status?: 'loading' | 'ready' | 'error') => void;
  on_error: (message: string) => void;
}
