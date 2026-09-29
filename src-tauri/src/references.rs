use crate::{
  arxiv::ArxivId,
  error::{network_error, Result},
  http,
  models::ReferenceCandidate,
  state::AppState,
  validation,
};
use regex::Regex;
use serde::Deserialize;
use std::{
  collections::{HashMap, HashSet},
  sync::{Mutex, OnceLock},
  time::{Duration, Instant},
};
use url::Url;

const MAX_CACHED_RESOLUTIONS: usize = 128;
const MAX_CACHED_RESOLUTION_BYTES: usize = 64 * 1024;
const RESOLUTION_TTL: Duration = Duration::from_secs(30 * 60);

#[derive(Default)]
pub struct ResolverCache {
  entries: Mutex<HashMap<String, CachedResolution>>,
}

struct CachedResolution {
  candidates: Vec<ReferenceCandidate>,
  fetched_at: Instant,
}

impl ResolverCache {
  fn get(&self, key: &str) -> Option<Vec<ReferenceCandidate>> {
    let mut entries = self
      .entries
      .lock()
      .unwrap_or_else(|error| error.into_inner());
    entries.retain(|_, entry| entry.fetched_at.elapsed() < RESOLUTION_TTL);
    entries.get(key).map(|entry| entry.candidates.clone())
  }

  fn insert(&self, key: String, candidates: Vec<ReferenceCandidate>) {
    if !serde_json::to_vec(&candidates)
      .is_ok_and(|bytes| bytes.len() <= MAX_CACHED_RESOLUTION_BYTES)
    {
      return;
    }
    let mut entries = self
      .entries
      .lock()
      .unwrap_or_else(|error| error.into_inner());
    entries.retain(|_, entry| entry.fetched_at.elapsed() < RESOLUTION_TTL);
    if entries.len() >= MAX_CACHED_RESOLUTIONS {
      if let Some(oldest) = entries
        .iter()
        .min_by_key(|(_, entry)| entry.fetched_at)
        .map(|(key, _)| key.clone())
      {
        entries.remove(&oldest);
      }
    }
    entries.insert(
      key,
      CachedResolution {
        candidates,
        fetched_at: Instant::now(),
      },
    );
  }
}

#[derive(Deserialize)]
struct CrossrefEnvelope {
  message: serde_json::Value,
}

#[derive(Deserialize)]
struct CrossrefList {
  #[serde(default)]
  items: Vec<CrossrefWork>,
}

#[derive(Deserialize)]
struct CrossrefWork {
  #[serde(rename = "DOI")]
  doi: String,
  #[serde(default)]
  title: Vec<String>,
  author: Option<Vec<CrossrefAuthor>>,
  #[serde(rename = "container-title")]
  container_title: Option<Vec<String>>,
  published: Option<CrossrefDate>,
  #[serde(rename = "published-print")]
  published_print: Option<CrossrefDate>,
  #[serde(rename = "published-online")]
  published_online: Option<CrossrefDate>,
  issued: Option<CrossrefDate>,
}

#[derive(Deserialize)]
struct CrossrefAuthor {
  name: Option<String>,
  given: Option<String>,
  family: Option<String>,
}

#[derive(Deserialize)]
struct CrossrefDate {
  #[serde(default, rename = "date-parts")]
  date_parts: Vec<Vec<Option<u32>>>,
}

fn compact_text(value: &str) -> String {
  value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn doi_url(doi: &str) -> String {
  let mut url = Url::parse("https://doi.org/").expect("constant DOI URL");
  url.set_path(doi);
  url.to_string()
}

fn arxiv_candidate(id: ArxivId) -> ReferenceCandidate {
  let canonical = id.canonical();
  ReferenceCandidate {
    title: format!("arXiv {canonical}"),
    authors: Vec::new(),
    publication_year: None,
    venue: None,
    match_kind: "identifier".into(),
    arxiv_id: Some(canonical.clone()),
    doi: None,
    url: format!("https://arxiv.org/abs/{canonical}"),
  }
}

pub fn explicit_candidates(citation: &str) -> Vec<ReferenceCandidate> {
  static URL_PATTERN: OnceLock<Regex> = OnceLock::new();
  let urls = URL_PATTERN.get_or_init(|| {
    Regex::new(
      r#"(?i)\b(?:[a-z][a-z0-9+.-]*://[^\s<>"']+|[a-z0-9][a-z0-9.-]*\.[a-z]{2,}/[^\s<>"']+)"#,
    )
    .expect("constant citation URL pattern")
  });
  static LABEL_PATTERN: OnceLock<Regex> = OnceLock::new();
  let labels = LABEL_PATTERN.get_or_init(|| {
    Regex::new(r#"(?i)\barxiv(?:\s*:\s*|\s+)([^\s<>"']+)"#).expect("constant arXiv label pattern")
  });
  let mut seen = HashSet::new();
  let mut candidates = Vec::new();
  let mut add = |value: &str| {
    if let Ok(id) = ArxivId::parse(value) {
      if candidates.len() < 10 && seen.insert(id.canonical()) {
        candidates.push(arxiv_candidate(id));
      }
    }
  };
  add(citation);
  let mut label_text = citation.to_owned();
  let url_matches = urls.find_iter(citation).collect::<Vec<_>>();
  for matched in &url_matches {
    let embedded = citation[..matched.start()]
      .chars()
      .next_back()
      .is_some_and(|character| {
        character.is_alphanumeric() || matches!(character, '@' | '/' | '\\' | '.' | '-' | '_')
      });
    if !embedded {
      add(matched.as_str());
    }
  }
  // Mask complete URL tokens before looking for labels. An identifier embedded
  // in another site's query/path must not silently become an arXiv destination.
  for matched in url_matches.into_iter().rev() {
    label_text.replace_range(matched.range(), " ");
  }
  for captures in labels.captures_iter(&label_text) {
    add(&captures[1]);
  }
  candidates
}

fn crossref_candidates(bytes: &[u8], identifier: bool) -> Result<Vec<ReferenceCandidate>> {
  let envelope: CrossrefEnvelope = serde_json::from_slice(bytes)
    .map_err(|_| "Crossref returned invalid reference data.".to_string())?;
  let works = if identifier {
    vec![serde_json::from_value::<CrossrefWork>(envelope.message)
      .map_err(|_| "Crossref returned invalid reference data.".to_string())?]
  } else {
    serde_json::from_value::<CrossrefList>(envelope.message)
      .map_err(|_| "Crossref returned invalid reference data.".to_string())?
      .items
  };
  Ok(
    works
      .into_iter()
      .take(5)
      .map(|work| {
        let publication_year = [
          &work.published,
          &work.published_print,
          &work.published_online,
          &work.issued,
        ]
        .into_iter()
        .flatten()
        .filter_map(|date| date.date_parts.first()?.first().copied().flatten())
        .find(|year| (1000..=9999).contains(year))
        .map(|year| year.to_string());
        let authors = work
          .author
          .into_iter()
          .flatten()
          .filter_map(|author| {
            let name = author
              .name
              .map(|name| compact_text(&name))
              .filter(|name| !name.is_empty())
              .unwrap_or_else(|| {
                compact_text(&format!(
                  "{} {}",
                  author.given.unwrap_or_default(),
                  author.family.unwrap_or_default()
                ))
              });
            (!name.is_empty()).then_some(name)
          })
          .collect();
        ReferenceCandidate {
          title: work
            .title
            .into_iter()
            .map(|title| compact_text(&title))
            .find(|title| !title.is_empty())
            .unwrap_or_else(|| work.doi.clone()),
          authors,
          publication_year,
          venue: work
            .container_title
            .into_iter()
            .flatten()
            .map(|venue| compact_text(&venue))
            .find(|venue| !venue.is_empty()),
          match_kind: if identifier {
            "identifier"
          } else {
            "suggestion"
          }
          .into(),
          arxiv_id: None,
          url: doi_url(&work.doi),
          doi: Some(work.doi),
        }
      })
      .collect(),
  )
}

pub async fn resolve(state: &AppState, citation: String) -> Result<Vec<ReferenceCandidate>> {
  validation::require_text(&citation, "citation", 8192)?;
  let explicit = explicit_candidates(&citation);
  if !explicit.is_empty() {
    return Ok(explicit);
  }
  let cache_key = compact_text(&citation);
  if let Some(cached) = state.reference_cache.get(&cache_key) {
    return Ok(cached);
  }
  static DOI_PATTERN: OnceLock<Regex> = OnceLock::new();
  let pattern = DOI_PATTERN
    .get_or_init(|| Regex::new(r#"(?i)\b10\.[0-9]{4,9}/[^\s<>"]+"#).expect("constant DOI pattern"));
  let doi = pattern
    .find(&citation)
    .map(|found| found.as_str().trim_end_matches(['.', ',', ';']).to_owned());
  let response = if let Some(doi) = &doi {
    let mut url = Url::parse("https://api.crossref.org/works/").expect("constant Crossref URL");
    url.set_path(&format!("/works/{doi}"));
    state
      .http()?
      .get(url)
      .timeout(Duration::from_secs(30))
      .send()
      .await
  } else {
    state
      .http()?
      .get("https://api.crossref.org/works")
      .query(&[("query.bibliographic", citation.as_str()), ("rows", "5")])
      .timeout(Duration::from_secs(30))
      .send()
      .await
  }
  .map_err(|error| network_error("Reference lookup", error))?;
  if response.status() == reqwest::StatusCode::NOT_FOUND {
    if let Some(doi) = doi {
      return Ok(vec![ReferenceCandidate {
        title: citation.trim().to_owned(),
        authors: Vec::new(),
        publication_year: None,
        venue: None,
        match_kind: "identifier".into(),
        arxiv_id: None,
        url: doi_url(&doi),
        doi: Some(doi),
      }]);
    }
  }
  http::require_success(&response, "Reference lookup")?;
  let bytes = http::bounded_body(response, 2 * 1024 * 1024, "Reference lookup").await?;
  let candidates = crossref_candidates(&bytes, doi.is_some())?;
  state.reference_cache.insert(cache_key, candidates.clone());
  Ok(candidates)
}

#[cfg(test)]
mod tests;
