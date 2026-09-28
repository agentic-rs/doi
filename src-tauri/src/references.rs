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
use std::{collections::HashSet, sync::OnceLock, time::Duration};
use url::Url;

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
}

fn doi_url(doi: &str) -> String {
  let mut url = Url::parse("https://doi.org/").expect("constant DOI URL");
  url.set_path(doi);
  url.to_string()
}

pub fn explicit_candidates(citation: &str) -> Vec<ReferenceCandidate> {
  static ARXIV_PATTERN: OnceLock<Regex> = OnceLock::new();
  let pattern = ARXIV_PATTERN.get_or_init(|| Regex::new(
    r"(?i)(?:arxiv[:\s]*|arxiv\.org/(?:abs|pdf)/)([0-9]{4}\.[0-9]{4,5}(?:v[1-9][0-9]*)?|[a-z][a-z-]*(?:\.[a-z]{2})?/[0-9]{7}(?:v[1-9][0-9]*)?)"
  ).expect("constant arXiv citation pattern"));
  let mut seen = HashSet::new();
  let mut candidates = Vec::new();
  if let Ok(id) = ArxivId::parse(citation) {
    let canonical = id.canonical();
    seen.insert(canonical.clone());
    candidates.push(ReferenceCandidate {
      title: format!("arXiv {canonical}"),
      arxiv_id: Some(canonical.clone()),
      doi: None,
      url: format!("https://arxiv.org/abs/{canonical}"),
    });
  }
  for captures in pattern.captures_iter(citation).take(10) {
    if let Ok(id) = ArxivId::parse(&captures[1]) {
      let canonical = id.canonical();
      if seen.insert(canonical.clone()) {
        candidates.push(ReferenceCandidate {
          title: format!("arXiv {canonical}"),
          arxiv_id: Some(canonical.clone()),
          doi: None,
          url: format!("https://arxiv.org/abs/{canonical}"),
        });
      }
    }
  }
  candidates
}

pub async fn resolve(state: &AppState, citation: String) -> Result<Vec<ReferenceCandidate>> {
  validation::require_text(&citation, "citation", 8192)?;
  let explicit = explicit_candidates(&citation);
  if !explicit.is_empty() {
    return Ok(explicit);
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
        arxiv_id: None,
        url: doi_url(&doi),
        doi: Some(doi),
      }]);
    }
  }
  http::require_success(&response, "Reference lookup")?;
  let bytes = http::bounded_body(response, 2 * 1024 * 1024, "Reference lookup").await?;
  let envelope: CrossrefEnvelope = serde_json::from_slice(&bytes)
    .map_err(|_| "Crossref returned invalid reference data.".to_string())?;
  let works = if doi.is_some() {
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
      .map(|work| ReferenceCandidate {
        title: work
          .title
          .into_iter()
          .next()
          .unwrap_or_else(|| work.doi.clone()),
        arxiv_id: None,
        url: doi_url(&work.doi),
        doi: Some(work.doi),
      })
      .collect(),
  )
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn explicit_arxiv_citations_are_deduplicated_and_versioned() {
    let candidates =
      explicit_candidates("A paper. arXiv:1706.03762v2. https://arxiv.org/abs/1706.03762v2");
    assert_eq!(candidates.len(), 1);
    assert_eq!(candidates[0].arxiv_id.as_deref(), Some("1706.03762v2"));
    assert_eq!(
      explicit_candidates("https://arxiv.org/abs/hep-th/9901001").len(),
      1
    );
    assert!(explicit_candidates("Some unrelated title from 2024.").is_empty());
  }
}
