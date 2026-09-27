use crate::{
  error::{storage_error, Result},
  models::*,
  validation,
};
use rusqlite::{params, Connection, OptionalExtension};
use std::{
  path::{Path, PathBuf},
  time::Duration,
};

#[derive(Clone)]
pub struct Database {
  path: PathBuf,
}

impl Database {
  pub fn initialize(path: &Path) -> Result<Self> {
    let database = Self {
      path: path.to_owned(),
    };
    let connection = database.connect()?;
    let version: u32 = connection
      .query_row("PRAGMA user_version", [], |row| row.get(0))
      .map_err(storage_error)?;
    if version > 1 {
      return Err("The library was created by a newer Papertrail version.".into());
    }
    connection
      .execute_batch(
        "PRAGMA journal_mode=WAL;
       BEGIN IMMEDIATE;
       CREATE TABLE IF NOT EXISTS papers (
         paper_id TEXT PRIMARY KEY,
         arxiv_id TEXT NOT NULL,
         arxiv_version INTEGER NOT NULL,
         pdf_hash TEXT NOT NULL,
         data TEXT NOT NULL,
         last_location TEXT,
         downloaded_at TEXT NOT NULL
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
       PRAGMA user_version=1;
       COMMIT;",
      )
      .map_err(storage_error)?;
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
          .prepare("SELECT data, last_location FROM papers ORDER BY downloaded_at DESC")
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
            "SELECT data, last_location FROM papers WHERE paper_id=?1",
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
        let previous: Option<(String, Option<String>)> = transaction
          .query_row(
            "SELECT pdf_hash, last_location FROM papers WHERE paper_id=?1",
            [&paper.paper_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
          )
          .optional()
          .map_err(storage_error)?;
        if let Some((hash, location)) = previous {
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
            "INSERT INTO papers (paper_id, arxiv_id, arxiv_version, pdf_hash, data, downloaded_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(paper_id) DO UPDATE SET data=excluded.data",
            params![
              paper.paper_id,
              paper.arxiv_id,
              paper.arxiv_version,
              paper.pdf_hash,
              data,
              paper.downloaded_at
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
  let decode_error = |error| {
    rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
  };
  let mut paper: Paper = serde_json::from_str(&data).map_err(decode_error)?;
  paper.last_location = location
    .map(|value| serde_json::from_str(&value))
    .transpose()
    .map_err(decode_error)?;
  Ok(paper)
}

#[cfg(test)]
mod tests {
  use super::*;

  fn fixture_paper() -> Paper {
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
      last_location: None,
    }
  }

  fn fixture_annotation(paper: &Paper) -> Annotation {
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
      assert_eq!(loaded.zoom, 1.6);
      assert_eq!(loaded.page_number, 3);
      assert_eq!(loaded.page_position, [0.1, 0.7]);
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
}
