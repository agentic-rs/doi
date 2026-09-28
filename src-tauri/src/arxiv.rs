use crate::{
  error::{network_error, Result},
  http,
  models::Paper,
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
use tauri::AppHandle;
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
    let value = if trimmed.starts_with("https://") || trimmed.starts_with("http://") {
      let url = Url::parse(trimmed).map_err(|_| "Invalid arXiv URL.".to_string())?;
      if !matches!(
        url.host_str(),
        Some("arxiv.org" | "www.arxiv.org" | "export.arxiv.org")
      ) || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
      {
        return Err("Enter an arXiv ID or an arxiv.org abstract/PDF URL.".into());
      }
      url
        .path()
        .strip_prefix("/abs/")
        .or_else(|| url.path().strip_prefix("/pdf/"))
        .ok_or_else(|| "Use an arXiv abstract or PDF URL.".to_string())?
        .trim_end_matches(".pdf")
        .to_string()
    } else {
      let without_label = if trimmed
        .get(..6)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("arxiv:"))
      {
        &trimmed[6..]
      } else {
        trimmed
      };
      without_label.trim().trim_end_matches(".pdf").to_string()
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
  })
}

pub fn pdf_path(state: &AppState, paper_id: &str) -> PathBuf {
  // A hash filename works for both modern and legacy IDs without exposing path components.
  state
    .pdf_directory
    .join(format!("{:x}.pdf", Sha256::digest(paper_id.as_bytes())))
}

pub async fn open_paper(
  state: &AppState,
  app: &AppHandle,
  input: &str,
  request_id: &str,
) -> Result<Paper> {
  let requested = ArxivId::parse(input)?;
  let _download_guard = state.import_lock.lock().await;
  let cached = if requested.version.is_some() {
    state.database.get_paper(requested.canonical()).await?
  } else {
    state
      .database
      .list_papers()
      .await?
      .into_iter()
      .filter(|paper| paper.arxiv_id == requested.base_id)
      .max_by_key(|paper| paper.arxiv_version)
  };
  if let Some(paper) = cached {
    if tokio::fs::try_exists(pdf_path(state, &paper.paper_id))
      .await
      .map_err(|_| "Could not inspect cached PDF.".to_string())?
    {
      state.progress(app, request_id, "ready", "Opened cached paper.", 0, None);
      return Ok(paper);
    }
  }
  state.progress(
    app,
    request_id,
    "metadata",
    "Looking up the paper on arXiv…",
    0,
    None,
  );
  let mut paper = fetch_metadata(state, &requested).await?;
  if let Some(cached) = state.database.get_paper(paper.paper_id.clone()).await? {
    if tokio::fs::try_exists(pdf_path(state, &cached.paper_id))
      .await
      .map_err(|_| "Could not inspect cached PDF.".to_string())?
    {
      state.progress(app, request_id, "ready", "Opened cached paper.", 0, None);
      return Ok(cached);
    }
  }
  state.progress(
    app,
    request_id,
    "download",
    "Downloading the original PDF…",
    0,
    None,
  );
  let temporary = state
    .pdf_directory
    .join(format!("{}.part", uuid::Uuid::new_v4()));
  let download_result = download_pdf(state, app, &paper, request_id, &temporary).await;
  let hash = match download_result {
    Ok(hash) => hash,
    Err(error) => {
      let _ = tokio::fs::remove_file(&temporary).await;
      return Err(error);
    }
  };
  paper.pdf_hash = hash;
  paper.downloaded_at = chrono::Utc::now().to_rfc3339();
  // Check the revision before replacing a missing cache entry's file.
  if let Some(previous) = state.database.get_paper(paper.paper_id.clone()).await? {
    if previous.pdf_hash != paper.pdf_hash {
      let _ = tokio::fs::remove_file(&temporary).await;
      return Err(
        "The downloaded PDF differs from the saved revision. Existing annotations were preserved."
          .into(),
      );
    }
  }
  tokio::fs::rename(&temporary, pdf_path(state, &paper.paper_id))
    .await
    .map_err(|_| "Could not finalize the cached PDF.".to_string())?;
  let paper = state.database.save_paper(paper).await?;
  state.progress(app, request_id, "ready", "Paper is ready to read.", 0, None);
  Ok(paper)
}

async fn fetch_metadata(state: &AppState, requested: &ArxivId) -> Result<Paper> {
  // The mutex serializes calls; time is recorded even on failed requests.
  let mut last_request = state.arxiv_request_clock.lock().await;
  let wait = Duration::from_secs(3).saturating_sub(last_request.elapsed());
  if !wait.is_zero() {
    tokio::time::sleep(wait).await;
  }
  *last_request = Instant::now();
  let response = state
    .http()?
    .get("https://export.arxiv.org/api/query")
    .query(&[("id_list", requested.canonical())])
    .timeout(Duration::from_secs(30))
    .send()
    .await
    .map_err(|error| network_error("arXiv metadata lookup", error))?;
  http::require_success(&response, "arXiv metadata lookup")?;
  let bytes = http::bounded_body(response, 2 * 1024 * 1024, "arXiv metadata lookup").await?;
  parse_metadata(&bytes, requested)
}

async fn download_pdf(
  state: &AppState,
  app: &AppHandle,
  paper: &Paper,
  request_id: &str,
  temporary: &std::path::Path,
) -> Result<String> {
  let mut response = state
    .http()?
    .get(&paper.pdf_url)
    .send()
    .await
    .map_err(|error| network_error("PDF download", error))?;
  http::require_success(&response, "PDF download")?;
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
      state.progress(
        app,
        request_id,
        "download",
        "Downloading the original PDF…",
        received,
        total,
      );
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
  state.progress(
    app,
    request_id,
    "download",
    "Downloaded the PDF.",
    received,
    total,
  );
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
