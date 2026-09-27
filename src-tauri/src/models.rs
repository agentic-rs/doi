use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct ReadingLocation {
  pub paper_id: String,
  pub page_number: u32,
  pub page_position: [f64; 2],
  pub zoom: f64,
  pub rotation: i32,
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
  pub page_anchors: Vec<PageAnchor>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AnnotationBody {
  Note {
    content: String,
  },
  AiAnswer {
    question: String,
    answer: String,
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

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct AiSettings {
  pub base_url: String,
  pub model_id: String,
  pub has_api_key: bool,
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
  pub provider_id: String,
  pub model_id: String,
  pub context_text: String,
}

#[derive(Debug, Serialize)]
pub struct ReferenceCandidate {
  pub title: String,
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
}
