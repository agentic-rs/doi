use crate::{
  error::{storage_error, Result},
  models::*,
  reading_layout, validation,
};
use rusqlite::{params, Connection, OptionalExtension};
use std::{
  path::{Path, PathBuf},
  time::Duration,
};

mod conversations;
mod library;
pub(crate) use conversations::ConversationAnswer;

#[derive(Clone)]
pub struct Database {
  path: PathBuf,
}

impl Database {
  pub fn initialize(path: &Path) -> Result<Self> {
    let database = Self {
      path: path.to_owned(),
    };
    let mut connection = database.connect()?;
    let transaction = connection
      .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
      .map_err(storage_error)?;
    let version: u32 = transaction
      .query_row("PRAGMA user_version", [], |row| row.get(0))
      .map_err(storage_error)?;
    if version > 4 {
      return Err("The library was created by a newer Papertrail version.".into());
    }
    transaction
      .execute_batch(
        "
       CREATE TABLE IF NOT EXISTS papers (
         paper_id TEXT PRIMARY KEY,
         arxiv_id TEXT NOT NULL,
         arxiv_version INTEGER NOT NULL,
         pdf_hash TEXT NOT NULL,
         data TEXT NOT NULL,
         last_location TEXT,
         downloaded_at TEXT NOT NULL,
         last_opened_at TEXT
       );
       CREATE TABLE IF NOT EXISTS annotations (
         annotation_id TEXT PRIMARY KEY,
         paper_id TEXT NOT NULL REFERENCES papers(paper_id) ON DELETE CASCADE,
         data TEXT NOT NULL,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL
       );
       CREATE INDEX IF NOT EXISTS annotations_by_paper ON annotations(paper_id, created_at);
       CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
       CREATE TABLE IF NOT EXISTS reading_layouts (
         paper_id TEXT PRIMARY KEY REFERENCES papers(paper_id) ON DELETE CASCADE,
         pdf_hash TEXT NOT NULL,
         layout_version INTEGER NOT NULL,
         data TEXT NOT NULL
       );
       CREATE TABLE IF NOT EXISTS ai_conversations (
         conversation_id TEXT PRIMARY KEY,
         paper_id TEXT NOT NULL REFERENCES papers(paper_id) ON DELETE CASCADE,
         data TEXT NOT NULL,
         active_request_id TEXT,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL
       );
       CREATE INDEX IF NOT EXISTS conversations_by_paper
         ON ai_conversations(paper_id, created_at);
       ",
      )
      .map_err(storage_error)?;
    let has_recency_column: bool = transaction
      .query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('papers') WHERE name='last_opened_at')",
        [],
        |row| row.get(0),
      )
      .map_err(storage_error)?;
    if !has_recency_column {
      transaction
        .execute_batch("ALTER TABLE papers ADD COLUMN last_opened_at TEXT;")
        .map_err(storage_error)?;
    }
    transaction
      .pragma_update(None, "user_version", 4)
      .map_err(storage_error)?;
    transaction.commit().map_err(storage_error)?;
    connection
      .pragma_update(None, "journal_mode", "WAL")
      .map_err(storage_error)?;
    conversations::recover_interrupted(&connection)?;
    Ok(database)
  }

  fn connect(&self) -> Result<Connection> {
    let connection = Connection::open(&self.path).map_err(storage_error)?;
    connection
      .busy_timeout(Duration::from_secs(5))
      .map_err(storage_error)?;
    connection
      .pragma_update(None, "foreign_keys", "ON")
      .map_err(storage_error)?;
    Ok(connection)
  }

  async fn run<T, F>(&self, operation: F) -> Result<T>
  where
    T: Send + 'static,
    F: FnOnce(&mut Connection) -> Result<T> + Send + 'static,
  {
    let database = self.clone();
    tauri::async_runtime::spawn_blocking(move || operation(&mut database.connect()?))
      .await
      .map_err(|_| "The local library operation was interrupted.".to_string())?
  }

  pub async fn list_papers(&self) -> Result<Vec<Paper>> {
    self
      .run(|connection| {
        let mut statement = connection
          .prepare("SELECT data, last_location, last_opened_at FROM papers ORDER BY COALESCE(last_opened_at, downloaded_at) DESC, paper_id")
          .map_err(storage_error)?;
        let papers = statement
          .query_map([], paper_from_row)
          .map_err(storage_error)?
          .collect::<rusqlite::Result<Vec<_>>>()
          .map_err(storage_error)?;
        Ok(papers)
      })
      .await
  }

  pub async fn get_paper(&self, paper_id: String) -> Result<Option<Paper>> {
    self
      .run(move |connection| {
        connection
          .query_row(
            "SELECT data, last_location, last_opened_at FROM papers WHERE paper_id=?1",
            [paper_id],
            paper_from_row,
          )
          .optional()
          .map_err(storage_error)
      })
      .await
  }

  pub async fn save_paper(&self, mut paper: Paper) -> Result<Paper> {
    self
      .run(move |connection| {
        let transaction = connection.transaction().map_err(storage_error)?;
        let previous: Option<(String, Option<String>, Option<String>)> = transaction
          .query_row(
            "SELECT pdf_hash, last_location, last_opened_at FROM papers WHERE paper_id=?1",
            [&paper.paper_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
          )
          .optional()
          .map_err(storage_error)?;
        if let Some((hash, location, opened_at)) = previous {
          paper.last_opened_at = opened_at;
          if hash != paper.pdf_hash {
            return Err(
              "A cached paper revision cannot be replaced with different PDF bytes.".into(),
            );
          }
          paper.last_location = location
            .map(|value| serde_json::from_str(&value))
            .transpose()
            .map_err(storage_error)?;
        }
        let data = serde_json::to_string(&paper).map_err(storage_error)?;
        transaction
          .execute(
            "INSERT INTO papers (paper_id, arxiv_id, arxiv_version, pdf_hash, data, downloaded_at, last_opened_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(paper_id) DO UPDATE SET data=excluded.data",
            params![
              paper.paper_id,
              paper.arxiv_id,
              paper.arxiv_version,
              paper.pdf_hash,
              data,
              paper.downloaded_at,
              paper.last_opened_at
            ],
          )
          .map_err(storage_error)?;
        transaction.commit().map_err(storage_error)?;
        Ok(paper)
      })
      .await
  }

  pub async fn save_location(&self, location: ReadingLocation) -> Result<()> {
    validation::validate_location(&location)?;
    self
      .run(move |connection| {
        let data = serde_json::to_string(&location).map_err(storage_error)?;
        let affected = connection
          .execute(
            "UPDATE papers SET last_location=?1 WHERE paper_id=?2",
            params![data, location.paper_id],
          )
          .map_err(storage_error)?;
        if affected == 0 {
          return Err("That paper is not in the local library.".into());
        }
        Ok(())
      })
      .await
  }

  pub async fn get_reading_layout(
    &self,
    paper_id: String,
    layout_version: u32,
  ) -> Result<Option<ReadingLayout>> {
    validation::validate_id(&paper_id)?;
    if layout_version != reading_layout::LAYOUT_VERSION {
      return Ok(None);
    }
    self
      .run(move |connection| {
        let cached: Option<(String, String)> = connection
          .query_row(
            "SELECT layouts.data, papers.pdf_hash FROM reading_layouts AS layouts
             JOIN papers ON papers.paper_id=layouts.paper_id
             WHERE layouts.paper_id=?1 AND layouts.layout_version=?2
               AND layouts.pdf_hash=papers.pdf_hash
               AND length(CAST(layouts.data AS BLOB))<=?3",
            params![paper_id, layout_version, reading_layout::MAX_LAYOUT_BYTES],
            |row| Ok((row.get(0)?, row.get(1)?)),
          )
          .optional()
          .map_err(storage_error)?;
        Ok(cached.and_then(|(data, hash)| reading_layout::decode(&data, &hash)))
      })
      .await
  }

  pub async fn save_reading_layout(&self, paper_id: String, layout: ReadingLayout) -> Result<()> {
    validation::validate_id(&paper_id)?;
    self
      .run(move |connection| {
        let data = reading_layout::encode(&layout)?;
        let transaction = connection.transaction().map_err(storage_error)?;
        let hash: Option<String> = transaction
          .query_row(
            "SELECT pdf_hash FROM papers WHERE paper_id=?1",
            [&paper_id],
            |row| row.get(0),
          )
          .optional()
          .map_err(storage_error)?;
        if hash.as_deref() != Some(&layout.pdf_hash) {
          return Err("The reading layout does not match this cached PDF revision.".into());
        }
        transaction
          .execute(
            "INSERT INTO reading_layouts (paper_id, pdf_hash, layout_version, data)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(paper_id) DO UPDATE SET pdf_hash=excluded.pdf_hash,
               layout_version=excluded.layout_version, data=excluded.data",
            params![paper_id, layout.pdf_hash, layout.layout_version, data],
          )
          .map_err(storage_error)?;
        transaction.commit().map_err(storage_error)?;
        Ok(())
      })
      .await
  }

  pub async fn list_annotations(&self, paper_id: String) -> Result<Vec<Annotation>> {
    self
      .run(move |connection| {
        let mut statement = connection
          .prepare("SELECT data FROM annotations WHERE paper_id=?1 ORDER BY created_at")
          .map_err(storage_error)?;
        let data = statement
          .query_map([paper_id], |row| row.get::<_, String>(0))
          .map_err(storage_error)?
          .collect::<rusqlite::Result<Vec<_>>>()
          .map_err(storage_error)?;
        data
          .into_iter()
          .map(|value| serde_json::from_str(&value).map_err(storage_error))
          .collect()
      })
      .await
  }

  pub async fn save_annotation(&self, mut annotation: Annotation) -> Result<Annotation> {
    validation::validate_annotation(&annotation)?;
    self.run(move |connection| {
      let transaction = connection.transaction().map_err(storage_error)?;
      let hash: Option<String> = transaction.query_row(
        "SELECT pdf_hash FROM papers WHERE paper_id=?1", [&annotation.target.paper_id],
        |row| row.get(0)).optional().map_err(storage_error)?;
      if hash.as_deref() != Some(&annotation.target.pdf_hash) {
        return Err("The annotation does not match this cached PDF revision.".into());
      }
      let existing: Option<(String, String)> = transaction.query_row(
        "SELECT paper_id, created_at FROM annotations WHERE annotation_id=?1", [&annotation.annotation_id],
        |row| Ok((row.get(0)?, row.get(1)?))).optional().map_err(storage_error)?;
      let now = chrono::Utc::now().to_rfc3339();
      annotation.created_at = match existing {
        Some((paper_id, created_at)) if paper_id == annotation.target.paper_id => created_at,
        Some(_) => return Err("An existing annotation cannot move to another paper.".into()),
        None if annotation.created_at.is_empty() => now.clone(),
        None => annotation.created_at,
      };
      annotation.updated_at = now;
      let data = serde_json::to_string(&annotation).map_err(storage_error)?;
      transaction.execute(
        "INSERT INTO annotations (annotation_id, paper_id, data, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(annotation_id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at",
        params![annotation.annotation_id, annotation.target.paper_id, data, annotation.created_at, annotation.updated_at]
      ).map_err(storage_error)?;
      transaction.commit().map_err(storage_error)?;
      Ok(annotation)
    }).await
  }

  pub async fn delete_annotation(&self, annotation_id: String) -> Result<()> {
    self
      .run(move |connection| {
        connection
          .execute(
            "DELETE FROM annotations WHERE annotation_id=?1",
            [annotation_id],
          )
          .map_err(storage_error)?;
        Ok(())
      })
      .await
  }

  pub async fn get_settings(&self) -> Result<AiSettings> {
    self
      .run(|connection| {
        let data: Option<String> = connection
          .query_row("SELECT value FROM settings WHERE key='ai'", [], |row| {
            row.get(0)
          })
          .optional()
          .map_err(storage_error)?;
        data
          .map(|value| serde_json::from_str(&value).map_err(storage_error))
          .transpose()
          .map(|value| value.unwrap_or_default())
      })
      .await
  }

  pub async fn save_settings(&self, mut settings: AiSettings) -> Result<()> {
    // Presence is derived from the native credential store, never trusted or persisted.
    settings.has_api_key = false;
    self
      .run(move |connection| {
        let data = serde_json::to_string(&settings).map_err(storage_error)?;
        connection
          .execute(
            "INSERT INTO settings (key, value) VALUES ('ai', ?1)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [data],
          )
          .map_err(storage_error)?;
        Ok(())
      })
      .await
  }
}

fn paper_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Paper> {
  let data: String = row.get(0)?;
  let location: Option<String> = row.get(1)?;
  let opened_at: Option<String> = row.get(2)?;
  let decode_error = |error| {
    rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
  };
  let mut paper: Paper = serde_json::from_str(&data).map_err(decode_error)?;
  paper.last_opened_at = opened_at;
  paper.last_location = location
    .map(|value| serde_json::from_str(&value))
    .transpose()
    .map_err(decode_error)?;
  Ok(paper)
}

#[cfg(test)]
mod tests {
  use super::*;

  pub(super) fn fixture_paper() -> Paper {
    Paper {
      paper_id: "2401.12345v2".into(),
      arxiv_id: "2401.12345".into(),
      arxiv_version: 2,
      title: "Test paper".into(),
      authors: vec!["Author".into()],
      r#abstract: "Abstract".into(),
      pdf_url: "https://arxiv.org/pdf/2401.12345v2".into(),
      pdf_hash: "a".repeat(64),
      downloaded_at: chrono::Utc::now().to_rfc3339(),
      last_opened_at: None,
      last_location: None,
    }
  }

  pub(super) fn fixture_annotation(paper: &Paper) -> Annotation {
    Annotation {
      schema_version: 1,
      annotation_id: "note-1".into(),
      target: AnnotationTarget {
        paper_id: paper.paper_id.clone(),
        pdf_hash: paper.pdf_hash.clone(),
        page_anchors: vec![PageAnchor {
          page_number: 2,
          quad_points: vec![[10., 20., 30., 20., 30., 10., 10., 10.]],
          text_quote: TextQuote {
            exact_text: "Quote".into(),
            prefix: "".into(),
            suffix: "".into(),
            normalization_version: 1,
          },
        }],
      },
      body: AnnotationBody::Note {
        content: "A note".into(),
      },
      created_at: "".into(),
      updated_at: "".into(),
    }
  }

  #[test]
  fn reviewed_ai_notes_preserve_original_answers_and_legacy_annotations() {
    tauri::async_runtime::block_on(async {
      let directory = tempfile::tempdir().unwrap();
      let path = directory.path().join("library.sqlite");
      let db = Database::initialize(&path).unwrap();
      let paper = db.save_paper(fixture_paper()).await.unwrap();
      let mut annotation = fixture_annotation(&paper);
      annotation.body = serde_json::from_value(serde_json::json!({
        "kind": "ai_answer", "question": "Why?", "answer": "The original complete explanation.",
        "provider_id": "https://provider.example/v1", "model_id": "test-model", "context_text": "Quoted source",
      })).unwrap();
      let legacy = db.save_annotation(annotation).await.unwrap();
      let legacy_json = serde_json::to_value(&legacy).unwrap();
      assert!(legacy_json["body"].get("note_content").is_none());
      let mut reviewed = legacy.clone();
      if let AnnotationBody::AiAnswer { note_content, .. } = &mut reviewed.body {
        *note_content = Some("My reviewed takeaway.".into());
      }
      db.save_annotation(reviewed.clone()).await.unwrap();
      db.save_annotation(reviewed.clone()).await.unwrap();
      let reopened = Database::initialize(&path).unwrap();
      let annotations = reopened.list_annotations(paper.paper_id).await.unwrap();
      assert_eq!(annotations.len(), 1);
      let body = serde_json::to_value(&annotations[0].body).unwrap();
      assert_eq!(body["note_content"], "My reviewed takeaway.");
      assert_eq!(body["answer"], legacy_json["body"]["answer"]);
      assert_eq!(body["context_text"], legacy_json["body"]["context_text"]);
      for invalid in [" ".to_owned(), "contains\0null".into(), "字".repeat(44_000)] {
        if let AnnotationBody::AiAnswer { note_content, .. } = &mut reviewed.body {
          *note_content = Some(invalid);
        }
        assert!(db.save_annotation(reviewed.clone()).await.is_err());
      }
    });
  }

  #[test]
  fn persistence_and_revision_bound_annotations() {
    tauri::async_runtime::block_on(async {
      let directory = tempfile::tempdir().unwrap();
      let path = directory.path().join("library.sqlite");
      let db = Database::initialize(&path).unwrap();
      let paper = db.save_paper(fixture_paper()).await.unwrap();
      let location = ReadingLocation {
        paper_id: paper.paper_id.clone(),
        page_number: 2,
        page_position: [0.0, 0.5],
        zoom: 1.2,
        zoom_mode: PdfZoomMode::FitWidth,
        rotation: 90,
        reader_mode: ReaderMode::Reading,
        reading_block_id: Some("page-2-text-1".into()),
      };
      db.save_location(location.clone()).await.unwrap();
      let mut imported = fixture_annotation(&paper);
      imported.created_at = "2020-01-02T03:04:05Z".into();
      let annotation = db.save_annotation(imported).await.unwrap();
      assert_eq!(annotation.created_at, "2020-01-02T03:04:05Z");
      assert!(chrono::DateTime::parse_from_rfc3339(&annotation.created_at).is_ok());
      let mut invalid = annotation.clone();
      invalid.target.pdf_hash = "b".repeat(64);
      assert!(db.save_annotation(invalid).await.is_err());
      let mut changed_pdf = paper.clone();
      changed_pdf.pdf_hash = "b".repeat(64);
      assert!(db.save_paper(changed_pdf).await.is_err());
      let reopened = Database::initialize(&path).unwrap();
      assert_eq!(
        reopened.list_papers().await.unwrap()[0].last_location,
        Some(location)
      );
      assert_eq!(
        reopened
          .list_annotations(paper.paper_id.clone())
          .await
          .unwrap()
          .len(),
        1
      );
      db.delete_annotation(annotation.annotation_id)
        .await
        .unwrap();
      assert!(db
        .list_annotations(paper.paper_id)
        .await
        .unwrap()
        .is_empty());
    });
  }

  #[test]
  fn legacy_saved_reading_positions_load_without_a_database_migration() {
    tauri::async_runtime::block_on(async {
      let directory = tempfile::tempdir().unwrap();
      let path = directory.path().join("library.sqlite");
      let db = Database::initialize(&path).unwrap();
      let paper = db.save_paper(fixture_paper()).await.unwrap();
      let legacy_location = serde_json::json!({
        "paper_id": paper.paper_id,
        "page_number": 3,
        "page_position": [0.1, 0.7],
        "zoom": 1.6,
        "rotation": 0
      });
      db.connect()
        .unwrap()
        .execute(
          "UPDATE papers SET last_location=?1 WHERE paper_id=?2",
          params![legacy_location.to_string(), paper.paper_id],
        )
        .unwrap();

      let reopened = Database::initialize(&path).unwrap();
      let loaded = reopened
        .get_paper(paper.paper_id)
        .await
        .unwrap()
        .unwrap()
        .last_location
        .unwrap();
      assert_eq!(loaded.zoom_mode, PdfZoomMode::Custom);
      assert_eq!(loaded.reader_mode, ReaderMode::Pdf);
      assert_eq!(loaded.reading_block_id, None);
      assert_eq!(loaded.zoom, 1.6);
      assert_eq!(loaded.page_number, 3);
      assert_eq!(loaded.page_position, [0.1, 0.7]);
    });
  }

  #[test]
  fn legacy_ai_settings_keep_their_endpoint_and_compatible_provider() {
    tauri::async_runtime::block_on(async {
      let directory = tempfile::tempdir().unwrap();
      let path = directory.path().join("library.sqlite");
      let db = Database::initialize(&path).unwrap();
      assert_eq!(
        db.get_settings().await.unwrap().provider_kind,
        AiProviderKind::Openai
      );
      let legacy = serde_json::json!({
        "base_url": "http://localhost:8080/v1",
        "model_id": "existing-local-model",
        "has_api_key": false,
      });
      db.connect()
        .unwrap()
        .execute(
          "INSERT INTO settings (key, value) VALUES ('ai', ?1)",
          [legacy.to_string()],
        )
        .unwrap();
      let mut settings = Database::initialize(&path)
        .unwrap()
        .get_settings()
        .await
        .unwrap();
      assert_eq!(settings.provider_kind, AiProviderKind::OpenaiCompatible);
      assert_eq!(settings.base_url, "http://localhost:8080/v1");
      assert_eq!(settings.model_id, "existing-local-model");
      settings.has_api_key = true;
      db.save_settings(settings).await.unwrap();
      let persisted = db.get_settings().await.unwrap();
      assert!(!persisted.has_api_key);
      assert_eq!(persisted.provider_kind, AiProviderKind::OpenaiCompatible);
    });
  }

  #[test]
  fn anchors_reject_degenerate_geometry() {
    let mut annotation = fixture_annotation(&fixture_paper());
    annotation.target.page_anchors[0].quad_points = vec![[1.; 8]];
    assert!(validation::validate_annotation(&annotation).is_err());
    annotation.target.page_anchors[0].quad_points = vec![[f64::NAN; 8]];
    assert!(validation::validate_annotation(&annotation).is_err());
  }

  #[test]
  fn reading_layout_cache_is_revision_bound_and_disposable() {
    tauri::async_runtime::block_on(async {
      let directory = tempfile::tempdir().unwrap();
      let path = directory.path().join("library.sqlite");
      let db = Database::initialize(&path).unwrap();
      let paper = db.save_paper(fixture_paper()).await.unwrap();
      let layout = reading_layout::tests::fixture_layout(paper.pdf_hash.clone());
      assert!(db
        .get_reading_layout(paper.paper_id.clone(), reading_layout::LAYOUT_VERSION)
        .await
        .unwrap()
        .is_none());
      db.save_reading_layout(paper.paper_id.clone(), layout.clone())
        .await
        .unwrap();
      let reopened = Database::initialize(&path).unwrap();
      assert_eq!(
        reopened
          .get_reading_layout(paper.paper_id.clone(), reading_layout::LAYOUT_VERSION)
          .await
          .unwrap(),
        Some(layout.clone())
      );
      assert!(db
        .get_reading_layout(paper.paper_id.clone(), reading_layout::LAYOUT_VERSION + 1)
        .await
        .unwrap()
        .is_none());
      for stale_version in [1, 2] {
        let mut stale = serde_json::to_value(&layout).unwrap();
        stale["layout_version"] = stale_version.into();
        if stale_version == 1 {
          for block in stale["blocks"].as_array_mut().unwrap() {
            block.as_object_mut().unwrap().remove("block_type");
          }
        } else {
          stale["blocks"][0]["block_type"] = "others".into();
        }
        db.connect()
          .unwrap()
          .execute(
            "UPDATE reading_layouts SET layout_version=?1, data=?2 WHERE paper_id=?3",
            params![stale_version, stale.to_string(), paper.paper_id],
          )
          .unwrap();
        for requested_version in [stale_version, reading_layout::LAYOUT_VERSION] {
          assert!(db
            .get_reading_layout(paper.paper_id.clone(), requested_version)
            .await
            .unwrap()
            .is_none());
        }
        db.save_reading_layout(paper.paper_id.clone(), layout.clone())
          .await
          .unwrap();
        assert_eq!(
          db.get_reading_layout(paper.paper_id.clone(), reading_layout::LAYOUT_VERSION)
            .await
            .unwrap(),
          Some(layout.clone())
        );
      }
      let mut wrong_revision = layout.clone();
      wrong_revision.pdf_hash = "b".repeat(64);
      assert!(db
        .save_reading_layout(paper.paper_id.clone(), wrong_revision)
        .await
        .is_err());
      assert!(db
        .save_reading_layout("missing-paper".into(), layout.clone())
        .await
        .is_err());

      for corrupt_data in [
        "{broken".into(),
        serde_json::to_string(&ReadingLayout {
          layout_version: reading_layout::LAYOUT_VERSION + 1,
          ..layout.clone()
        })
        .unwrap(),
        serde_json::to_string(&ReadingLayout {
          pdf_hash: "b".repeat(64),
          ..layout.clone()
        })
        .unwrap(),
      ] {
        db.connect()
          .unwrap()
          .execute(
            "UPDATE reading_layouts SET data=?1 WHERE paper_id=?2",
            params![corrupt_data, paper.paper_id],
          )
          .unwrap();
        assert!(db
          .get_reading_layout(paper.paper_id.clone(), reading_layout::LAYOUT_VERSION)
          .await
          .unwrap()
          .is_none());
      }
      db.save_reading_layout(paper.paper_id.clone(), layout.clone())
        .await
        .unwrap();
      db.connect()
        .unwrap()
        .execute("UPDATE reading_layouts SET pdf_hash=?1", ["b".repeat(64)])
        .unwrap();
      assert!(db
        .get_reading_layout(paper.paper_id, reading_layout::LAYOUT_VERSION)
        .await
        .unwrap()
        .is_none());
    });
  }

  #[test]
  fn existing_libraries_gain_an_empty_derived_layout_cache() {
    tauri::async_runtime::block_on(async {
      let directory = tempfile::tempdir().unwrap();
      let path = directory.path().join("library.sqlite");
      let db = Database::initialize(&path).unwrap();
      let paper = db.save_paper(fixture_paper()).await.unwrap();
      db.connect()
        .unwrap()
        .execute_batch("DROP TABLE reading_layouts; PRAGMA user_version=1;")
        .unwrap();
      let upgraded = Database::initialize(&path).unwrap();
      assert_eq!(upgraded.list_papers().await.unwrap().len(), 1);
      assert!(upgraded
        .get_reading_layout(paper.paper_id, reading_layout::LAYOUT_VERSION)
        .await
        .unwrap()
        .is_none());
    });
  }
}
