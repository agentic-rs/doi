use crate::{error::Result, models::*};
use url::Url;

pub const MAX_TEXT_BYTES: usize = 128 * 1024;

pub fn validate_id(id: &str) -> Result<()> {
  if id.is_empty() || id.len() > 160 || id.chars().any(char::is_control) {
    return Err("Invalid record identifier.".into());
  }
  Ok(())
}

pub fn validate_location(location: &ReadingLocation) -> Result<()> {
  validate_id(&location.paper_id)?;
  if let Some(block_id) = &location.reading_block_id {
    validate_id(block_id)?;
  }
  if location.page_number == 0
    || location.page_number > 100_000
    || location
      .page_position
      .iter()
      .any(|value| !value.is_finite() || !(0.0..=1.0).contains(value))
    || !location.zoom.is_finite()
    || !(0.1..=10.0).contains(&location.zoom)
    || ![0, 90, 180, 270].contains(&location.rotation)
  {
    return Err("Invalid reading position, zoom, or rotation.".into());
  }
  Ok(())
}

pub fn validate_annotation(annotation: &Annotation) -> Result<()> {
  validate_id(&annotation.annotation_id)?;
  validate_id(&annotation.target.paper_id)?;
  if annotation.schema_version != 1 {
    return Err("Unsupported annotation schema version.".into());
  }
  if annotation.target.pdf_hash.len() != 64
    || !annotation
      .target
      .pdf_hash
      .bytes()
      .all(|byte| byte.is_ascii_hexdigit())
  {
    return Err("An annotation must identify the original PDF hash.".into());
  }
  if annotation.target.page_anchors.is_empty() || annotation.target.page_anchors.len() > 100 {
    return Err("An annotation must contain a bounded selection of page anchors.".into());
  }
  for anchor in &annotation.target.page_anchors {
    if anchor.page_number == 0
      || anchor.page_number > 100_000
      || anchor.quad_points.is_empty()
      || anchor.quad_points.len() > 10_000
      || anchor.text_quote.normalization_version != 1
    {
      return Err("Invalid annotation page anchor.".into());
    }
    require_text(
      &anchor.text_quote.exact_text,
      "selected quote",
      MAX_TEXT_BYTES,
    )?;
    bound_text(&anchor.text_quote.prefix, "quote prefix", 8192)?;
    bound_text(&anchor.text_quote.suffix, "quote suffix", 8192)?;
    for quad in &anchor.quad_points {
      if quad
        .iter()
        .any(|coordinate| !coordinate.is_finite() || coordinate.abs() > 1_000_000.0)
      {
        return Err("Annotation coordinates must be finite PDF user-space values.".into());
      }
      let area = (0..4)
        .fold(0.0, |sum, index| {
          let next = (index + 1) % 4;
          sum + quad[index * 2] * quad[next * 2 + 1] - quad[next * 2] * quad[index * 2 + 1]
        })
        .abs();
      if area < 0.000_001 {
        return Err("Annotation quadrilaterals must enclose a non-empty area.".into());
      }
    }
  }
  for timestamp in [&annotation.created_at, &annotation.updated_at] {
    if !timestamp.is_empty() && chrono::DateTime::parse_from_rfc3339(timestamp).is_err() {
      return Err("Annotation timestamps must use RFC3339.".into());
    }
  }
  match &annotation.body {
    AnnotationBody::Note { content } => require_text(content, "note", MAX_TEXT_BYTES)?,
    AnnotationBody::AiAnswer {
      question,
      answer,
      provider_id,
      model_id,
      context_text,
    } => {
      require_text(question, "question", 8192)?;
      require_text(answer, "AI answer", MAX_TEXT_BYTES)?;
      require_text(provider_id, "provider", 2048)?;
      require_text(model_id, "model", 512)?;
      bound_text(context_text, "AI context", MAX_TEXT_BYTES)?;
    }
  }
  if serde_json::to_vec(annotation)
    .map_err(|_| "Invalid annotation.".to_string())?
    .len()
    > 2 * 1024 * 1024
  {
    return Err("Annotation is too large.".into());
  }
  Ok(())
}

pub fn bound_text(text: &str, field: &str, max_bytes: usize) -> Result<()> {
  if text.len() > max_bytes || text.contains('\0') {
    return Err(format!(
      "The {field} is too long or contains invalid characters."
    ));
  }
  Ok(())
}

pub fn require_text(text: &str, field: &str, max_bytes: usize) -> Result<()> {
  bound_text(text, field, max_bytes)?;
  if text.trim().is_empty() {
    return Err(format!("The {field} cannot be empty."));
  }
  Ok(())
}

pub fn external_url(input: &str) -> Result<Url> {
  let url = Url::parse(input).map_err(|_| "Invalid external URL.".to_string())?;
  if !matches!(url.scheme(), "https" | "http")
    || url.host_str().is_none()
    || !url.username().is_empty()
    || url.password().is_some()
    || input.len() > 8192
  {
    return Err("Only HTTP and HTTPS links without embedded credentials can be opened.".into());
  }
  Ok(url)
}

pub fn provider_url(input: &str) -> Result<Url> {
  let mut url = external_url(input)?;
  let is_local = matches!(
    url.host_str(),
    Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
  );
  if url.scheme() != "https" && !is_local {
    return Err("AI providers must use HTTPS; local providers can use HTTP.".into());
  }
  if url.query().is_some() || url.fragment().is_some() {
    return Err("Provider base URLs cannot include a query or fragment.".into());
  }
  let path = url.path().trim_end_matches('/').to_owned();
  if path.ends_with("/chat/completions") {
    return Err("Enter the provider base URL, such as https://provider.example/v1.".into());
  }
  url.set_path(&path);
  Ok(url)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn provider_urls_disallow_remote_plaintext_and_credentials() {
    assert!(provider_url("https://api.example/v1").is_ok());
    assert!(provider_url("http://127.0.0.1:11434/v1").is_ok());
    assert!(provider_url("http://api.example/v1").is_err());
    assert!(provider_url("https://key@api.example/v1").is_err());
    assert!(provider_url("https://api.example/v1?key=secret").is_err());
    assert!(external_url("file:///etc/passwd").is_err());
    assert!(external_url("javascript:alert(1)").is_err());
  }

  #[test]
  fn locations_require_normalized_finite_positions() {
    let mut location = ReadingLocation {
      paper_id: "2401.12345v1".into(),
      page_number: 2,
      page_position: [0.3, 0.5],
      zoom: 1.2,
      zoom_mode: PdfZoomMode::Custom,
      rotation: 90,
      reader_mode: ReaderMode::Pdf,
      reading_block_id: None,
    };
    assert!(validate_location(&location).is_ok());
    location.page_position[1] = f64::NAN;
    assert!(validate_location(&location).is_err());
    location.page_position[1] = 1.1;
    assert!(validate_location(&location).is_err());
    location.page_position[1] = 0.5;
    location.rotation = 1;
    assert!(validate_location(&location).is_err());
  }
}
