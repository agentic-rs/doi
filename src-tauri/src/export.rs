use crate::{error::Result, models::Annotation, state::AppState, validation};
use serde::Deserialize;
use std::{collections::HashSet, path::Path};
use tauri::AppHandle;
#[cfg(target_os = "ios")]
use tauri::Manager;
#[cfg(not(target_os = "ios"))]
use tauri_plugin_dialog::DialogExt;
use tokio::io::AsyncWriteExt;

#[derive(Deserialize)]
struct AnnotationSidecar {
  format: String,
  schema_version: u32,
  paper_id: String,
  pdf_hash: String,
  exported_at: String,
  annotations: Vec<Annotation>,
}

fn validate_sidecar(content: &str) -> Result<(String, String)> {
  if content.len() > 8 * 1024 * 1024 {
    return Err("Annotation files must be smaller than 8 MB.".into());
  }
  let sidecar: AnnotationSidecar = serde_json::from_str(content)
    .map_err(|_| "This is not a valid annotation sidecar.".to_string())?;
  if sidecar.format != "papertrail_annotations"
    || sidecar.schema_version != 1
    || sidecar.annotations.len() > 10_000
    || chrono::DateTime::parse_from_rfc3339(&sidecar.exported_at).is_err()
  {
    return Err("Unsupported annotation sidecar format.".into());
  }
  validation::validate_id(&sidecar.paper_id)?;
  let mut ids = HashSet::new();
  for annotation in &sidecar.annotations {
    validation::validate_annotation(annotation)?;
    if annotation.target.paper_id != sidecar.paper_id
      || annotation.target.pdf_hash != sidecar.pdf_hash
      || !ids.insert(&annotation.annotation_id)
    {
      return Err("Annotations must belong to this PDF revision and have unique IDs.".into());
    }
  }
  Ok((sidecar.paper_id, sidecar.pdf_hash))
}

pub async fn save(
  app: &AppHandle,
  state: &AppState,
  file_name: String,
  content: String,
) -> Result<Option<String>> {
  if file_name.is_empty()
    || file_name.len() > 200
    || !file_name.ends_with(".json")
    || file_name
      .chars()
      .any(|character| character.is_control() || matches!(character, '/' | '\\' | ':'))
  {
    return Err("The suggested annotation filename must be a JSON filename.".into());
  }
  let (paper_id, pdf_hash, content) = tauri::async_runtime::spawn_blocking(move || {
    validate_sidecar(&content).map(|(paper_id, pdf_hash)| (paper_id, pdf_hash, content))
  })
  .await
  .map_err(|_| "Annotation export validation was interrupted.".to_string())??;
  let paper = state
    .database
    .get_paper(paper_id)
    .await?
    .ok_or_else(|| "That paper is not in the local library.".to_string())?;
  if paper.pdf_hash != pdf_hash {
    return Err("These annotations belong to a different PDF revision.".into());
  }
  save_validated(app, file_name, content).await
}

#[cfg(not(target_os = "ios"))]
async fn save_validated(
  app: &AppHandle,
  file_name: String,
  content: String,
) -> Result<Option<String>> {
  let (sender, receiver) = tokio::sync::oneshot::channel();
  app
    .dialog()
    .file()
    .set_title("Export paper annotations")
    .set_file_name(file_name)
    .add_filter("Papertrail annotations", &["json"])
    .save_file(move |path| {
      let _ = sender.send(path);
    });
  let Some(path) = receiver
    .await
    .map_err(|_| "The save dialog was interrupted.".to_string())?
  else {
    return Ok(None);
  };
  let path = path
    .into_path()
    .map_err(|_| "Choose a local file for the annotation export.".to_string())?;
  write_atomic(&path, content.as_bytes()).await?;
  Ok(Some(path.to_string_lossy().into_owned()))
}

#[cfg(target_os = "ios")]
async fn save_validated(
  app: &AppHandle,
  file_name: String,
  content: String,
) -> Result<Option<String>> {
  // A desktop save dialog returns a writable destination. iOS instead copies an
  // existing file into Files, so the source must already contain the full JSON.
  let directory = app
    .path()
    .app_cache_dir()
    .map_err(|_| "Could not find the annotation export cache.".to_string())?
    .join(format!("annotation-export-{}", uuid::Uuid::new_v4()));
  tokio::fs::create_dir_all(&directory)
    .await
    .map_err(|_| "Could not create the annotation export cache.".to_string())?;
  let path = directory.join(file_name);
  let result = async {
    write_atomic(&path, content.as_bytes()).await?;
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
      tauri_plugin_papertrail_export::export_file(&app, path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|_| "Annotation export was interrupted.".to_string())?
  }
  .await;
  let _ = tokio::fs::remove_dir_all(&directory).await;
  result
}

async fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
  let parent = path
    .parent()
    .ok_or_else(|| "Choose a valid destination for the annotation export.".to_string())?;
  let temporary = parent.join(format!(".papertrail-{}.tmp", uuid::Uuid::new_v4()));
  let result = async {
    let mut file = tokio::fs::OpenOptions::new()
      .write(true)
      .create_new(true)
      .open(&temporary)
      .await
      .map_err(|_| "Could not create the annotation export file.".to_string())?;
    file
      .write_all(bytes)
      .await
      .map_err(|_| "Could not write the annotation export file.".to_string())?;
    file
      .flush()
      .await
      .map_err(|_| "Could not flush the annotation export file.".to_string())?;
    file
      .sync_all()
      .await
      .map_err(|_| "Could not save the annotation export file.".to_string())?;
    drop(file);
    tokio::fs::rename(&temporary, path)
      .await
      .map_err(|_| "Could not finalize the annotation export file.".to_string())?;
    Ok(())
  }
  .await;
  if result.is_err() {
    let _ = tokio::fs::remove_file(&temporary).await;
  }
  result
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn native_export_validation_and_atomic_write() {
    let content = serde_json::json!({ "format": "papertrail_annotations", "schema_version": 1,
      "paper_id": "2401.12345v1", "pdf_hash": "a".repeat(64),
      "exported_at": "2026-09-27T00:00:00Z", "annotations": [] })
    .to_string();
    assert_eq!(validate_sidecar(&content).unwrap().0, "2401.12345v1");
    assert!(
      validate_sidecar(&content.replace("papertrail_annotations", "arbitrary_data")).is_err()
    );
    tauri::async_runtime::block_on(async {
      let directory = tempfile::tempdir().unwrap();
      let path = directory.path().join("annotations.json");
      write_atomic(&path, content.as_bytes()).await.unwrap();
      assert_eq!(tokio::fs::read_to_string(&path).await.unwrap(), content);
      assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    });
  }
}
