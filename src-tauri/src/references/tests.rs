use super::*;

#[test]
fn explicit_arxiv_citations_are_deduplicated_and_versioned() {
  let candidates =
    explicit_candidates("A paper. arXiv:1706.03762v2. https://arxiv.org/abs/1706.03762v2");
  assert_eq!(candidates.len(), 1);
  assert_eq!(candidates[0].arxiv_id.as_deref(), Some("1706.03762v2"));
  assert_eq!(candidates[0].match_kind, "identifier");
  assert!(candidates[0].authors.is_empty());
  assert_eq!(
    explicit_candidates("https://arxiv.org/abs/hep-th/9901001").len(),
    1
  );
  assert!(explicit_candidates("Some unrelated title from 2024.").is_empty());
}

#[test]
fn embedded_arxiv_urls_accept_supported_routes_and_keep_exact_revisions() {
  for (citation, expected) in [
    ("See https://arxiv.org/html/1706.03762v7/,", "1706.03762v7"),
    (
      "Paper (https://export.arxiv.org/pdf/hep-th/9901001v3.pdf).",
      "hep-th/9901001v3",
    ),
    ("Source: arxiv.org/abs/math.GT/0309136", "math.GT/0309136"),
    ("The article, arXiv:1706.03762v2].", "1706.03762v2"),
    (
      "See HTTPS://WWW.ARXIV.ORG/abs/1706.03762v3?download=1#page=4",
      "1706.03762v3",
    ),
    (
      "Link https://arxiv.org/abs/hep-th%2F9901001v3",
      "hep-th/9901001v3",
    ),
  ] {
    let candidates = explicit_candidates(citation);
    assert_eq!(candidates.len(), 1, "{citation}");
    assert_eq!(
      candidates[0].arxiv_id.as_deref(),
      Some(expected),
      "{citation}"
    );
  }
}

#[test]
fn arxiv_substrings_on_unrelated_hosts_and_invalid_partial_ids_are_not_candidates() {
  for citation in [
    "https://evil.test/arxiv.org/abs/1706.03762v7",
    "https://evil.test/?target=https://arxiv.org/abs/1706.03762",
    "https://evil.test/?target=arxiv:1706.03762",
    "https://arxiv.org.evil.test/abs/1706.03762",
    "https://arxiv.org@evil.test/abs/1706.03762",
    "https://user@arxiv.org/abs/1706.03762",
    "evil-arxiv.org/abs/1706.03762",
    "foo@arxiv.org/abs/1706.03762",
    "ftp://arxiv.org/abs/1706.03762",
    "arXiv:1706.03762v0",
    "arXiv:1706.037629",
    "arXiv:1706.03762v2oops",
  ] {
    assert!(explicit_candidates(citation).is_empty(), "{citation}");
  }
  assert_eq!(
    explicit_candidates("https://evil.test/arxiv.org/abs/1706.03762 but arXiv:2401.12345v2")[0]
      .arxiv_id
      .as_deref(),
    Some("2401.12345v2")
  );
}

#[test]
fn crossref_identifier_metadata_keeps_authors_year_venue_and_exact_match_kind() {
  let bytes = br#"{"message":{
    "DOI":"10.1000/example", "title":["  A   useful paper  "],
    "author":[{"given":" Ada ","family":"Lovelace"},{"name":" The   Research Group "},{"family":"Single"},{}],
    "container-title":["", " Journal of   Examples "],
    "published":{"date-parts":[[2024,5,7]]},
    "published-print":{"date-parts":[[2025]]}
  }}"#;
  let candidates = crossref_candidates(bytes, true).unwrap();
  assert_eq!(candidates.len(), 1);
  let candidate = &candidates[0];
  assert_eq!(candidate.title, "A useful paper");
  assert_eq!(
    candidate.authors,
    ["Ada Lovelace", "The Research Group", "Single"]
  );
  assert_eq!(candidate.publication_year.as_deref(), Some("2024"));
  assert_eq!(candidate.venue.as_deref(), Some("Journal of Examples"));
  assert_eq!(candidate.match_kind, "identifier");
  assert_eq!(candidate.url, "https://doi.org/10.1000/example");
  assert_eq!(candidate.doi.as_deref(), Some("10.1000/example"));
}

#[test]
fn crossref_search_suggestions_have_date_fallbacks_and_tolerate_missing_metadata() {
  let bytes = br#"{"message":{"items":[
    {"DOI":"10.1000/first","title":[],"published":{"date-parts":[[null]]},"published-print":{"date-parts":[[0]]},"published-online":{"date-parts":[[2020,3]]}},
    {"DOI":"10.1000/second","author":null,"container-title":null,"issued":{"date-parts":[[2018]]}},
    {"DOI":"10.1000/third","published":{"date-parts":[[]]},"container-title":[""]}
  ]}}"#;
  let candidates = crossref_candidates(bytes, false).unwrap();
  assert_eq!(candidates.len(), 3);
  assert_eq!(candidates[0].publication_year.as_deref(), Some("2020"));
  assert_eq!(candidates[1].publication_year.as_deref(), Some("2018"));
  assert!(candidates[2].publication_year.is_none());
  assert!(candidates
    .iter()
    .all(|candidate| candidate.match_kind == "suggestion"
      && candidate.authors.is_empty()
      && candidate.venue.is_none()));
  assert_eq!(candidates[0].title, "10.1000/first");
  assert!(crossref_candidates(br#"{"message":{"title":["Missing DOI"]}}"#, true).is_err());
  assert!(crossref_candidates(b"not JSON", false).is_err());
}

#[test]
fn resolver_cache_is_bounded_expires_and_never_changes_match_kind() {
  let cache = ResolverCache::default();
  for index in 0..MAX_CACHED_RESOLUTIONS + 1 {
    cache.insert(
      index.to_string(),
      vec![arxiv_candidate(ArxivId::parse("1706.03762v7").unwrap())],
    );
  }
  assert_eq!(cache.entries.lock().unwrap().len(), MAX_CACHED_RESOLUTIONS);
  assert!(cache.get("0").is_none());
  assert_eq!(cache.get("128").unwrap()[0].match_kind, "identifier");
  cache
    .entries
    .lock()
    .unwrap()
    .get_mut("128")
    .unwrap()
    .fetched_at = Instant::now() - RESOLUTION_TTL;
  assert!(cache.get("128").is_none());
}
