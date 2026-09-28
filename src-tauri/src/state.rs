use crate::{
  ai::RequestRegistry, error::Result, http, models::OperationProgress, storage::Database,
};
use std::{
  path::PathBuf,
  time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

pub struct AppState {
  pub database: Database,
  pub pdf_directory: PathBuf,
  http: Result<reqwest::Client>,
  ai_http: Result<reqwest::Client>,
  pub import_lock: Mutex<()>,
  pub settings_lock: Mutex<()>,
  pub arxiv_request_clock: Mutex<Instant>,
  pub ai_requests: RequestRegistry,
}

impl AppState {
  pub fn initialize(data_directory: PathBuf) -> Result<Self> {
    Self::initialize_with_tls_roots(data_directory, http::configured_tls_roots())
  }

  fn initialize_with_tls_roots(
    data_directory: PathBuf,
    tls_roots: Result<Vec<reqwest::Certificate>>,
  ) -> Result<Self> {
    let pdf_directory = data_directory.join("papers");
    std::fs::create_dir_all(&pdf_directory)
      .map_err(|_| "Could not create the local paper library.".to_string())?;
    // An explicit but unusable trust configuration must never be ignored.
    // Keep local reading available and report it when networking is requested.
    let tls_roots = tls_roots.map_err(|error| {
      format!("Networking is unavailable. {error} Fix the certificate configuration and restart Papertrail.")
    });
    let http = tls_roots.clone().and_then(|roots| {
      reqwest::Client::builder()
        .tls_certs_merge(roots)
        .user_agent("Papertrail/0.1 (local paper reader)")
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(300))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
          if attempt.previous().len() >= 5 || attempt.url().scheme() != "https" {
            attempt.stop()
          } else {
            attempt.follow()
          }
        }))
        .build()
        .map_err(|_| "Could not initialize networking. Check the TLS certificate configuration and restart Papertrail.".to_string())
    });
    // Never forward provider Authorization headers to a redirect destination.
    let ai_http = tls_roots.and_then(|roots| {
      reqwest::Client::builder()
        .tls_certs_merge(roots)
        .user_agent("Papertrail/0.1")
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(300))
        .read_timeout(Duration::from_secs(60))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Could not initialize AI networking. Check the TLS certificate configuration and restart Papertrail.".to_string())
    });
    Ok(Self {
      database: Database::initialize(&data_directory.join("library.sqlite"))?,
      pdf_directory,
      http,
      ai_http,
      import_lock: Mutex::new(()),
      settings_lock: Mutex::new(()),
      arxiv_request_clock: Mutex::new(Instant::now() - Duration::from_secs(3)),
      ai_requests: RequestRegistry::default(),
    })
  }

  pub fn http(&self) -> Result<&reqwest::Client> {
    self.http.as_ref().map_err(Clone::clone)
  }

  pub fn ai_http(&self) -> Result<&reqwest::Client> {
    self.ai_http.as_ref().map_err(Clone::clone)
  }

  pub fn progress(
    &self,
    app: &AppHandle,
    request_id: &str,
    phase: &'static str,
    message: &str,
    received_bytes: u64,
    total_bytes: Option<u64>,
  ) {
    let _ = app.emit(
      "operation-progress",
      OperationProgress {
        request_id: request_id.to_owned(),
        phase,
        message: message.to_owned(),
        received_bytes,
        total_bytes,
      },
    );
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use sha2::{Digest, Sha256};

  #[test]
  fn invalid_tls_configuration_preserves_the_offline_library() {
    tauri::async_runtime::block_on(async {
      let directory = tempfile::tempdir().unwrap();
      let invalid_der = reqwest::Certificate::from_pem(
        b"-----BEGIN CERTIFICATE-----\nAQID\n-----END CERTIFICATE-----",
      )
      .unwrap();
      for roots in [
        Err("The configured TLS certificate bundle contains no PEM certificates.".into()),
        Ok(vec![invalid_der]),
      ] {
        let state = AppState::initialize_with_tls_roots(directory.path().to_owned(), roots)
          .expect("bad networking must not prevent the local library opening");
        for error in [state.http().unwrap_err(), state.ai_http().unwrap_err()] {
          assert!(error.contains("certificate configuration"));
          assert!(error.contains("restart Papertrail"));
          assert!(!error.contains("AQID"));
        }
        let mut paper = crate::arxiv::parse_metadata(
          include_bytes!("../tests/fixtures/arxiv-1706.03762.xml"),
          &crate::arxiv::ArxivId::parse("1706.03762").unwrap(),
        )
        .unwrap();
        let bytes = b"%PDF-1.7\nOffline reading fixture";
        paper.pdf_hash = format!("{:x}", Sha256::digest(bytes));
        std::fs::write(crate::arxiv::pdf_path(&state, &paper.paper_id), bytes).unwrap();
        state.database.save_paper(paper.clone()).await.unwrap();
        assert_eq!(state.database.list_papers().await.unwrap().len(), 1);
        assert_eq!(
          crate::arxiv::read_pdf(&state, paper.paper_id)
            .await
            .unwrap(),
          bytes
        );
        let candidates = crate::references::resolve(&state, "arXiv:1706.03762".into())
          .await
          .unwrap();
        assert_eq!(candidates.len(), 1);
        assert_eq!(
          crate::ai::list_models(
            &state,
            state.database.get_settings().await.unwrap(),
            Some("test-only-token".into())
          )
          .await
          .unwrap_err(),
          state.ai_http().unwrap_err(),
        );
      }
    });
  }
}
