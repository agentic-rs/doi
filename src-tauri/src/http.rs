use crate::error::{network_error, Result};
use reqwest::Response;

pub async fn bounded_body(
  mut response: Response,
  maximum: usize,
  operation: &str,
) -> Result<Vec<u8>> {
  if response
    .content_length()
    .is_some_and(|length| length > maximum as u64)
  {
    return Err(format!("{operation} returned too much data."));
  }
  let mut bytes = Vec::new();
  while let Some(chunk) = response
    .chunk()
    .await
    .map_err(|error| network_error(operation, error))?
  {
    if bytes.len() + chunk.len() > maximum {
      return Err(format!("{operation} returned too much data."));
    }
    bytes.extend_from_slice(&chunk);
  }
  Ok(bytes)
}

pub fn require_success(response: &Response, operation: &str) -> Result<()> {
  let status = response.status();
  if status.is_success() {
    return Ok(());
  }
  let advice = match status.as_u16() {
    401 | 403 => "Check access permissions or the provider API key.",
    404 => "The requested resource was not found.",
    429 => "The service rate limit was reached. Try again later.",
    500..=599 => "The remote service is unavailable. Try again later.",
    _ => "Check the request and try again.",
  };
  Err(format!(
    "{operation} failed (HTTP {}). {advice}",
    status.as_u16()
  ))
}
