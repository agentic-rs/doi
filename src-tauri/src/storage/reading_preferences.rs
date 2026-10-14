use super::*;
use rusqlite::TransactionBehavior;

const SOURCE_RECT_TOLERANCE: f64 = 0.01;

fn validate_preference(preference: &ReadingBlockPreference) -> Result<()> {
  if preference.pdf_hash.len() != 64
    || !preference
      .pdf_hash
      .bytes()
      .all(|byte| byte.is_ascii_hexdigit())
  {
    return Err("A reading preference must identify the original PDF hash.".into());
  }
  if preference.page_number == 0 || preference.page_number > 10_000 {
    return Err("The reading preference has an invalid source page.".into());
  }
  let [left, bottom, right, top] = preference.source_rect;
  if preference
    .source_rect
    .iter()
    .any(|value| !value.is_finite() || value.abs() > 1_000_000.0)
    || left >= right
    || bottom >= top
  {
    return Err("Reading preferences must enclose a finite PDF region.".into());
  }
  Ok(())
}

impl Database {
  pub async fn list_reading_block_preferences(
    &self,
    paper_id: String,
  ) -> Result<Vec<ReadingBlockPreference>> {
    validation::validate_id(&paper_id)?;
    self
      .run(move |connection| {
        let mut statement = connection
          .prepare(
            "SELECT preferences.pdf_hash, preferences.page_number,
               preferences.source_left, preferences.source_bottom,
               preferences.source_right, preferences.source_top
             FROM reading_block_preferences AS preferences
             JOIN papers ON papers.paper_id=preferences.paper_id
             WHERE preferences.paper_id=?1 AND preferences.pdf_hash=papers.pdf_hash
             ORDER BY preferences.page_number, preferences.source_top DESC,
               preferences.source_left, preferences.source_bottom, preferences.source_right",
          )
          .map_err(storage_error)?;
        let preferences = statement
          .query_map([paper_id], |row| {
            Ok(ReadingBlockPreference {
              pdf_hash: row.get(0)?,
              page_number: row.get(1)?,
              source_rect: [row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?],
              split_lines: true,
            })
          })
          .map_err(storage_error)?
          .collect::<rusqlite::Result<Vec<_>>>()
          .map_err(storage_error)?;
        for preference in &preferences {
          validate_preference(preference)?;
        }
        Ok(preferences)
      })
      .await
  }

  pub async fn save_reading_block_preference(
    &self,
    paper_id: String,
    preference: ReadingBlockPreference,
  ) -> Result<()> {
    self
      .save_reading_block_preferences(paper_id, vec![preference])
      .await
  }

  pub async fn save_reading_block_preferences(
    &self,
    paper_id: String,
    preferences: Vec<ReadingBlockPreference>,
  ) -> Result<()> {
    validation::validate_id(&paper_id)?;
    if preferences.len() > 100_000 {
      return Err("Too many reading preferences to save together.".into());
    }
    for preference in &preferences {
      validate_preference(preference)?;
    }
    if preferences.is_empty() {
      return Ok(());
    }
    self
      .run(move |connection| {
        let transaction = connection
          .transaction_with_behavior(TransactionBehavior::Immediate)
          .map_err(storage_error)?;
        let hash: Option<String> = transaction
          .query_row(
            "SELECT pdf_hash FROM papers WHERE paper_id=?1",
            [&paper_id],
            |row| row.get(0),
          )
          .optional()
          .map_err(storage_error)?;
        if preferences
          .iter()
          .any(|preference| hash.as_deref() != Some(&preference.pdf_hash))
        {
          return Err("The reading preference does not match this cached PDF revision.".into());
        }
        for preference in preferences {
          let [left, bottom, right, top] = preference.source_rect;
          // PDF extraction can move a crop by tiny floating-point differences.
          // Replace the same source region without relying on derived block IDs.
          transaction
            .prepare_cached(
              "DELETE FROM reading_block_preferences
             WHERE paper_id=?1 AND pdf_hash=?2 AND page_number=?3
               AND source_left BETWEEN ?4-?8 AND ?4+?8
               AND source_bottom BETWEEN ?5-?8 AND ?5+?8
               AND source_right BETWEEN ?6-?8 AND ?6+?8
               AND source_top BETWEEN ?7-?8 AND ?7+?8",
            )
            .map_err(storage_error)?
            .execute(params![
              paper_id,
              preference.pdf_hash,
              preference.page_number,
              left,
              bottom,
              right,
              top,
              SOURCE_RECT_TOLERANCE,
            ])
            .map_err(storage_error)?;
          if preference.split_lines {
            transaction
              .prepare_cached(
                "INSERT INTO reading_block_preferences
                 (paper_id, pdf_hash, page_number, source_left, source_bottom,
                  source_right, source_top, split_lines)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1)",
              )
              .map_err(storage_error)?
              .execute(params![
                paper_id,
                preference.pdf_hash,
                preference.page_number,
                left,
                bottom,
                right,
                top,
              ])
              .map_err(storage_error)?;
          }
        }
        transaction.commit().map_err(storage_error)
      })
      .await
  }

  pub async fn reset_reading_block_preference(
    &self,
    paper_id: String,
    mut preference: ReadingBlockPreference,
  ) -> Result<()> {
    preference.split_lines = false;
    self
      .save_reading_block_preference(paper_id, preference)
      .await
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::storage::tests::{fixture_annotation, fixture_paper};

  fn fixture_preference(paper: &Paper) -> ReadingBlockPreference {
    ReadingBlockPreference {
      pdf_hash: paper.pdf_hash.clone(),
      page_number: 2,
      source_rect: [20.0, 30.0, 350.0, 400.0],
      split_lines: true,
    }
  }

  #[test]
  fn batch_choices_deduplicate_geometry_and_reset_only_selected_regions() {
    tauri::async_runtime::block_on(async {
      let directory = tempfile::tempdir().unwrap();
      let database = Database::initialize(&directory.path().join("library.sqlite")).unwrap();
      let paper = database.save_paper(fixture_paper()).await.unwrap();
      let first = fixture_preference(&paper);
      let second = ReadingBlockPreference {
        page_number: 3,
        ..first.clone()
      };
      let unrelated = ReadingBlockPreference {
        page_number: 4,
        ..first.clone()
      };
      database
        .save_reading_block_preference(paper.paper_id.clone(), unrelated.clone())
        .await
        .unwrap();
      let mut shifted = first.clone();
      shifted.source_rect = shifted.source_rect.map(|coordinate| coordinate + 0.005);
      database
        .save_reading_block_preferences(
          paper.paper_id.clone(),
          vec![first.clone(), shifted.clone(), second.clone()],
        )
        .await
        .unwrap();
      let saved = database
        .list_reading_block_preferences(paper.paper_id.clone())
        .await
        .unwrap();
      assert_eq!(saved.len(), 3);
      assert!(saved.contains(&shifted));
      assert!(saved.contains(&second));
      assert!(saved.contains(&unrelated));
      database
        .save_reading_block_preferences(
          paper.paper_id.clone(),
          vec![
            ReadingBlockPreference {
              split_lines: false,
              ..first
            },
            ReadingBlockPreference {
              split_lines: false,
              ..second
            },
          ],
        )
        .await
        .unwrap();
      assert_eq!(
        database
          .list_reading_block_preferences(paper.paper_id)
          .await
          .unwrap(),
        vec![unrelated]
      );
    });
  }

  #[test]
  fn invalid_or_stale_batch_choices_do_not_change_any_region() {
    tauri::async_runtime::block_on(async {
      let directory = tempfile::tempdir().unwrap();
      let database = Database::initialize(&directory.path().join("library.sqlite")).unwrap();
      let paper = database.save_paper(fixture_paper()).await.unwrap();
      let first = fixture_preference(&paper);
      let reset = ReadingBlockPreference {
        split_lines: false,
        ..first.clone()
      };
      database
        .save_reading_block_preference(paper.paper_id.clone(), first.clone())
        .await
        .unwrap();
      for invalid in [
        ReadingBlockPreference {
          pdf_hash: "b".repeat(64),
          ..first.clone()
        },
        ReadingBlockPreference {
          source_rect: [20.0, 30.0, 20.0, 400.0],
          ..first.clone()
        },
      ] {
        assert!(database
          .save_reading_block_preferences(paper.paper_id.clone(), vec![reset.clone(), invalid])
          .await
          .is_err());
        assert_eq!(
          database
            .list_reading_block_preferences(paper.paper_id.clone())
            .await
            .unwrap(),
          vec![first.clone()]
        );
      }
    });
  }

  #[test]
  fn database_failure_rolls_back_the_entire_batch() {
    tauri::async_runtime::block_on(async {
      let directory = tempfile::tempdir().unwrap();
      let database = Database::initialize(&directory.path().join("library.sqlite")).unwrap();
      let paper = database.save_paper(fixture_paper()).await.unwrap();
      let first = fixture_preference(&paper);
      database
        .save_reading_block_preference(paper.paper_id.clone(), first.clone())
        .await
        .unwrap();
      database
        .connect()
        .unwrap()
        .execute_batch(
          "CREATE TRIGGER fail_batch_insert BEFORE INSERT ON reading_block_preferences
         WHEN NEW.page_number=3 BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END;",
        )
        .unwrap();
      assert!(database
        .save_reading_block_preferences(
          paper.paper_id.clone(),
          vec![
            ReadingBlockPreference {
              split_lines: false,
              ..first.clone()
            },
            ReadingBlockPreference {
              page_number: 3,
              ..first.clone()
            },
          ]
        )
        .await
        .is_err());
      assert_eq!(
        database
          .list_reading_block_preferences(paper.paper_id)
          .await
          .unwrap(),
        vec![first]
      );
    });
  }

  #[test]
  fn migration_preserves_paper_data_and_preferences_survive_cache_rebuilds() {
    tauri::async_runtime::block_on(async {
      let directory = tempfile::tempdir().unwrap();
      let path = directory.path().join("library.sqlite");
      let database = Database::initialize(&path).unwrap();
      let paper = database.save_paper(fixture_paper()).await.unwrap();
      let annotation = database
        .save_annotation(fixture_annotation(&paper))
        .await
        .unwrap();
      let layout = reading_layout::tests::fixture_layout(paper.pdf_hash.clone());
      database
        .save_reading_layout(paper.paper_id.clone(), layout.clone())
        .await
        .unwrap();
      database
        .connect()
        .unwrap()
        .execute_batch("DROP TABLE reading_block_preferences; PRAGMA user_version=4;")
        .unwrap();

      let migrated = Database::initialize(&path).unwrap();
      assert_eq!(
        migrated
          .connect()
          .unwrap()
          .query_row("PRAGMA user_version", [], |row| row.get::<_, u32>(0))
          .unwrap(),
        5
      );
      assert_eq!(
        migrated
          .get_paper(paper.paper_id.clone())
          .await
          .unwrap()
          .unwrap()
          .title,
        paper.title
      );
      assert_eq!(
        migrated
          .list_annotations(paper.paper_id.clone())
          .await
          .unwrap()[0]
          .annotation_id,
        annotation.annotation_id
      );
      assert!(migrated
        .list_reading_block_preferences(paper.paper_id.clone())
        .await
        .unwrap()
        .is_empty());
      let preference = fixture_preference(&paper);
      migrated
        .save_reading_block_preference(paper.paper_id.clone(), preference.clone())
        .await
        .unwrap();
      migrated
        .connect()
        .unwrap()
        .execute(
          "DELETE FROM reading_layouts WHERE paper_id=?1",
          [&paper.paper_id],
        )
        .unwrap();
      let mut rebuilt = layout;
      rebuilt.blocks[0].block_id = "rebuilt-new-block-id".into();
      migrated
        .save_reading_layout(paper.paper_id.clone(), rebuilt)
        .await
        .unwrap();
      let reopened = Database::initialize(&path).unwrap();
      assert_eq!(
        reopened
          .list_reading_block_preferences(paper.paper_id)
          .await
          .unwrap(),
        vec![preference]
      );
    });
  }

  #[test]
  fn geometry_matching_deduplicates_and_reset_restores_default() {
    tauri::async_runtime::block_on(async {
      let directory = tempfile::tempdir().unwrap();
      let database = Database::initialize(&directory.path().join("library.sqlite")).unwrap();
      let paper = database.save_paper(fixture_paper()).await.unwrap();
      let preference = fixture_preference(&paper);
      database
        .save_reading_block_preference(paper.paper_id.clone(), preference.clone())
        .await
        .unwrap();
      let mut shifted = preference.clone();
      shifted.source_rect = shifted.source_rect.map(|coordinate| coordinate + 0.005);
      database
        .save_reading_block_preference(paper.paper_id.clone(), shifted.clone())
        .await
        .unwrap();
      let mut neighbor = shifted.clone();
      neighbor.source_rect[0] += 1.0;
      database
        .save_reading_block_preference(paper.paper_id.clone(), neighbor.clone())
        .await
        .unwrap();
      let mut next_page = shifted.clone();
      next_page.page_number += 1;
      database
        .save_reading_block_preference(paper.paper_id.clone(), next_page.clone())
        .await
        .unwrap();
      assert_eq!(
        database
          .list_reading_block_preferences(paper.paper_id.clone())
          .await
          .unwrap()
          .len(),
        3
      );
      database
        .reset_reading_block_preference(paper.paper_id.clone(), preference.clone())
        .await
        .unwrap();
      let remaining = database
        .list_reading_block_preferences(paper.paper_id.clone())
        .await
        .unwrap();
      assert_eq!(remaining.len(), 2);
      assert!(remaining.contains(&neighbor));
      assert!(remaining.contains(&next_page));
      neighbor.split_lines = false;
      database
        .save_reading_block_preference(paper.paper_id.clone(), neighbor)
        .await
        .unwrap();
      database
        .reset_reading_block_preference(paper.paper_id.clone(), next_page)
        .await
        .unwrap();
      assert!(database
        .list_reading_block_preferences(paper.paper_id)
        .await
        .unwrap()
        .is_empty());
    });
  }

  #[test]
  fn invalid_sources_and_missing_papers_cannot_save_or_reset_preferences() {
    tauri::async_runtime::block_on(async {
      let directory = tempfile::tempdir().unwrap();
      let database = Database::initialize(&directory.path().join("library.sqlite")).unwrap();
      let paper = database.save_paper(fixture_paper()).await.unwrap();
      let preference = fixture_preference(&paper);
      database
        .save_reading_block_preference(paper.paper_id.clone(), preference.clone())
        .await
        .unwrap();
      let mut wrong_hash = preference.clone();
      wrong_hash.pdf_hash = "b".repeat(64);
      let mut malformed_hash = preference.clone();
      malformed_hash.pdf_hash = "invalid".into();
      let mut zero_page = preference.clone();
      zero_page.page_number = 0;
      let mut unbounded_page = preference.clone();
      unbounded_page.page_number = 10_001;
      let mut invalid_preferences = vec![wrong_hash, malformed_hash, zero_page, unbounded_page];
      for source_rect in [
        [0.0, 0.0, f64::NAN, 10.0],
        [0.0, 0.0, f64::INFINITY, 10.0],
        [0.0, 0.0, 1_000_001.0, 10.0],
        [1.0, 0.0, 1.0, 10.0],
        [0.0, 10.0, 10.0, 0.0],
      ] {
        invalid_preferences.push(ReadingBlockPreference {
          source_rect,
          ..preference.clone()
        });
      }
      for invalid in invalid_preferences {
        assert!(database
          .save_reading_block_preference(paper.paper_id.clone(), invalid.clone())
          .await
          .is_err());
        assert!(database
          .reset_reading_block_preference(paper.paper_id.clone(), invalid)
          .await
          .is_err());
      }
      assert!(database
        .save_reading_block_preference("missing".into(), preference.clone())
        .await
        .is_err());
      assert!(database
        .reset_reading_block_preference("missing".into(), preference.clone())
        .await
        .is_err());
      assert_eq!(
        database
          .list_reading_block_preferences(paper.paper_id)
          .await
          .unwrap(),
        vec![preference]
      );
    });
  }

  #[test]
  fn removing_a_paper_cascades_preferences_and_late_writes_cannot_restore_them() {
    tauri::async_runtime::block_on(async {
      let directory = tempfile::tempdir().unwrap();
      let database = Database::initialize(&directory.path().join("library.sqlite")).unwrap();
      let paper = database.save_paper(fixture_paper()).await.unwrap();
      let preference = fixture_preference(&paper);
      database
        .save_reading_block_preference(paper.paper_id.clone(), preference.clone())
        .await
        .unwrap();
      let pdf_directory = directory.path().join("papers");
      std::fs::create_dir(&pdf_directory).unwrap();
      database
        .remove_paper_and_pdf(paper.paper_id.clone(), pdf_directory)
        .await
        .unwrap();
      assert_eq!(
        database
          .connect()
          .unwrap()
          .query_row(
            "SELECT COUNT(*) FROM reading_block_preferences",
            [],
            |row| { row.get::<_, u32>(0) }
          )
          .unwrap(),
        0
      );
      assert!(database
        .list_reading_block_preferences(paper.paper_id.clone())
        .await
        .unwrap()
        .is_empty());
      assert!(database
        .save_reading_block_preference(paper.paper_id, preference)
        .await
        .is_err());
    });
  }
}
