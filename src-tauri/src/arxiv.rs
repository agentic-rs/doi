use crate::{
  error::{network_error, Result},
  http,
  models::{OperationProgress, Paper, PaperMetadata, PaperPreview},
  state::AppState,
};
use regex::Regex;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
  path::PathBuf,
  sync::OnceLock,
  time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter};

mod cancellation;
mod rate_limit;
mod service;
pub use service::ArxivState;
use tokio::io::AsyncWriteExt;
use url::Url;

const MAX_PDF_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq)]
pub struct ArxivId {
  pub base_id: String,
  pub version: Option<u32>,
}

impl ArxivId {
  pub fn parse(input: &str) -> Result<Self> {
    let trimmed = input.trim();
    if trimmed.len() > 1024 {
      return Err("The arXiv identifier is too long.".into());
    }
    let trimmed = trimmed
      .trim_start_matches(['<', '"', '\''])
      .trim_end_matches(['.', ',', ';', ':', ')', ']', '}', '>', '"', '\'']);
    let without_scheme = trimmed.split('/').next().is_some_and(|host| {
      ["arxiv.org", "www.arxiv.org", "export.arxiv.org"]
        .iter()
        .any(|allowed| host.eq_ignore_ascii_case(allowed))
    });
    let value = if trimmed.contains("://") || without_scheme {
      let normalized = if without_scheme {
        format!("https://{trimmed}")
      } else {
        trimmed.to_owned()
      };
      let url = Url::parse(&normalized).map_err(|_| "Invalid arXiv URL.".to_string())?;
      if !matches!(url.scheme(), "http" | "https")
        || !matches!(
          url.host_str(),
          Some("arxiv.org" | "www.arxiv.org" | "export.arxiv.org")
        )
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
      {
        return Err("Enter an arXiv ID or an arxiv.org abstract/PDF/HTML URL.".into());
      }
      let path = percent_encoding::percent_decode_str(url.path())
        .decode_utf8()
        .map_err(|_| "Invalid arXiv URL path.".to_string())?;
      let path = path.trim_end_matches('/');
      let identifier = path
        .strip_prefix("/abs/")
        .or_else(|| path.strip_prefix("/pdf/"))
        .or_else(|| path.strip_prefix("/html/"))
        .ok_or_else(|| "Use an arXiv abstract, PDF, or HTML URL.".to_string())?;
      identifier
        .strip_suffix(".pdf")
        .unwrap_or(identifier)
        .to_owned()
    } else {
      let without_label = if trimmed
        .get(..6)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("arxiv:"))
      {
        &trimmed[6..]
      } else {
        trimmed
      };
      let identifier = without_label.trim();
      identifier
        .strip_suffix(".pdf")
        .unwrap_or(identifier)
        .to_owned()
    };
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    let pattern = PATTERN.get_or_init(|| Regex::new(
      r"^(?<base>(?:[0-9]{2}(?:0[1-9]|1[0-2])\.[0-9]{4,5}|[a-z][a-z-]*(?:\.[A-Za-z]{2})?/[0-9]{2}(?:0[1-9]|1[0-2])[0-9]{3}))(?:(?:v)(?<version>[1-9][0-9]{0,3}))?$"
    ).expect("constant arXiv identifier pattern"));
    let captures = pattern.captures(&value).ok_or_else(|| {
      "Invalid arXiv ID. Use 2401.12345, hep-th/9901001, or an optional v2 suffix.".to_string()
    })?;
    Ok(Self {
      base_id: captures["base"].to_owned(),
      version: captures
        .name("version")
        .map(|value| value.as_str().parse().expect("bounded version")),
    })
  }

  pub fn canonical(&self) -> String {
    match self.version {
      Some(version) => format!("{}v{version}", self.base_id),
      None => self.base_id.clone(),
    }
  }
}

#[derive(Deserialize)]
struct Feed {
  #[serde(default)]
  entry: Vec<Entry>,
}

#[derive(Deserialize)]
struct Entry {
  id: String,
  title: String,
  summary: String,
  #[serde(default)]
  author: Vec<Author>,
}

#[derive(Deserialize)]
struct Author {
  name: String,
}

fn compact_text(text: &str) -> String {
  text.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn parse_metadata(bytes: &[u8], requested: &ArxivId) -> Result<Paper> {
  let xml = std::str::from_utf8(bytes).map_err(|_| "arXiv metadata was not UTF-8.".to_string())?;
  let feed: Feed =
    quick_xml::de::from_str(xml).map_err(|_| "arXiv returned invalid metadata.".to_string())?;
  let entry = feed
    .entry
    .into_iter()
    .next()
    .ok_or_else(|| "No paper was found for that arXiv ID.".to_string())?;
  let resolved = ArxivId::parse(&entry.id)
    .map_err(|_| "arXiv did not return a valid paper revision.".to_string())?;
  if resolved.base_id != requested.base_id
    || resolved.version.is_none()
    || requested
      .version
      .is_some_and(|version| resolved.version != Some(version))
  {
    return Err(
      "arXiv returned a different paper revision. The requested version may not exist.".into(),
    );
  }
  let paper_id = resolved.canonical();
  let title = compact_text(&entry.title);
  if title.is_empty() {
    return Err("arXiv returned a paper without a title.".into());
  }
  Ok(Paper {
    paper_id: paper_id.clone(),
    arxiv_id: resolved.base_id,
    arxiv_version: resolved.version.expect("checked revision"),
    title,
    authors: entry
      .author
      .into_iter()
      .map(|author| compact_text(&author.name))
      .collect(),
    r#abstract: entry.summary.trim().to_owned(),
    pdf_url: format!("https://arxiv.org/pdf/{paper_id}"),
    pdf_hash: String::new(),
    downloaded_at: String::new(),
    last_location: None,
    last_opened_at: None,
  })
}

pub fn pdf_path(state: &AppState, paper_id: &str) -> PathBuf {
  // A hash filename works for both modern and legacy IDs without exposing path components.
  state
    .pdf_directory
    .join(format!("{:x}.pdf", Sha256::digest(paper_id.as_bytes())))
}

struct Progress<'a> {
  request_id: &'a str,
  emit: &'a (dyn Fn(OperationProgress) + Send + Sync),
}

impl Progress<'_> {
  fn emit(
    &self,
    phase: &'static str,
    message: &str,
    received_bytes: u64,
    total_bytes: Option<u64>,
  ) {
    (self.emit)(OperationProgress {
      request_id: self.request_id.to_owned(),
      phase,
      message: message.to_owned(),
      received_bytes,
      total_bytes,
      retry_at: None,
    });
  }

  fn waiting(&self, retry_at: chrono::DateTime<chrono::Utc>) {
    (self.emit)(OperationProgress {
      request_id: self.request_id.to_owned(),
      phase: "waiting",
      message: "Waiting for arXiv… You can cancel and keep reading your library.".into(),
      received_bytes: 0,
      total_bytes: None,
      retry_at: Some(retry_at.to_rfc3339()),
    });
  }
}

impl From<&Paper> for PaperMetadata {
  fn from(paper: &Paper) -> Self {
    Self {
      paper_id: paper.paper_id.clone(),
      arxiv_id: paper.arxiv_id.clone(),
      arxiv_version: paper.arxiv_version,
      title: paper.title.clone(),
      authors: paper.authors.clone(),
      r#abstract: paper.r#abstract.clone(),
      pdf_url: paper.pdf_url.clone(),
    }
  }
}

impl From<PaperMetadata> for Paper {
  fn from(metadata: PaperMetadata) -> Self {
    Self {
      paper_id: metadata.paper_id,
      arxiv_id: metadata.arxiv_id,
      arxiv_version: metadata.arxiv_version,
      title: metadata.title,
      authors: metadata.authors,
      r#abstract: metadata.r#abstract,
      pdf_url: metadata.pdf_url,
      pdf_hash: String::new(),
      downloaded_at: String::new(),
      last_location: None,
      last_opened_at: None,
    }
  }
}

pub fn cancel_operation(state: &AppState, request_id: &str) -> Result<()> {
  state.arxiv.operations.cancel(request_id)
}

pub async fn preview_paper(
  state: &AppState,
  app: &AppHandle,
  input: &str,
  request_id: &str,
) -> Result<PaperPreview> {
  let emit = |event| {
    let _ = app.emit("operation-progress", event);
  };
  preview(
    state,
    input,
    &Progress {
      request_id,
      emit: &emit,
    },
  )
  .await
}

async fn cached_paper(state: &AppState, requested: &ArxivId) -> Result<Option<Paper>> {
  if requested.version.is_some() {
    state.database.get_paper(requested.canonical()).await
  } else {
    Ok(
      state
        .database
        .list_papers()
        .await?
        .into_iter()
        .filter(|paper| paper.arxiv_id == requested.base_id)
        .max_by_key(|paper| paper.arxiv_version),
    )
  }
}

async fn available_paper(state: &AppState, paper_id: &str) -> Result<Option<Paper>> {
  if let Some(paper) = state.database.get_paper(paper_id.to_owned()).await? {
    if tokio::fs::try_exists(pdf_path(state, paper_id))
      .await
      .map_err(|_| "Could not inspect cached PDF.".to_string())?
    {
      return Ok(Some(paper));
    }
  }
  Ok(None)
}

async fn preview(state: &AppState, input: &str, progress: &Progress<'_>) -> Result<PaperPreview> {
  let requested = ArxivId::parse(input)?;
  let mut active = state.arxiv.operations.register(progress.request_id)?;
  active
    .run(async {
      // Register before waiting so Cancel also interrupts queued operations.
      let _import_guard = state.import_lock.lock().await;
      let cached = cached_paper(state, &requested).await?;
      let metadata = if let Some(paper) = &cached {
        PaperMetadata::from(paper)
      } else if let Some(metadata) = state.arxiv.cached_metadata(&requested.canonical()) {
        metadata
      } else {
        progress.emit("metadata", "Looking up the paper on arXiv…", 0, None);
        let response = rate_limit::send(state, progress, "arXiv metadata lookup", || {
          Ok(
            state
              .http()?
              .get(&state.arxiv.metadata_url)
              .query(&[("id_list", requested.canonical())])
              .timeout(Duration::from_secs(30)),
          )
        })
        .await?;
        let bytes = http::bounded_body(response, 2 * 1024 * 1024, "arXiv metadata lookup").await?;
        PaperMetadata::from(&parse_metadata(&bytes, &requested)?)
      };
      let library_paper = available_paper(state, &metadata.paper_id).await?;
      let preview_id = state
        .arxiv
        .insert_preview(requested.canonical(), metadata.clone());
      progress.emit("ready", "Paper preview is ready.", 0, None);
      Ok(PaperPreview {
        preview_id,
        metadata,
        library_paper,
      })
    })
    .await
}

pub async fn download_paper(
  state: &AppState,
  app: &AppHandle,
  preview_id: &str,
  request_id: &str,
) -> Result<Paper> {
  let emit = |event| {
    let _ = app.emit("operation-progress", event);
  };
  download(
    state,
    preview_id,
    &Progress {
      request_id,
      emit: &emit,
    },
  )
  .await
}

async fn download(state: &AppState, preview_id: &str, progress: &Progress<'_>) -> Result<Paper> {
  crate::validation::validate_id(preview_id)?;
  let mut active = state.arxiv.operations.register(progress.request_id)?;
  let _import_guard = active
    .run(async { Ok(state.import_lock.lock().await) })
    .await?;
  // Check the token only after acquiring the same gate used by library deletion.
  let metadata = state.arxiv.preview(preview_id).ok_or_else(|| {
    "This preview has expired or the paper was removed. Look up the paper again.".to_string()
  })?;
  if let Some(paper) = active
    .run(available_paper(state, &metadata.paper_id))
    .await?
  {
    progress.emit("ready", "Opened cached paper.", 0, None);
    return Ok(paper);
  }
  let temporary_path = state
    .pdf_directory
    .join(format!("{}.part", uuid::Uuid::new_v4()));
  let mut temporary = TemporaryPdf {
    path: temporary_path,
    keep: false,
  };
  let mut paper = Paper::from(metadata);
  let hash = active
    .run(download_pdf(state, progress, &paper, &temporary.path))
    .await?;
  paper.pdf_hash = hash;
  paper.downloaded_at = chrono::Utc::now().to_rfc3339();
  if let Some(previous) = active
    .run(state.database.get_paper(paper.paper_id.clone()))
    .await?
  {
    if previous.pdf_hash != paper.pdf_hash {
      return Err(
        "The downloaded PDF differs from the saved revision. Existing annotations were preserved."
          .into(),
      );
    }
  }
  // This is the short commit boundary: cancellation stops all waits, requests,
  // and file streaming above. Once committing, finish or roll back both files
  // and database rather than dropping a SQLite operation midway through it.
  active.check()?;
  let final_path = pdf_path(state, &paper.paper_id);
  tokio::fs::rename(&temporary.path, &final_path)
    .await
    .map_err(|_| "Could not finalize the cached PDF.".to_string())?;
  temporary.path = final_path;
  let paper = state.database.save_paper(paper).await?;
  temporary.keep = true;
  progress.emit("ready", "Paper is ready to read.", 0, None);
  Ok(paper)
}

struct TemporaryPdf {
  path: PathBuf,
  keep: bool,
}
impl Drop for TemporaryPdf {
  fn drop(&mut self) {
    if !self.keep {
      let _ = std::fs::remove_file(&self.path);
    }
  }
}

async fn download_pdf(
  state: &AppState,
  progress: &Progress<'_>,
  paper: &Paper,
  temporary: &std::path::Path,
) -> Result<String> {
  progress.emit("download", "Downloading the original PDF…", 0, None);
  let mut response = rate_limit::send(state, progress, "PDF download", || {
    Ok(
      state
        .http()?
        .get(format!("{}{}", state.arxiv.pdf_base_url, paper.paper_id)),
    )
  })
  .await?;
  let total = response.content_length();
  if total.is_some_and(|bytes| bytes > MAX_PDF_BYTES) {
    return Err("The PDF exceeds the 256 MB download limit.".into());
  }
  let mut file = tokio::fs::OpenOptions::new()
    .write(true)
    .create_new(true)
    .open(temporary)
    .await
    .map_err(|_| "Could not create the PDF cache file.".to_string())?;
  let mut digest = Sha256::new();
  let mut received = 0_u64;
  let mut prefix = Vec::with_capacity(1024);
  let mut last_progress = Instant::now() - Duration::from_secs(1);
  while let Some(chunk) = response
    .chunk()
    .await
    .map_err(|error| network_error("PDF download", error))?
  {
    received += chunk.len() as u64;
    if received > MAX_PDF_BYTES {
      return Err("The PDF exceeds the 256 MB download limit.".into());
    }
    if prefix.len() < 1024 {
      prefix.extend_from_slice(&chunk[..chunk.len().min(1024 - prefix.len())]);
    }
    digest.update(&chunk);
    file
      .write_all(&chunk)
      .await
      .map_err(|_| "Could not write the PDF cache file.".to_string())?;
    if last_progress.elapsed() >= Duration::from_millis(120) {
      progress.emit("download", "Downloading the original PDF…", received, total);
      last_progress = Instant::now();
    }
  }
  if received == 0 || !prefix.windows(5).any(|bytes| bytes == b"%PDF-") {
    return Err("arXiv returned a response that is not a PDF.".into());
  }
  if total.is_some_and(|expected| expected != received) {
    return Err("The PDF download was incomplete. Please try again.".into());
  }
  file
    .flush()
    .await
    .map_err(|_| "Could not flush the PDF cache file.".to_string())?;
  file
    .sync_all()
    .await
    .map_err(|_| "Could not save the PDF cache file.".to_string())?;
  progress.emit("download", "Downloaded the PDF.", received, total);
  Ok(format!("{:x}", digest.finalize()))
}

pub async fn read_pdf(state: &AppState, paper_id: String) -> Result<Vec<u8>> {
  let paper = state
    .database
    .get_paper(paper_id)
    .await?
    .ok_or_else(|| "That paper is not in the local library.".to_string())?;
  let bytes = tokio::fs::read(pdf_path(state, &paper.paper_id))
    .await
    .map_err(|_| {
      "The cached PDF is missing. Open its arXiv ID again to download it.".to_string()
    })?;
  let expected_hash = paper.pdf_hash;
  // Hashing potentially large files stays off the async runtime workers.
  tauri::async_runtime::spawn_blocking(move || {
    if format!("{:x}", Sha256::digest(&bytes)) != expected_hash {
      return Err("The cached PDF no longer matches its original revision. Restore it before reading annotations.".into());
    }
    Ok(bytes)
  }).await.map_err(|_| "The PDF integrity check was interrupted.".to_string())?
}

#[cfg(test)]
#[path = "arxiv/tests.rs"]
mod workflow_tests;

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn accepts_modern_legacy_and_versioned_ids() {
    for (input, expected) in [
      ("arXiv:2401.12345v2", "2401.12345v2"),
      ("https://arxiv.org/pdf/1706.03762.pdf", "1706.03762"),
      ("http://arxiv.org/abs/hep-th/9901001v3", "hep-th/9901001v3"),
      ("math.GT/0309136", "math.GT/0309136"),
      ("0704.0001", "0704.0001"),
      ("https://arxiv.org/html/1706.03762v7/", "1706.03762v7"),
      (
        "HTTPS://WWW.ARXIV.ORG/abs/1706.03762v2?download=1#page=3",
        "1706.03762v2",
      ),
      (
        "https://export.arxiv.org/pdf/hep-th/9901001v3.pdf/).",
        "hep-th/9901001v3",
      ),
      (
        "https://arxiv.org/abs/hep-th%2F9901001v3",
        "hep-th/9901001v3",
      ),
      ("arxiv.org/abs/1706.03762v2", "1706.03762v2"),
      ("arXiv:1706.03762v2].", "1706.03762v2"),
    ] {
      assert_eq!(ArxivId::parse(input).unwrap().canonical(), expected);
    }
    for input in [
      "2413.12345",
      "2400.12345",
      "2401.123",
      "2401.12345v0",
      "../2401.12345",
      "https://evil.test/abs/2401.12345",
      "https://arxiv.org.evil.test/pdf/2401.12345",
      "2401.12345v99999",
      "https://arxiv.org.evil.test/html/1706.03762",
      "https://user@arxiv.org/abs/1706.03762",
      "https://arxiv.org:8443/abs/1706.03762",
      "https://evil.test/arxiv.org/abs/1706.03762",
      "ftp://arxiv.org/abs/1706.03762",
      "https://arxiv.org/abs/1706.03762%2Fevil",
      "https://arxiv.org/abs/1706.03762%FF",
      "https://arxiv.org/abs/1706.03762.pdf.pdf",
    ] {
      assert!(ArxivId::parse(input).is_err(), "{input}");
    }
  }

  #[test]
  fn metadata_is_pinned_and_preserves_entities() {
    let xml = br#"<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry>
      <id>http://arxiv.org/abs/2401.12345v2</id><title> Title &amp;   findings </title>
      <summary>An abstract.</summary><author><name>First Author</name></author>
      <author><name>Second Author</name></author></entry></feed>"#;
    let paper = parse_metadata(xml, &ArxivId::parse("2401.12345").unwrap()).unwrap();
    assert_eq!(paper.paper_id, "2401.12345v2");
    assert_eq!(paper.title, "Title & findings");
    assert_eq!(paper.authors.len(), 2);
    assert!(parse_metadata(xml, &ArxivId::parse("2401.12345v1").unwrap()).is_err());
    assert!(parse_metadata(
      br#"<feed xmlns="http://www.w3.org/2005/Atom"/>"#,
      &ArxivId::parse("2401.12345").unwrap()
    )
    .is_err());
  }

  #[test]
  fn real_arxiv_atom_metadata_resolves_concrete_revision() {
    let bytes = include_bytes!("../tests/fixtures/arxiv-1706.03762.xml");
    let paper = parse_metadata(bytes, &ArxivId::parse("1706.03762").unwrap()).unwrap();
    assert_eq!(paper.paper_id, "1706.03762v7");
    assert_eq!(paper.title, "Attention Is All You Need");
    assert_eq!(paper.authors.len(), 8);
    assert_eq!(paper.authors[0], "Ashish Vaswani");
    assert_eq!(paper.pdf_url, "https://arxiv.org/pdf/1706.03762v7");
    assert!(paper.r#abstract.contains("Transformer"));
  }
}
