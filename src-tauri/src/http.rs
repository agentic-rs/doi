use crate::error::{network_error, Result};
use reqwest::{Certificate, Response};
use std::{ffi::OsString, io::Read, path::Path};

const MAX_CERTIFICATE_BUNDLE_BYTES: u64 = 4 * 1024 * 1024;

/// Reqwest honors proxy environment variables, but its platform TLS verifier
/// does not read the matching CA bundle. Merge explicit roots with OS trust.
pub fn configured_tls_roots() -> Result<Vec<Certificate>> {
  let path = certificate_bundle_path(
    std::env::var_os("SSL_CERT_FILE"),
    std::env::var_os("CURL_CA_BUNDLE"),
  );
  match path {
    Some(path) => read_certificate_bundle(Path::new(&path)),
    None => Ok(Vec::new()),
  }
}

fn certificate_bundle_path(ssl: Option<OsString>, curl: Option<OsString>) -> Option<OsString> {
  ssl
    .filter(|path| !path.is_empty())
    .or_else(|| curl.filter(|path| !path.is_empty()))
}

fn read_certificate_bundle(path: &Path) -> Result<Vec<Certificate>> {
  let metadata = std::fs::metadata(path).map_err(|_| {
    "Could not read the configured TLS certificate bundle (SSL_CERT_FILE or CURL_CA_BUNDLE)."
      .to_string()
  })?;
  if !metadata.is_file() || metadata.len() > MAX_CERTIFICATE_BUNDLE_BYTES {
    return Err(
      "The configured TLS certificate bundle must be a PEM file smaller than 4 MB.".into(),
    );
  }
  let mut bytes = Vec::new();
  std::fs::File::open(path)
    .and_then(|file| {
      file
        .take(MAX_CERTIFICATE_BUNDLE_BYTES + 1)
        .read_to_end(&mut bytes)
    })
    .map_err(|_| "Could not read the configured TLS certificate bundle.".to_string())?;
  if bytes.len() as u64 > MAX_CERTIFICATE_BUNDLE_BYTES {
    return Err("The configured TLS certificate bundle is too large.".into());
  }
  let certificates = Certificate::from_pem_bundle(&bytes).map_err(|_| {
    "The configured TLS certificate bundle contains invalid PEM certificates.".to_string()
  })?;
  if certificates.is_empty() {
    return Err("The configured TLS certificate bundle contains no PEM certificates.".into());
  }
  Ok(certificates)
}

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

#[cfg(test)]
mod tests;
