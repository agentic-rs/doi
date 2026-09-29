use super::*;
use rusqlite::TransactionBehavior;

const MAX_TURNS: usize = 64;
const MAX_CONVERSATION_BYTES: usize = 4 * 1024 * 1024;
// Reserve space for the bounded answer (including JSON escaping) and an error.
// Finalization can then always clear a pending operation after a size failure.
const ANSWER_HEADROOM_BYTES: usize = 1024 * 1024;
const INTERRUPTED: &str = "The app closed before this answer finished. Ask again to continue.";

pub(crate) struct ConversationAnswer {
  pub answer: String,
  pub provider_id: String,
  pub model_id: String,
  pub error: Option<String>,
  pub note_draft: Option<AiNoteDraft>,
}

impl Database {
  pub async fn list_ai_conversations(&self, paper_id: String) -> Result<Vec<AiConversation>> {
    validation::validate_id(&paper_id)?;
    self
      .run(move |connection| {
        let mut statement = connection
          .prepare("SELECT data FROM ai_conversations WHERE paper_id=?1 ORDER BY created_at")
          .map_err(storage_error)?;
        let data = statement
          .query_map([paper_id], |row| row.get::<_, String>(0))
          .map_err(storage_error)?
          .collect::<rusqlite::Result<Vec<_>>>()
          .map_err(storage_error)?;
        data.into_iter().map(|value| decode(&value)).collect()
      })
      .await
  }

  pub async fn begin_ai_answer(&self, request: AiConversationRequest) -> Result<AiConversation> {
    validation::validate_id(&request.request_id)?;
    validation::validate_id(&request.conversation_id)?;
    validation::require_text(&request.question, "question", 8192)?;
    self.run(move |connection| {
      let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(storage_error)?;
      let existing = find(&transaction, &request.conversation_id)?;
      let now = chrono::Utc::now().to_rfc3339();
      let mut conversation = match existing {
        Some(conversation) => {
          if request.source.is_some() {
            return Err("This conversation already has a source passage. Start a new conversation for another selection.".into());
          }
          conversation
        }
        None => {
          let source = request.source.ok_or_else(|| "This conversation is no longer available. Select a passage to start another.".to_string())?;
          validation::require_text(&source.selected_text, "selection", 32 * 1024)?;
          validation::bound_text(&source.context_text, "context", validation::MAX_TEXT_BYTES)?;
          let target = AnnotationTarget {
            paper_id: source.paper_id, pdf_hash: source.pdf_hash, page_anchors: source.page_anchors,
          };
          validation::validate_annotation_target(&target)?;
          let paper = transaction.query_row(
            "SELECT data, last_location FROM papers WHERE paper_id=?1", [&target.paper_id], paper_from_row
          ).optional().map_err(storage_error)?.ok_or_else(|| "That paper is not in the local library.".to_string())?;
          if paper.pdf_hash != target.pdf_hash {
            return Err("The conversation does not match this cached PDF revision.".into());
          }
          AiConversation {
            conversation_id: request.conversation_id.clone(), target,
            selected_text: source.selected_text, context_text: source.context_text, paper_title: paper.title,
            created_at: now.clone(), updated_at: now.clone(), turns: Vec::new(), note_draft: None,
            active_request_id: None, active_operation: None,
          }
        }
      };
      ensure_idle(&conversation)?;
      if conversation.turns.len() >= MAX_TURNS {
        return Err("This conversation has reached 64 questions. Start a new conversation to continue.".into());
      }
      if conversation.turns.iter().any(|turn| turn.turn_id == request.request_id) {
        return Err("That question was already submitted. Reopen the conversation to see its result.".into());
      }
      conversation.turns.push(AiConversationTurn {
        turn_id: request.request_id.clone(), question: request.question, answer: String::new(),
        phase: AiTurnPhase::Pending, provider_id: String::new(), model_id: String::new(),
        error: None, created_at: now,
      });
      conversation.active_request_id = Some(request.request_id);
      conversation.active_operation = Some(AiConversationOperation::Answer);
      if serde_json::to_vec(&conversation).map_err(storage_error)?.len()
        > MAX_CONVERSATION_BYTES - ANSWER_HEADROOM_BYTES
      {
        return Err("This conversation is too large for another answer. Start a new conversation with a shorter selection.".into());
      }
      persist(&transaction, &mut conversation)?;
      transaction.commit().map_err(storage_error)?;
      Ok(conversation)
    }).await
  }

  pub async fn finish_ai_answer(
    &self,
    conversation_id: String,
    request_id: String,
    outcome: ConversationAnswer,
  ) -> Result<AiConversation> {
    validation::bound_text(&outcome.answer, "AI answer", validation::MAX_TEXT_BYTES)?;
    self
      .run(move |connection| {
        let transaction = connection
          .transaction_with_behavior(TransactionBehavior::Immediate)
          .map_err(storage_error)?;
        let mut conversation = get(&transaction, &conversation_id)?;
        ensure_operation(&conversation, &request_id, AiConversationOperation::Answer)?;
        let turn = conversation
          .turns
          .last_mut()
          .ok_or_else(|| "The pending question is missing.".to_string())?;
        if turn.turn_id != request_id || turn.phase != AiTurnPhase::Pending {
          return Err("This answer no longer matches the pending question.".into());
        }
        turn.answer = outcome.answer;
        turn.provider_id = outcome.provider_id;
        turn.model_id = outcome.model_id;
        turn.phase = if outcome.error.is_some() {
          AiTurnPhase::Incomplete
        } else {
          AiTurnPhase::Complete
        };
        turn.error = outcome.error;
        if conversation.turns.len() == 1 {
          if let Some(note) = outcome.note_draft {
            conversation.note_draft = Some(note);
          }
        }
        clear_operation(&mut conversation);
        persist(&transaction, &mut conversation)?;
        transaction.commit().map_err(storage_error)?;
        Ok(conversation)
      })
      .await
  }

  pub async fn begin_ai_note(
    &self,
    conversation_id: String,
    request_id: String,
  ) -> Result<AiConversation> {
    validation::validate_id(&conversation_id)?;
    validation::validate_id(&request_id)?;
    self
      .run(move |connection| {
        let transaction = connection
          .transaction_with_behavior(TransactionBehavior::Immediate)
          .map_err(storage_error)?;
        let mut conversation = get(&transaction, &conversation_id)?;
        ensure_idle(&conversation)?;
        if !conversation
          .turns
          .iter()
          .any(|turn| turn.phase == AiTurnPhase::Complete)
        {
          return Err("Wait for a complete answer before generating a note.".into());
        }
        conversation.active_request_id = Some(request_id);
        conversation.active_operation = Some(AiConversationOperation::Note);
        persist(&transaction, &mut conversation)?;
        transaction.commit().map_err(storage_error)?;
        Ok(conversation)
      })
      .await
  }

  pub async fn finish_ai_note(
    &self,
    conversation_id: String,
    request_id: String,
    note: Option<AiNoteDraft>,
  ) -> Result<AiConversation> {
    self
      .run(move |connection| {
        let transaction = connection
          .transaction_with_behavior(TransactionBehavior::Immediate)
          .map_err(storage_error)?;
        let mut conversation = get(&transaction, &conversation_id)?;
        ensure_operation(&conversation, &request_id, AiConversationOperation::Note)?;
        if let Some(note) = note {
          conversation.note_draft = Some(note);
        }
        clear_operation(&mut conversation);
        persist(&transaction, &mut conversation)?;
        transaction.commit().map_err(storage_error)?;
        Ok(conversation)
      })
      .await
  }

  pub async fn update_ai_conversation_note(
    &self,
    conversation_id: String,
    note_id: String,
    content: String,
  ) -> Result<AiConversation> {
    validation::bound_text(&content, "AI note", validation::MAX_TEXT_BYTES)?;
    self
      .run(move |connection| {
        let transaction = connection
          .transaction_with_behavior(TransactionBehavior::Immediate)
          .map_err(storage_error)?;
        let mut conversation = get(&transaction, &conversation_id)?;
        ensure_idle(&conversation)?;
        let note = matching_note(&mut conversation, &note_id)?;
        if note.saved_annotation_id.is_some() {
          return Err(
            "This note was already saved. Generate another note to keep new insights.".into(),
          );
        }
        note.content = content;
        persist(&transaction, &mut conversation)?;
        transaction.commit().map_err(storage_error)?;
        Ok(conversation)
      })
      .await
  }

  pub async fn save_ai_conversation_note(
    &self,
    conversation_id: String,
    note_id: String,
    content: String,
  ) -> Result<AiConversationSaveResult> {
    validation::require_text(&content, "AI note", validation::MAX_TEXT_BYTES)?;
    self
      .run(move |connection| {
        let transaction = connection
          .transaction_with_behavior(TransactionBehavior::Immediate)
          .map_err(storage_error)?;
        let mut conversation = get(&transaction, &conversation_id)?;
        ensure_idle(&conversation)?;
        let note = matching_note(&mut conversation, &note_id)?.clone();
        if let Some(annotation_id) = &note.saved_annotation_id {
          let data: Option<String> = transaction
            .query_row(
              "SELECT data FROM annotations WHERE annotation_id=?1",
              [annotation_id],
              |row| row.get(0),
            )
            .optional()
            .map_err(storage_error)?;
          let annotation = data
            .map(|data| serde_json::from_str(&data).map_err(storage_error))
            .transpose()?
            .ok_or_else(|| {
              "This saved note was deleted. Generate a new note to save it again.".to_string()
            })?;
          return Ok(AiConversationSaveResult {
            conversation,
            annotation,
          });
        }
        let now = chrono::Utc::now().to_rfc3339();
        let annotation = Annotation {
          schema_version: 1,
          annotation_id: note.note_id.clone(),
          target: conversation.target.clone(),
          body: AnnotationBody::AiAnswer {
            question: note.question,
            answer: note.answer,
            note_content: Some(content.clone()),
            provider_id: note.provider_id,
            model_id: note.model_id,
            context_text: note.context_text,
          },
          created_at: now.clone(),
          updated_at: now,
        };
        validation::validate_annotation(&annotation)?;
        let hash: String = transaction
          .query_row(
            "SELECT pdf_hash FROM papers WHERE paper_id=?1",
            [&conversation.target.paper_id],
            |row| row.get(0),
          )
          .map_err(storage_error)?;
        if hash != conversation.target.pdf_hash {
          return Err("The annotation does not match this cached PDF revision.".into());
        }
        let data = serde_json::to_string(&annotation).map_err(storage_error)?;
        // No upsert: once saved, a note is immutable through the conversation flow.
        transaction
          .execute(
            "INSERT INTO annotations (annotation_id, paper_id, data, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
              annotation.annotation_id,
              annotation.target.paper_id,
              data,
              annotation.created_at,
              annotation.updated_at
            ],
          )
          .map_err(storage_error)?;
        let note = matching_note(&mut conversation, &note_id)?;
        note.content = content;
        note.saved_annotation_id = Some(annotation.annotation_id.clone());
        persist(&transaction, &mut conversation)?;
        transaction.commit().map_err(storage_error)?;
        Ok(AiConversationSaveResult {
          conversation,
          annotation,
        })
      })
      .await
  }
}

fn matching_note<'a>(
  conversation: &'a mut AiConversation,
  note_id: &str,
) -> Result<&'a mut AiNoteDraft> {
  conversation
    .note_draft
    .as_mut()
    .filter(|note| note.note_id == note_id)
    .ok_or_else(|| "This note draft has changed. Reopen the conversation before saving.".into())
}

fn ensure_idle(conversation: &AiConversation) -> Result<()> {
  if conversation.active_request_id.is_some() {
    return Err("This conversation is busy. Wait for it to finish or stop the request.".into());
  }
  Ok(())
}

fn ensure_operation(
  conversation: &AiConversation,
  request_id: &str,
  operation: AiConversationOperation,
) -> Result<()> {
  if conversation.active_request_id.as_deref() != Some(request_id)
    || conversation.active_operation != Some(operation)
  {
    return Err("This AI request is no longer active.".into());
  }
  Ok(())
}

fn clear_operation(conversation: &mut AiConversation) {
  conversation.active_request_id = None;
  conversation.active_operation = None;
}

fn decode(data: &str) -> Result<AiConversation> {
  if data.len() > MAX_CONVERSATION_BYTES {
    return Err("This stored conversation exceeds the supported size.".into());
  }
  serde_json::from_str(data).map_err(storage_error)
}

fn find(connection: &Connection, conversation_id: &str) -> Result<Option<AiConversation>> {
  validation::validate_id(conversation_id)?;
  let data: Option<String> = connection
    .query_row(
      "SELECT data FROM ai_conversations WHERE conversation_id=?1",
      [conversation_id],
      |row| row.get(0),
    )
    .optional()
    .map_err(storage_error)?;
  data.map(|data| decode(&data)).transpose()
}

fn get(connection: &Connection, conversation_id: &str) -> Result<AiConversation> {
  find(connection, conversation_id)?
    .ok_or_else(|| "This conversation is no longer available.".into())
}

fn persist(connection: &Connection, conversation: &mut AiConversation) -> Result<()> {
  conversation.updated_at = chrono::Utc::now().to_rfc3339();
  let data = serde_json::to_string(&conversation).map_err(storage_error)?;
  if data.len() > MAX_CONVERSATION_BYTES {
    return Err("This conversation is too large. Start a new conversation to continue.".into());
  }
  connection.execute(
    "INSERT INTO ai_conversations (conversation_id, paper_id, data, active_request_id, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT(conversation_id) DO UPDATE SET data=excluded.data,
       active_request_id=excluded.active_request_id, updated_at=excluded.updated_at",
    params![conversation.conversation_id, conversation.target.paper_id, data, conversation.active_request_id,
      conversation.created_at, conversation.updated_at]
  ).map_err(storage_error)?;
  Ok(())
}

pub(super) fn recover_interrupted(connection: &Connection) -> Result<()> {
  let transaction = connection.unchecked_transaction().map_err(storage_error)?;
  let data = {
    let mut statement = transaction
      .prepare("SELECT data FROM ai_conversations WHERE active_request_id IS NOT NULL")
      .map_err(storage_error)?;
    let rows = statement
      .query_map([], |row| row.get::<_, String>(0))
      .map_err(storage_error)?;
    rows
      .collect::<rusqlite::Result<Vec<_>>>()
      .map_err(storage_error)?
  };
  for data in data {
    let mut conversation = decode(&data)?;
    for turn in &mut conversation.turns {
      if turn.phase == AiTurnPhase::Pending {
        turn.phase = AiTurnPhase::Incomplete;
        turn.error = Some(INTERRUPTED.into());
      }
    }
    clear_operation(&mut conversation);
    persist(&transaction, &mut conversation)?;
  }
  transaction.commit().map_err(storage_error)
}

#[cfg(test)]
mod tests {
  use super::*;

  pub(crate) fn paper() -> Paper {
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

  pub(crate) fn request() -> AiConversationRequest {
    AiConversationRequest {
      request_id: "turn-1".into(),
      conversation_id: "conversation-1".into(),
      question: "Why?".into(),
      source: Some(AiConversationSource {
        paper_id: paper().paper_id,
        pdf_hash: paper().pdf_hash,
        selected_text: "Original passage".into(),
        context_text: "Nearby context".into(),
        page_anchors: vec![PageAnchor {
          page_number: 2,
          quad_points: vec![[10., 20., 30., 20., 30., 10., 10., 10.]],
          text_quote: TextQuote {
            exact_text: "Original passage".into(),
            prefix: "".into(),
            suffix: "".into(),
            normalization_version: 1,
          },
        }],
      }),
    }
  }

  fn note(note_id: &str, source_turn_count: usize) -> AiNoteDraft {
    AiNoteDraft {
      note_id: note_id.into(),
      content: "Model takeaway".into(),
      answer: "Complete answer".into(),
      question: "Why?".into(),
      provider_id: "http://localhost:8080/v1".into(),
      model_id: "test-model".into(),
      context_text: "Quoted original source".into(),
      created_at: chrono::Utc::now().to_rfc3339(),
      saved_annotation_id: None,
      source_turn_count,
    }
  }

  fn answer(note_draft: Option<AiNoteDraft>) -> ConversationAnswer {
    ConversationAnswer {
      answer: "Complete answer".into(),
      provider_id: "http://localhost:8080/v1".into(),
      model_id: "test-model".into(),
      error: None,
      note_draft,
    }
  }

  async fn seed(db: &Database) -> AiConversation {
    db.save_paper(paper()).await.unwrap();
    db.begin_ai_answer(request()).await.unwrap();
    db.finish_ai_answer(
      "conversation-1".into(),
      "turn-1".into(),
      answer(Some(note("note-1", 1))),
    )
    .await
    .unwrap()
  }

  #[test]
  fn migration_reopens_conversations_and_recovers_only_abandoned_operations() {
    tauri::async_runtime::block_on(async {
      let dir = tempfile::tempdir().unwrap();
      let path = dir.path().join("library.sqlite");
      let db = Database::initialize(&path).unwrap();
      db.save_paper(paper()).await.unwrap();
      db.connect()
        .unwrap()
        .execute_batch("DROP TABLE ai_conversations; PRAGMA user_version=2;")
        .unwrap();
      let db = Database::initialize(&path).unwrap();
      assert_eq!(db.list_papers().await.unwrap().len(), 1);
      assert!(db
        .list_ai_conversations(paper().paper_id)
        .await
        .unwrap()
        .is_empty());
      db.begin_ai_answer(request()).await.unwrap();
      let pending = db
        .list_ai_conversations(paper().paper_id)
        .await
        .unwrap()
        .remove(0);
      assert_eq!(pending.turns[0].phase, AiTurnPhase::Pending);
      assert_eq!(pending.active_request_id.as_deref(), Some("turn-1"));
      let db = Database::initialize(&path).unwrap();
      let recovered = db
        .list_ai_conversations(paper().paper_id)
        .await
        .unwrap()
        .remove(0);
      assert_eq!(recovered.turns[0].phase, AiTurnPhase::Incomplete);
      assert_eq!(recovered.turns[0].error.as_deref(), Some(INTERRUPTED));
      assert!(recovered.active_request_id.is_none());
      assert!(recovered.active_operation.is_none());
      assert!(db
        .begin_ai_note("conversation-1".into(), "note-request".into())
        .await
        .is_err());

      let follow_up = AiConversationRequest {
        request_id: "turn-2".into(),
        source: None,
        ..request()
      };
      db.begin_ai_answer(follow_up).await.unwrap();
      db.finish_ai_answer("conversation-1".into(), "turn-2".into(), answer(None))
        .await
        .unwrap();
      db.begin_ai_note("conversation-1".into(), "note-request".into())
        .await
        .unwrap();
      db.finish_ai_note(
        "conversation-1".into(),
        "note-request".into(),
        Some(note("note-2", 1)),
      )
      .await
      .unwrap();
      db.begin_ai_note("conversation-1".into(), "interrupted-note".into())
        .await
        .unwrap();
      let db = Database::initialize(&path).unwrap();
      let recovered = db
        .list_ai_conversations(paper().paper_id)
        .await
        .unwrap()
        .remove(0);
      assert!(recovered.active_request_id.is_none());
      assert_eq!(recovered.turns[1].phase, AiTurnPhase::Complete);
      assert_eq!(recovered.note_draft.unwrap().note_id, "note-2");
      assert!(db
        .list_annotations(paper().paper_id)
        .await
        .unwrap()
        .is_empty());
    });
  }

  #[test]
  fn original_source_is_immutable_and_an_operation_claim_has_one_winner() {
    tauri::async_runtime::block_on(async {
      let dir = tempfile::tempdir().unwrap();
      let db = Database::initialize(&dir.path().join("library.sqlite")).unwrap();
      db.save_paper(paper()).await.unwrap();
      let mut invalid = request();
      invalid.source.as_mut().unwrap().pdf_hash = "b".repeat(64);
      assert!(db.begin_ai_answer(invalid).await.is_err());
      let mut invalid = request();
      invalid.source.as_mut().unwrap().page_anchors[0].quad_points[0] = [1.; 8];
      assert!(db.begin_ai_answer(invalid).await.is_err());
      seed(&db).await;
      assert!(db
        .begin_ai_answer(AiConversationRequest {
          request_id: "replacement".into(),
          ..request()
        })
        .await
        .is_err());
      let (first, second) = tokio::join!(
        db.begin_ai_answer(AiConversationRequest {
          request_id: "turn-a".into(),
          source: None,
          ..request()
        }),
        db.begin_ai_answer(AiConversationRequest {
          request_id: "turn-b".into(),
          source: None,
          ..request()
        })
      );
      assert_ne!(first.is_ok(), second.is_ok());
      let winner = first.or(second).unwrap();
      let active_id = winner.active_request_id.unwrap();
      assert!(db
        .begin_ai_note("conversation-1".into(), "note-request".into())
        .await
        .is_err());
      assert!(db
        .update_ai_conversation_note("conversation-1".into(), "note-1".into(), "edit".into())
        .await
        .is_err());
      assert!(db
        .save_ai_conversation_note("conversation-1".into(), "note-1".into(), "save".into())
        .await
        .is_err());
      assert!(db
        .finish_ai_answer(
          "conversation-1".into(),
          "wrong-request".into(),
          answer(None)
        )
        .await
        .is_err());
      let mut stopped = answer(None);
      stopped.answer = "A partial answer".into();
      stopped.error = Some("The AI request was stopped.".into());
      let completed = db
        .finish_ai_answer("conversation-1".into(), active_id.clone(), stopped)
        .await
        .unwrap();
      assert!(completed.active_request_id.is_none());
      assert_eq!(completed.turns[1].phase, AiTurnPhase::Incomplete);
      assert_eq!(completed.turns[1].answer, "A partial answer");
      assert_eq!(completed.note_draft.unwrap().note_id, "note-1");
      assert_eq!(completed.selected_text, "Original passage");
      assert!(db
        .finish_ai_answer("conversation-1".into(), active_id.clone(), answer(None))
        .await
        .is_err());
      assert!(db
        .begin_ai_answer(AiConversationRequest {
          request_id: active_id,
          source: None,
          ..request()
        })
        .await
        .is_err());
    });
  }

  #[test]
  fn explicit_note_save_is_atomic_idempotent_and_does_not_rewrite_saved_notes() {
    tauri::async_runtime::block_on(async {
      let dir = tempfile::tempdir().unwrap();
      let path = dir.path().join("library.sqlite");
      let db = Database::initialize(&path).unwrap();
      seed(&db).await;
      db.update_ai_conversation_note(
        "conversation-1".into(),
        "note-1".into(),
        "Reviewed draft".into(),
      )
      .await
      .unwrap();
      let reopened = Database::initialize(&path).unwrap();
      let loaded = reopened
        .list_ai_conversations(paper().paper_id)
        .await
        .unwrap()
        .remove(0);
      assert_eq!(loaded.note_draft.unwrap().content, "Reviewed draft");
      assert!(db
        .list_annotations(paper().paper_id)
        .await
        .unwrap()
        .is_empty());
      let saved = db
        .save_ai_conversation_note(
          "conversation-1".into(),
          "note-1".into(),
          "Reviewed draft".into(),
        )
        .await
        .unwrap();
      let repeated = db
        .save_ai_conversation_note(
          "conversation-1".into(),
          "note-1".into(),
          "Unwanted replacement".into(),
        )
        .await
        .unwrap();
      assert_eq!(
        serde_json::to_value(&saved.annotation).unwrap(),
        serde_json::to_value(repeated.annotation).unwrap()
      );
      assert_eq!(
        repeated.conversation.note_draft.unwrap().content,
        "Reviewed draft"
      );
      assert!(db
        .update_ai_conversation_note(
          "conversation-1".into(),
          "note-1".into(),
          "Cannot edit saved".into()
        )
        .await
        .is_err());
      let follow_up = AiConversationRequest {
        request_id: "turn-2".into(),
        question: "What does that imply?".into(),
        source: None,
        ..request()
      };
      db.begin_ai_answer(follow_up).await.unwrap();
      let after = db
        .finish_ai_answer(
          "conversation-1".into(),
          "turn-2".into(),
          answer(Some(note("must-ignore", 2))),
        )
        .await
        .unwrap();
      assert_eq!(after.note_draft.unwrap().note_id, "note-1");
      db.begin_ai_note("conversation-1".into(), "note-request".into())
        .await
        .unwrap();
      let generated = db
        .finish_ai_note(
          "conversation-1".into(),
          "note-request".into(),
          Some(note("note-2", 2)),
        )
        .await
        .unwrap();
      assert_eq!(generated.note_draft.unwrap().source_turn_count, 2);
      assert_eq!(
        db.list_annotations(paper().paper_id).await.unwrap().len(),
        1
      );
      assert!(db
        .save_ai_conversation_note(
          "conversation-1".into(),
          "note-1".into(),
          "Stale request".into()
        )
        .await
        .is_err());
      db.save_ai_conversation_note(
        "conversation-1".into(),
        "note-2".into(),
        "Second takeaway".into(),
      )
      .await
      .unwrap();
      let annotations = db.list_annotations(paper().paper_id).await.unwrap();
      assert_eq!(annotations.len(), 2);
      assert_eq!(
        serde_json::to_value(&annotations[0]).unwrap(),
        serde_json::to_value(&saved.annotation).unwrap()
      );
      db.delete_annotation("note-2".into()).await.unwrap();
      assert!(db
        .save_ai_conversation_note(
          "conversation-1".into(),
          "note-2".into(),
          "Do not resurrect".into()
        )
        .await
        .unwrap_err()
        .contains("deleted"));
      let persisted = db
        .connect()
        .unwrap()
        .query_row("SELECT data FROM ai_conversations", [], |row| {
          row.get::<_, String>(0)
        })
        .unwrap();
      assert!(!persisted.contains("thinking"));
    });
  }

  #[test]
  fn empty_drafts_survive_reopening_but_cannot_be_saved_as_annotations() {
    tauri::async_runtime::block_on(async {
      let dir = tempfile::tempdir().unwrap();
      let path = dir.path().join("library.sqlite");
      let db = Database::initialize(&path).unwrap();
      seed(&db).await;
      db.update_ai_conversation_note("conversation-1".into(), "note-1".into(), "".into())
        .await
        .unwrap();
      let db = Database::initialize(&path).unwrap();
      let conversation = db
        .list_ai_conversations(paper().paper_id)
        .await
        .unwrap()
        .remove(0);
      assert_eq!(conversation.note_draft.unwrap().content, "");
      assert!(db
        .save_ai_conversation_note("conversation-1".into(), "note-1".into(), "".into())
        .await
        .is_err());
      assert!(db
        .begin_ai_note("conversation-1".into(), "regenerate-empty-note".into())
        .await
        .is_ok());
    });
  }

  #[test]
  fn answer_claim_reserves_space_for_failure_and_does_not_start_an_oversized_conversation() {
    tauri::async_runtime::block_on(async {
      let dir = tempfile::tempdir().unwrap();
      let db = Database::initialize(&dir.path().join("library.sqlite")).unwrap();
      db.save_paper(paper()).await.unwrap();
      let mut request = request();
      let source = request.source.as_mut().unwrap();
      // Individually valid anchors can still produce an oversized selection.
      source.page_anchors = vec![source.page_anchors[0].clone(); 32];
      for anchor in &mut source.page_anchors {
        anchor.text_quote.exact_text = "x".repeat(100 * 1024);
      }
      assert!(db
        .begin_ai_answer(request)
        .await
        .unwrap_err()
        .contains("too large"));
      assert!(db
        .list_ai_conversations(paper().paper_id)
        .await
        .unwrap()
        .is_empty());
    });
  }

  #[test]
  fn failed_note_generation_and_annotation_collision_preserve_the_draft() {
    tauri::async_runtime::block_on(async {
      let dir = tempfile::tempdir().unwrap();
      let db = Database::initialize(&dir.path().join("library.sqlite")).unwrap();
      seed(&db).await;
      db.begin_ai_note("conversation-1".into(), "failed-note".into())
        .await
        .unwrap();
      let conversation = db
        .finish_ai_note("conversation-1".into(), "failed-note".into(), None)
        .await
        .unwrap();
      assert_eq!(conversation.note_draft.unwrap().note_id, "note-1");
      let mut collision = Annotation {
        schema_version: 1,
        annotation_id: "note-1".into(),
        target: conversation.target,
        body: AnnotationBody::Note {
          content: "Unrelated imported annotation".into(),
        },
        created_at: "".into(),
        updated_at: "".into(),
      };
      collision = db.save_annotation(collision).await.unwrap();
      assert!(db
        .save_ai_conversation_note("conversation-1".into(), "note-1".into(), "My note".into())
        .await
        .is_err());
      let loaded = db
        .list_ai_conversations(paper().paper_id)
        .await
        .unwrap()
        .remove(0);
      let draft = loaded.note_draft.unwrap();
      assert!(draft.saved_annotation_id.is_none());
      assert_eq!(draft.content, "Model takeaway");
      let annotations = db.list_annotations(paper().paper_id).await.unwrap();
      assert_eq!(
        serde_json::to_value(&annotations[0]).unwrap(),
        serde_json::to_value(collision).unwrap()
      );
    });
  }
}
