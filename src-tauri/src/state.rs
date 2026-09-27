use crate::{error::Result, models::OperationProgress, storage::Database};
use std::{
  path::PathBuf,
  time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

pub struct AppState {
  pub database: Database,
  pub pdf_directory: PathBuf,
  pub http: reqwest::Client,
  pub ai_http: reqwest::Client,
  pub import_lock: Mutex<()>,
  pub settings_lock: Mutex<()>,
  pub arxiv_request_clock: Mutex<Instant>,
}

impl AppState {
  pub fn initialize(data_directory: PathBuf) -> Result<Self> {
    let pdf_directory = data_directory.join("papers");
    std::fs::create_dir_all(&pdf_directory)
      .map_err(|_| "Could not create the local paper library.".to_string())?;
    let http = reqwest::Client::builder()
      .user_agent("Papertrail/0.1 (local desktop paper reader)")
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
      .map_err(|_| "Could not initialize networking.".to_string())?;
    // Never forward provider Authorization headers to a redirect destination.
    let ai_http = reqwest::Client::builder()
      .user_agent("Papertrail/0.1")
      .connect_timeout(Duration::from_secs(20))
      .timeout(Duration::from_secs(120))
      .redirect(reqwest::redirect::Policy::none())
      .build()
      .map_err(|_| "Could not initialize AI networking.".to_string())?;
    Ok(Self {
      database: Database::initialize(&data_directory.join("library.sqlite"))?,
      pdf_directory,
      http,
      ai_http,
      import_lock: Mutex::new(()),
      settings_lock: Mutex::new(()),
      arxiv_request_clock: Mutex::new(Instant::now() - Duration::from_secs(3)),
    })
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
