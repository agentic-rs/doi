use super::cancellation::OperationRegistry;
use crate::models::PaperMetadata;
use chrono::{DateTime, Utc};
use std::{
  collections::HashMap,
  path::PathBuf,
  sync::Mutex,
  time::{Duration, Instant},
};

const MAX_PREVIEWS: usize = 64;
const PREVIEW_TTL: Duration = Duration::from_secs(24 * 60 * 60);

pub struct ArxivState {
  pub(super) operations: OperationRegistry,
  pub(super) rate: tokio::sync::Mutex<RateState>,
  pub(super) policy: RetryPolicy,
  pub(super) metadata_url: String,
  pub(super) pdf_base_url: String,
  previews: Mutex<HashMap<String, CachedPreview>>,
}

pub(super) struct RateState {
  pub last_request: Instant,
  pub cooldown: Option<DateTime<Utc>>,
  pub cooldown_path: PathBuf,
}

pub(super) struct RetryPolicy {
  pub spacing: Duration,
  pub backoff: Duration,
  pub jitter: Duration,
  pub max_retries: u32,
}

struct CachedPreview {
  metadata: PaperMetadata,
  requested: String,
  created_at: Instant,
}

impl ArxivState {
  pub fn new(data_directory: &std::path::Path) -> Self {
    let cooldown_path = data_directory.join("arxiv-cooldown.json");
    let cooldown = std::fs::read(&cooldown_path)
      .ok()
      .and_then(|bytes| serde_json::from_slice::<DateTime<Utc>>(&bytes).ok())
      .filter(|time| *time > Utc::now());
    Self {
      operations: OperationRegistry::default(),
      rate: tokio::sync::Mutex::new(RateState {
        last_request: Instant::now() - Duration::from_secs(3),
        cooldown,
        cooldown_path,
      }),
      policy: RetryPolicy {
        spacing: Duration::from_secs(3),
        backoff: Duration::from_secs(15),
        jitter: Duration::from_secs(3),
        max_retries: 3,
      },
      metadata_url: "https://export.arxiv.org/api/query".into(),
      pdf_base_url: "https://arxiv.org/pdf/".into(),
      previews: Mutex::new(HashMap::new()),
    }
  }

  /// Call while holding AppState.import_lock so queued downloads cannot revive a removed paper.
  pub fn invalidate_paper(&self, paper_id: &str) {
    self
      .previews
      .lock()
      .unwrap_or_else(|error| error.into_inner())
      .retain(|_, preview| preview.metadata.paper_id != paper_id);
  }

  pub(super) fn cached_metadata(&self, requested: &str) -> Option<PaperMetadata> {
    let mut previews = self
      .previews
      .lock()
      .unwrap_or_else(|error| error.into_inner());
    previews.retain(|_, preview| preview.created_at.elapsed() < PREVIEW_TTL);
    previews
      .values()
      .filter(|preview| preview.requested == requested || preview.metadata.paper_id == requested)
      .max_by_key(|preview| preview.created_at)
      .map(|preview| preview.metadata.clone())
  }

  pub(super) fn insert_preview(&self, requested: String, metadata: PaperMetadata) -> String {
    let mut previews = self
      .previews
      .lock()
      .unwrap_or_else(|error| error.into_inner());
    previews.retain(|_, preview| preview.created_at.elapsed() < PREVIEW_TTL);
    if previews.len() >= MAX_PREVIEWS {
      if let Some(oldest) = previews
        .iter()
        .min_by_key(|(_, preview)| preview.created_at)
        .map(|(id, _)| id.clone())
      {
        previews.remove(&oldest);
      }
    }
    let preview_id = uuid::Uuid::new_v4().to_string();
    previews.insert(
      preview_id.clone(),
      CachedPreview {
        metadata,
        requested,
        created_at: Instant::now(),
      },
    );
    preview_id
  }

  pub(super) fn preview(&self, preview_id: &str) -> Option<PaperMetadata> {
    self
      .previews
      .lock()
      .unwrap_or_else(|error| error.into_inner())
      .get(preview_id)
      .filter(|preview| preview.created_at.elapsed() < PREVIEW_TTL)
      .map(|preview| preview.metadata.clone())
  }
}
