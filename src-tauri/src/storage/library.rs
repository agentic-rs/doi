use super::*;
use rusqlite::TransactionBehavior;
use sha2::{Digest, Sha256};
use std::{collections::HashSet, fs, io::ErrorKind};

impl Database {
  pub async fn mark_paper_opened(&self, paper_id: String) -> Result<Paper> {
    validation::validate_id(&paper_id)?;
    self
      .run(move |connection| {
        let transaction = connection
          .transaction_with_behavior(TransactionBehavior::Immediate)
          .map_err(storage_error)?;
        let changed = transaction
          .execute(
            "UPDATE papers SET last_opened_at=?1 WHERE paper_id=?2",
            params![chrono::Utc::now().to_rfc3339(), paper_id],
          )
          .map_err(storage_error)?;
        if changed == 0 {
          return Err("That paper is not in the local library.".into());
        }
        let paper = transaction
          .query_row(
            "SELECT data, last_location, last_opened_at FROM papers WHERE paper_id=?1",
            [paper_id],
            paper_from_row,
          )
          .map_err(storage_error)?;
        transaction.commit().map_err(storage_error)?;
        Ok(paper)
      })
      .await
  }

  /// Runs once at startup, before imports can write PDF files. A staged PDF is
  /// restored when SQLite rolled back, or discarded when deletion committed.
  pub fn recover_pdf_removals(&self, pdf_directory: &Path) -> Result<()> {
    let mut connection = self.connect()?;
    let transaction = connection
      .transaction_with_behavior(TransactionBehavior::Immediate)
      .map_err(storage_error)?;
    let retained_files = {
      let mut statement = transaction
        .prepare("SELECT paper_id FROM papers")
        .map_err(storage_error)?;
      let paper_ids = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(storage_error)?;
      paper_ids
        .map(|paper_id| paper_id.map(|id| file_key(&id)))
        .collect::<rusqlite::Result<HashSet<_>>>()
        .map_err(storage_error)?
    };
    for entry in fs::read_dir(pdf_directory)
      .map_err(|_| "Could not inspect interrupted paper removals.".to_string())?
    {
      let entry =
        entry.map_err(|_| "Could not inspect an interrupted paper removal.".to_string())?;
      let filename = entry.file_name();
      let Some(key) = filename
        .to_str()
        .and_then(|name| name.strip_suffix(".removing"))
      else {
        continue;
      };
      // Only touch our generated names, never paths supplied by metadata or a
      // directory entry that could navigate outside the app's paper directory.
      if key.len() != 64 || !key.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        continue;
      }
      let staged = entry.path();
      if !entry
        .file_type()
        .map_err(|_| "Could not inspect a staged PDF.".to_string())?
        .is_file()
      {
        return Err(
          "An interrupted PDF removal has an invalid local file. The library was not changed."
            .into(),
        );
      }
      let original = pdf_directory.join(format!("{key}.pdf"));
      if retained_files.contains(key)
        && !original
          .try_exists()
          .map_err(|_| "Could not inspect a cached PDF.".to_string())?
      {
        fs::rename(&staged, &original)
          .map_err(|_| "Could not restore a PDF after an interrupted removal.".to_string())?;
      } else {
        fs::remove_file(&staged)
          .map_err(|_| "Could not finish an interrupted PDF removal.".to_string())?;
      }
    }
    transaction.commit().map_err(storage_error)
  }

  /// The caller holds the import lock, so a queued download cannot recreate the
  /// paper between invalidating its preview and deleting the row and PDF.
  pub(crate) async fn remove_paper_and_pdf(
    &self,
    paper_id: String,
    pdf_directory: PathBuf,
  ) -> Result<Vec<String>> {
    validation::validate_id(&paper_id)?;
    self.run(move |connection| {
      // Beginning the write transaction before collecting request IDs ensures
      // every AI operation either appears here or sees a missing paper later.
      let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(storage_error)?;
      let requests = {
        let mut statement = transaction.prepare(
          "SELECT active_request_id FROM ai_conversations WHERE paper_id=?1 AND active_request_id IS NOT NULL",
        ).map_err(storage_error)?;
        let rows = statement.query_map([&paper_id], |row| row.get::<_, String>(0))
          .map_err(storage_error)?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(storage_error)?
      };
      let key = file_key(&paper_id);
      let original = pdf_directory.join(format!("{key}.pdf"));
      let staged = pdf_directory.join(format!("{key}.removing"));
      let removal = stage_pdf(original, staged)?;
      let result = (|| {
        transaction.execute("DELETE FROM papers WHERE paper_id=?1", [&paper_id])
          .map_err(storage_error)?;
        transaction.commit().map_err(storage_error)
      })();
      match result {
        Ok(()) => {
          if let Some((_, staged)) = removal {
            // Once committed, this file is no longer addressable by the reader.
            // If unlink fails (or the app closes here), startup retries cleanup.
            let _ = fs::remove_file(staged);
          }
          Ok(requests)
        }
        Err(error) => {
          if let Some((original, staged)) = removal {
            fs::rename(staged, original).map_err(|_| {
              "The paper could not be removed. Restart Papertrail to restore its cached PDF.".to_string()
            })?;
          }
          Err(error)
        }
      }
    }).await
  }
}

fn file_key(paper_id: &str) -> String {
  format!("{:x}", Sha256::digest(paper_id.as_bytes()))
}

fn stage_pdf(original: PathBuf, staged: PathBuf) -> Result<Option<(PathBuf, PathBuf)>> {
  match fs::symlink_metadata(&original) {
    Ok(metadata) if metadata.is_file() => {}
    Ok(_) => {
      return Err("The cached PDF is not a regular file. The library was not changed.".into())
    }
    Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
    Err(_) => return Err("Could not inspect the cached PDF. The library was not changed.".into()),
  }
  match fs::symlink_metadata(&staged) {
    Err(error) if error.kind() == ErrorKind::NotFound => {}
    _ => {
      return Err(
        "Restart Papertrail to finish an earlier paper removal before trying again.".into(),
      )
    }
  }
  fs::rename(&original, &staged)
    .map_err(|_| "Could not remove the cached PDF. The library was not changed.".to_string())?;
  Ok(Some((original, staged)))
}

#[cfg(test)]
mod tests {
  use super::*;

  fn location(paper: &Paper) -> ReadingLocation {
    ReadingLocation {
      paper_id: paper.paper_id.clone(),
      page_number: 3,
      page_position: [0.2, 0.6],
      zoom: 1.5,
      zoom_mode: PdfZoomMode::Custom,
      rotation: 90,
      reader_mode: ReaderMode::Pdf,
      reading_block_id: None,
    }
  }

  #[test]
  fn version_three_migration_preserves_metadata_locations_and_durable_recency() {
    tauri::async_runtime::block_on(async {
      let directory = tempfile::tempdir().unwrap();
      let path = directory.path().join("library.sqlite");
      let paper = super::super::tests::fixture_paper();
      let mut old_paper = serde_json::to_value(&paper).unwrap();
      old_paper.as_object_mut().unwrap().remove("last_opened_at");
      let connection = Connection::open(&path).unwrap();
      connection
        .execute_batch(
          "CREATE TABLE papers (paper_id TEXT PRIMARY KEY, arxiv_id TEXT NOT NULL,
        arxiv_version INTEGER NOT NULL, pdf_hash TEXT NOT NULL, data TEXT NOT NULL,
        last_location TEXT, downloaded_at TEXT NOT NULL); PRAGMA user_version=3;",
        )
        .unwrap();
      let saved_location = location(&paper);
      connection
        .execute(
          "INSERT INTO papers VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
          params![
            paper.paper_id,
            paper.arxiv_id,
            paper.arxiv_version,
            paper.pdf_hash,
            old_paper.to_string(),
            serde_json::to_string(&saved_location).unwrap(),
            paper.downloaded_at
          ],
        )
        .unwrap();
      drop(connection);
      let database = Database::initialize(&path).unwrap();
      let old = database
        .get_paper(paper.paper_id.clone())
        .await
        .unwrap()
        .unwrap();
      assert_eq!(old.last_opened_at, None);
      assert_eq!(old.last_location, Some(saved_location.clone()));
      let opened = database
        .mark_paper_opened(paper.paper_id.clone())
        .await
        .unwrap();
      assert_eq!(opened.title, paper.title);
      assert_eq!(opened.r#abstract, paper.r#abstract);
      assert_eq!(opened.last_location, Some(saved_location));
      assert!(opened.last_opened_at.is_some());
      database.save_paper(paper.clone()).await.unwrap();
      let reopened = Database::initialize(&path).unwrap();
      assert_eq!(
        reopened
          .get_paper(paper.paper_id)
          .await
          .unwrap()
          .unwrap()
          .last_opened_at,
        opened.last_opened_at
      );
      assert_eq!(
        reopened
          .connect()
          .unwrap()
          .query_row("PRAGMA user_version", [], |row| row.get::<_, u32>(0))
          .unwrap(),
        4
      );
      assert!(database.mark_paper_opened("missing".into()).await.is_err());
    });
  }

  #[test]
  fn recent_papers_use_last_opened_time_with_download_time_fallback() {
    tauri::async_runtime::block_on(async {
      let directory = tempfile::tempdir().unwrap();
      let path = directory.path().join("library.sqlite");
      let database = Database::initialize(&path).unwrap();
      for (id, downloaded, opened) in [
        (
          "paper-a",
          "2024-01-01T00:00:00Z",
          Some("2024-03-01T00:00:00Z"),
        ),
        ("paper-b", "2024-02-01T00:00:00Z", None),
        ("paper-c", "2024-02-02T00:00:00Z", None),
      ] {
        let mut paper = super::super::tests::fixture_paper();
        paper.paper_id = id.into();
        paper.downloaded_at = downloaded.into();
        paper.last_opened_at = opened.map(str::to_owned);
        database.save_paper(paper).await.unwrap();
      }
      let reopened = Database::initialize(&path).unwrap();
      let ids: Vec<_> = reopened
        .list_papers()
        .await
        .unwrap()
        .into_iter()
        .map(|paper| paper.paper_id)
        .collect();
      assert_eq!(ids, ["paper-a", "paper-c", "paper-b"]);
      reopened.mark_paper_opened("paper-b".into()).await.unwrap();
      assert_eq!(reopened.list_papers().await.unwrap()[0].paper_id, "paper-b");
    });
  }

  #[test]
  fn removal_cascades_and_late_ai_or_annotation_writes_cannot_resurrect_papers() {
    tauri::async_runtime::block_on(async {
      let directory = tempfile::tempdir().unwrap();
      let database = Database::initialize(&directory.path().join("library.sqlite")).unwrap();
      let paper = database
        .save_paper(conversations::tests::paper())
        .await
        .unwrap();
      let pdf = directory
        .path()
        .join(format!("{}.pdf", file_key(&paper.paper_id)));
      fs::write(&pdf, b"%PDF-test").unwrap();
      let annotation = super::super::tests::fixture_annotation(&paper);
      database.save_annotation(annotation.clone()).await.unwrap();
      let layout = reading_layout::tests::fixture_layout(paper.pdf_hash.clone());
      database
        .save_reading_layout(paper.paper_id.clone(), layout.clone())
        .await
        .unwrap();
      database
        .begin_ai_answer(conversations::tests::request())
        .await
        .unwrap();
      let request_ids = database
        .remove_paper_and_pdf(paper.paper_id.clone(), directory.path().to_owned())
        .await
        .unwrap();
      assert_eq!(request_ids, ["turn-1"]);
      assert!(!pdf.exists());
      assert!(database.list_papers().await.unwrap().is_empty());
      assert!(database
        .list_annotations(paper.paper_id.clone())
        .await
        .unwrap()
        .is_empty());
      assert!(database
        .list_ai_conversations(paper.paper_id.clone())
        .await
        .unwrap()
        .is_empty());
      assert!(database
        .get_reading_layout(paper.paper_id.clone(), reading_layout::LAYOUT_VERSION)
        .await
        .unwrap()
        .is_none());
      assert!(database.save_annotation(annotation).await.is_err());
      assert!(database
        .save_reading_layout(paper.paper_id.clone(), layout)
        .await
        .is_err());
      assert!(database.save_location(location(&paper)).await.is_err());
      assert!(database
        .begin_ai_answer(conversations::tests::request())
        .await
        .is_err());
      assert!(database
        .finish_ai_answer(
          "conversation-1".into(),
          "turn-1".into(),
          ConversationAnswer {
            answer: "Late answer".into(),
            provider_id: "test".into(),
            model_id: "test".into(),
            error: None,
            note_draft: None,
          }
        )
        .await
        .is_err());
      assert!(database
        .remove_paper_and_pdf(paper.paper_id, directory.path().to_owned())
        .await
        .unwrap()
        .is_empty());
    });
  }

  #[test]
  fn failed_database_removal_restores_pdf_and_all_paper_data() {
    tauri::async_runtime::block_on(async {
      let directory = tempfile::tempdir().unwrap();
      let database = Database::initialize(&directory.path().join("library.sqlite")).unwrap();
      let paper = database
        .save_paper(super::super::tests::fixture_paper())
        .await
        .unwrap();
      let pdf = directory
        .path()
        .join(format!("{}.pdf", file_key(&paper.paper_id)));
      fs::write(&pdf, b"%PDF-keep").unwrap();
      let annotation = super::super::tests::fixture_annotation(&paper);
      database.save_annotation(annotation).await.unwrap();
      database.connect().unwrap().execute_batch(
        "CREATE TRIGGER prevent_removal BEFORE DELETE ON papers BEGIN SELECT RAISE(ABORT, 'fixture'); END;",
      ).unwrap();
      assert!(database
        .remove_paper_and_pdf(paper.paper_id.clone(), directory.path().to_owned())
        .await
        .is_err());
      assert_eq!(fs::read(pdf).unwrap(), b"%PDF-keep");
      assert_eq!(database.list_papers().await.unwrap().len(), 1);
      assert_eq!(
        database
          .list_annotations(paper.paper_id)
          .await
          .unwrap()
          .len(),
        1
      );
    });
  }

  #[test]
  fn interrupted_removal_recovers_according_to_durable_database_state() {
    tauri::async_runtime::block_on(async {
      let directory = tempfile::tempdir().unwrap();
      let database = Database::initialize(&directory.path().join("library.sqlite")).unwrap();
      let paper = database
        .save_paper(super::super::tests::fixture_paper())
        .await
        .unwrap();
      let key = file_key(&paper.paper_id);
      let staged = directory.path().join(format!("{key}.removing"));
      let original = directory.path().join(format!("{key}.pdf"));
      fs::write(&staged, b"%PDF-recover").unwrap();
      let unrelated = directory.path().join("not-a-paper.removing");
      fs::write(&unrelated, b"leave untouched").unwrap();
      database.recover_pdf_removals(directory.path()).unwrap();
      assert_eq!(fs::read(&original).unwrap(), b"%PDF-recover");
      assert!(!staged.exists());
      fs::rename(&original, &staged).unwrap();
      database
        .connect()
        .unwrap()
        .execute("DELETE FROM papers WHERE paper_id=?1", [&paper.paper_id])
        .unwrap();
      database.recover_pdf_removals(directory.path()).unwrap();
      assert!(!staged.exists());
      assert!(!original.exists());
      assert_eq!(fs::read(unrelated).unwrap(), b"leave untouched");
    });
  }

  #[cfg(unix)]
  #[test]
  fn removal_rejects_symlinked_pdfs_without_touching_their_target() {
    tauri::async_runtime::block_on(async {
      let directory = tempfile::tempdir().unwrap();
      let database = Database::initialize(&directory.path().join("library.sqlite")).unwrap();
      let paper = database
        .save_paper(super::super::tests::fixture_paper())
        .await
        .unwrap();
      let target = directory.path().join("unrelated.pdf");
      fs::write(&target, b"unrelated data").unwrap();
      let pdf = directory
        .path()
        .join(format!("{}.pdf", file_key(&paper.paper_id)));
      std::os::unix::fs::symlink(&target, &pdf).unwrap();
      assert!(database
        .remove_paper_and_pdf(paper.paper_id, directory.path().to_owned())
        .await
        .is_err());
      assert_eq!(fs::read(&target).unwrap(), b"unrelated data");
      assert_eq!(database.list_papers().await.unwrap().len(), 1);
    });
  }

  #[test]
  fn removal_serializes_against_new_ai_requests() {
    tauri::async_runtime::block_on(async {
      let directory = tempfile::tempdir().unwrap();
      let database = Database::initialize(&directory.path().join("library.sqlite")).unwrap();
      for _ in 0..8 {
        let paper = database
          .save_paper(conversations::tests::paper())
          .await
          .unwrap();
        let (answer, deletion) = tokio::join!(
          database.begin_ai_answer(conversations::tests::request()),
          database.remove_paper_and_pdf(paper.paper_id.clone(), directory.path().to_owned()),
        );
        let request_ids = deletion.unwrap();
        assert_eq!(request_ids.contains(&"turn-1".to_owned()), answer.is_ok());
        assert!(database.list_papers().await.unwrap().is_empty());
        assert!(database
          .list_ai_conversations(paper.paper_id)
          .await
          .unwrap()
          .is_empty());
      }
    });
  }

  #[test]
  fn removal_service_stops_the_deleted_papers_running_ai_request() {
    tauri::async_runtime::block_on(async {
      let directory = tempfile::tempdir().unwrap();
      let state = crate::state::AppState::initialize(directory.path().to_owned()).unwrap();
      let paper = state
        .database
        .save_paper(conversations::tests::paper())
        .await
        .unwrap();
      state
        .database
        .begin_ai_answer(conversations::tests::request())
        .await
        .unwrap();
      let mut active = state.ai_requests.register("turn-1").unwrap();
      let (removed, stopped) = tokio::join!(
        crate::library::remove_paper(&state, paper.paper_id),
        tokio::time::timeout(
          Duration::from_secs(2),
          active.run(std::future::pending::<Result<()>>())
        ),
      );
      removed.unwrap();
      assert_eq!(stopped.unwrap().unwrap_err(), "The AI request was stopped.");
    });
  }
}
