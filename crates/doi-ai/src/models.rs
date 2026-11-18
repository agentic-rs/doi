use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PdfZoomMode {
  FitWidth,
  #[default]
  Custom,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReaderMode {
  #[default]
  Pdf,
  Reading,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct ReadingLocation {
  pub paper_id: String,
  pub page_number: u32,
  pub page_position: [f64; 2],
  pub zoom: f64,
  #[serde(default)]
  pub zoom_mode: PdfZoomMode,
  pub rotation: i32,
  #[serde(default)]
  pub reader_mode: ReaderMode,
  #[serde(default)]
  pub reading_block_id: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReadingBlockKind {
  Text,
  Figure,
  Original,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReadingBlockType {
  Content,
  Equation,
  Graph,
  Table,
  Reference,
  Title,
  Others,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct ReadingBlock {
  pub block_id: String,
  pub page_number: u32,
  /// [left, bottom, right, top] in the original PDF's user space.
  pub source_rect: [f64; 4],
  pub kind: ReadingBlockKind,
  /// Semantic classification; `kind` still controls rendering and figure placement.
  pub block_type: ReadingBlockType,
  pub text: String,
  pub figure_label: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct ReadingLayout {
  pub layout_version: u32,
  pub pdf_hash: String,
  pub page_count: u32,
  pub blocks: Vec<ReadingBlock>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct ReadingBlockPreference {
  pub pdf_hash: String,
  pub page_number: u32,
  /// [left, bottom, right, top] in the original PDF's user space.
  pub source_rect: [f64; 4],
  pub split_lines: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PaperMetadata {
  pub paper_id: String,
  pub arxiv_id: String,
  pub arxiv_version: u32,
  pub title: String,
  pub authors: Vec<String>,
  pub r#abstract: String,
  pub pdf_url: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct PaperPreview {
  pub preview_id: String,
  pub metadata: PaperMetadata,
  pub library_paper: Option<Paper>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Paper {
  pub paper_id: String,
  pub arxiv_id: String,
  pub arxiv_version: u32,
  pub title: String,
  pub authors: Vec<String>,
  pub r#abstract: String,
  pub pdf_url: String,
  pub pdf_hash: String,
  pub downloaded_at: String,
  #[serde(default)]
  pub last_opened_at: Option<String>,
  pub last_location: Option<ReadingLocation>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct TextQuote {
  pub exact_text: String,
  pub prefix: String,
  pub suffix: String,
  pub normalization_version: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PageAnchor {
  pub page_number: u32,
  pub quad_points: Vec<[f64; 8]>,
  pub text_quote: TextQuote,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AnnotationTarget {
  pub paper_id: String,
  pub pdf_hash: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub scope: Option<AnnotationScope>,
  pub page_anchors: Vec<PageAnchor>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AnnotationScope {
  Paper,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct NoteCitation {
  pub citation_id: String,
  pub anchor: PageAnchor,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AnnotationBody {
  Note {
    content: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    citations: Vec<NoteCitation>,
  },
  AiAnswer {
    question: String,
    answer: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    note_content: Option<String>,
    provider_id: String,
    model_id: String,
    context_text: String,
  },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Annotation {
  pub schema_version: u32,
  pub annotation_id: String,
  pub target: AnnotationTarget,
  pub body: AnnotationBody,
  pub created_at: String,
  pub updated_at: String,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AiProviderKind {
  Openai,
  Deepseek,
  Zai,
  ZaiCodingPlan,
  Zhipu,
  ZhipuCodingPlan,
  // Settings saved before embedded Tokn always used the compatible protocol.
  #[default]
  OpenaiCompatible,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AiSettings {
  #[serde(default)]
  pub provider_kind: AiProviderKind,
  pub base_url: String,
  pub model_id: String,
  pub has_api_key: bool,
}

impl Default for AiSettings {
  fn default() -> Self {
    Self {
      provider_kind: AiProviderKind::Openai,
      base_url: "https://api.openai.com/v1".into(),
      model_id: String::new(),
      has_api_key: false,
    }
  }
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct AiModel {
  pub model_id: String,
  pub display_name: String,
}

#[derive(Debug, Deserialize)]
pub struct AiRequest {
  pub request_id: String,
  pub paper_id: String,
  pub selected_text: String,
  pub context_text: String,
  pub question: String,
}

#[derive(Debug, Serialize)]
pub struct AiAnswer {
  pub answer: String,
  pub thinking: String,
  pub note_proposal: Option<String>,
  pub proposal_warning: Option<String>,
  pub provider_id: String,
  pub model_id: String,
  pub context_text: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AiTurnPhase {
  Pending,
  Complete,
  Incomplete,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AiConversationOperation {
  Answer,
  Note,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AiConversationTurn {
  pub turn_id: String,
  pub question: String,
  pub answer: String,
  pub phase: AiTurnPhase,
  pub provider_id: String,
  pub model_id: String,
  pub error: Option<String>,
  pub created_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AiNoteDraft {
  pub note_id: String,
  pub content: String,
  pub answer: String,
  pub question: String,
  pub provider_id: String,
  pub model_id: String,
  pub context_text: String,
  pub created_at: String,
  pub saved_annotation_id: Option<String>,
  pub source_turn_count: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AiConversation {
  pub conversation_id: String,
  pub target: AnnotationTarget,
  pub selected_text: String,
  pub context_text: String,
  pub paper_title: String,
  pub created_at: String,
  pub updated_at: String,
  pub turns: Vec<AiConversationTurn>,
  pub note_draft: Option<AiNoteDraft>,
  pub active_request_id: Option<String>,
  pub active_operation: Option<AiConversationOperation>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct AiConversationSource {
  pub paper_id: String,
  pub pdf_hash: String,
  pub selected_text: String,
  pub context_text: String,
  pub page_anchors: Vec<PageAnchor>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct AiConversationRequest {
  pub request_id: String,
  pub conversation_id: String,
  pub question: String,
  pub source: Option<AiConversationSource>,
}

#[derive(Debug, Serialize)]
pub struct AiConversationResponse {
  pub conversation: AiConversation,
  pub thinking: String,
}

#[derive(Debug, Serialize)]
pub struct AiConversationSaveResult {
  pub conversation: AiConversation,
  pub annotation: Annotation,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AiStreamKind {
  Status,
  ThinkingDelta,
  AnswerDelta,
}

#[derive(Clone, Debug, Serialize)]
pub struct AiStreamEvent {
  pub request_id: String,
  pub kind: AiStreamKind,
  pub text: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct ReferenceCandidate {
  pub title: String,
  pub authors: Vec<String>,
  pub publication_year: Option<String>,
  pub venue: Option<String>,
  pub match_kind: String,
  pub arxiv_id: Option<String>,
  pub doi: Option<String>,
  pub url: String,
}

#[derive(Clone, Serialize)]
pub struct OperationProgress {
  pub request_id: String,
  pub phase: &'static str,
  pub message: String,
  pub received_bytes: u64,
  pub total_bytes: Option<u64>,
  pub retry_at: Option<String>,
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn legacy_reading_locations_keep_their_custom_numeric_zoom() {
    let legacy = serde_json::json!({
      "paper_id": "2401.12345v2",
      "page_number": 2,
      "page_position": [0.0, 0.5],
      "zoom": 1.35,
      "rotation": 90
    });
    let location: ReadingLocation = serde_json::from_value(legacy.clone()).unwrap();
    assert_eq!(location.zoom_mode, PdfZoomMode::Custom);
    assert_eq!(location.reader_mode, ReaderMode::Pdf);
    assert_eq!(location.reading_block_id, None);
    assert_eq!(location.zoom, 1.35);
    assert_eq!(
      serde_json::to_value(location).unwrap()["zoom_mode"],
      "custom"
    );

    let mut unsupported = legacy;
    unsupported["zoom_mode"] = "fit_height".into();
    assert!(serde_json::from_value::<ReadingLocation>(unsupported).is_err());
  }
}
