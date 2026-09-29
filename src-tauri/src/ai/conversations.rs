use super::{provider, *};
use crate::storage::ConversationAnswer;
use std::sync::Mutex;

const GENERATE_NOTE_QUESTION: &str = "Create one concise, self-contained note capturing the useful conclusions from this conversation. Use the propose_annotation tool. Do not save anything.";

type Emit<'a> = dyn Fn(AiStreamKind, &str) + Send + Sync + 'a;

pub async fn ask_conversation(
  state: &AppState,
  app: &AppHandle,
  request: AiConversationRequest,
) -> Result<AiConversationResponse> {
  let emit = |kind, text: &str| emit_event(app, &request.request_id, kind, text);
  ask_with_events(state, request.clone(), &emit).await
}

async fn ask_with_events(
  state: &AppState,
  request: AiConversationRequest,
  emit: &Emit<'_>,
) -> Result<AiConversationResponse> {
  validation::validate_id(&request.request_id)?;
  let mut active = state.ai_requests.register(&request.request_id)?;
  // Keep durable mutations outside the cancellable future. Even an early Stop
  // records the submitted question and then clears its pending state.
  let conversation = state.database.begin_ai_answer(request.clone()).await?;
  let partial = Mutex::new(String::new());
  let provenance = Mutex::new((String::new(), String::new()));
  let collect = |kind: AiStreamKind, text: &str| {
    if kind == AiStreamKind::AnswerDelta {
      append_bounded(&mut partial.lock().unwrap_or_else(|e| e.into_inner()), text);
    }
    emit(kind, text);
  };
  let initial = conversation.turns.len() == 1;
  let result = active
    .run(async {
      let (settings, key) = configured_provider(state).await?;
      *provenance.lock().unwrap_or_else(|e| e.into_inner()) =
        (settings.base_url.clone(), settings.model_id.clone());
      let source = source_context(state, &conversation).await?;
      let history = completed_history(&conversation);
      validate_context(&source, &history, &request.question)?;
      let mode = if initial {
        provider::CompletionMode::InitialAnswer
      } else {
        provider::CompletionMode::FollowUp
      };
      let completion = provider::complete_conversation(
        state.ai_http()?,
        &settings,
        key,
        provider::ConversationInput {
          source: &source,
          history: &history,
          question: &request.question,
          mode,
        },
        &collect,
      )
      .await?;
      validation::require_text(&completion.answer, "AI answer", validation::MAX_TEXT_BYTES)?;
      let note_draft = if initial {
        Some(note_draft(
          completion
            .note_proposal
            .as_deref()
            .unwrap_or(&completion.answer),
          &completion.answer,
          &request.question,
          &source,
          &settings,
          1,
        )?)
      } else {
        None
      };
      Ok((completion, note_draft))
    })
    .await;
  match result {
    Ok((completion, note_draft)) => {
      let (provider_id, model_id) = provenance.into_inner().unwrap_or_else(|e| e.into_inner());
      let outcome = ConversationAnswer {
        answer: completion.answer,
        provider_id: provider_id.clone(),
        model_id: model_id.clone(),
        error: None,
        note_draft,
      };
      match state
        .database
        .finish_ai_answer(
          request.conversation_id.clone(),
          request.request_id.clone(),
          outcome,
        )
        .await
      {
        Ok(conversation) => Ok(AiConversationResponse {
          conversation,
          thinking: completion.thinking,
        }),
        Err(error) => {
          // A too-large completed response must not leave the conversation busy.
          finish_failed_answer(
            state,
            &request,
            partial.into_inner().unwrap_or_else(|e| e.into_inner()),
            provider_id,
            model_id,
            error,
          )
          .await
        }
      }
    }
    Err(error) => {
      let (provider_id, model_id) = provenance.into_inner().unwrap_or_else(|e| e.into_inner());
      finish_failed_answer(
        state,
        &request,
        partial.into_inner().unwrap_or_else(|e| e.into_inner()),
        provider_id,
        model_id,
        error,
      )
      .await
    }
  }
}

async fn finish_failed_answer(
  state: &AppState,
  request: &AiConversationRequest,
  answer: String,
  provider_id: String,
  model_id: String,
  error: String,
) -> Result<AiConversationResponse> {
  let outcome = ConversationAnswer {
    answer,
    provider_id,
    model_id,
    error: Some(error.clone()),
    note_draft: None,
  };
  state
    .database
    .finish_ai_answer(
      request.conversation_id.clone(),
      request.request_id.clone(),
      outcome,
    )
    .await
    .map_err(|storage_error| {
      format!("{error} The conversation could not be updated: {storage_error}")
    })?;
  Err(error)
}

pub async fn generate_conversation_note(
  state: &AppState,
  app: &AppHandle,
  request_id: String,
  conversation_id: String,
) -> Result<AiConversationResponse> {
  let emit = |kind, text: &str| emit_event(app, &request_id, kind, text);
  generate_with_events(state, request_id.clone(), conversation_id, &emit).await
}

async fn generate_with_events(
  state: &AppState,
  request_id: String,
  conversation_id: String,
  emit: &Emit<'_>,
) -> Result<AiConversationResponse> {
  validation::validate_id(&request_id)?;
  let mut active = state.ai_requests.register(&request_id)?;
  let conversation = state
    .database
    .begin_ai_note(conversation_id.clone(), request_id.clone())
    .await?;
  let result = active.run(async {
    let (settings, key) = configured_provider(state).await?;
    let source = source_context(state, &conversation).await?;
    let history = completed_history(&conversation);
    validate_context(&source, &history, GENERATE_NOTE_QUESTION)?;
    let completion = provider::complete_conversation(
      state.ai_http()?, &settings, key,
      provider::ConversationInput {
        source: &source, history: &history, question: GENERATE_NOTE_QUESTION,
        mode: provider::CompletionMode::GenerateNote,
      }, emit,
    ).await?;
    let content = completion.note_proposal.as_deref().ok_or_else(|| completion.proposal_warning.clone()
      .unwrap_or_else(|| "The model did not propose a valid note. Try again or choose a model that supports tool calls.".into()))?;
    let transcript = history.iter().map(|(question, answer)| format!("Question: {question}\nAnswer: {answer}"))
      .collect::<Vec<_>>().join("\n\n");
    let question = history.first().map(|(question, _)| question.as_str()).unwrap_or(GENERATE_NOTE_QUESTION);
    let note = note_draft(content, &transcript, question, &source, &settings, history.len())?;
    Ok((note, completion.thinking))
  }).await;
  match result {
    Ok((note, thinking)) => {
      match state
        .database
        .finish_ai_note(conversation_id.clone(), request_id.clone(), Some(note))
        .await
      {
        Ok(conversation) => Ok(AiConversationResponse {
          conversation,
          thinking,
        }),
        Err(error) => {
          state
            .database
            .finish_ai_note(conversation_id, request_id, None)
            .await?;
          Err(error)
        }
      }
    }
    Err(error) => {
      state
        .database
        .finish_ai_note(conversation_id, request_id, None)
        .await
        .map_err(|storage_error| {
          format!("{error} The conversation could not be updated: {storage_error}")
        })?;
      Err(error)
    }
  }
}

async fn configured_provider(state: &AppState) -> Result<(AiSettings, Option<String>)> {
  let _guard = state.settings_lock.lock().await;
  let settings = provider::normalize_settings(state.database.get_settings().await?)?;
  if settings.base_url.is_empty() || settings.model_id.is_empty() {
    return Err("Configure an AI provider and model in Settings first.".into());
  }
  let key = credentials::get_key(settings.base_url.clone()).await?;
  Ok((settings, key))
}

async fn source_context(state: &AppState, conversation: &AiConversation) -> Result<String> {
  let paper = state
    .database
    .get_paper(conversation.target.paper_id.clone())
    .await?
    .ok_or_else(|| "That paper is not in the local library.".to_string())?;
  if paper.pdf_hash != conversation.target.pdf_hash {
    return Err("The conversation does not match this cached PDF revision.".into());
  }
  Ok(format!(
    "Paper: {}\narXiv revision: {}\nAuthors: {}\nAbstract: {}\n\nSelected passage:\n{}\n\nNearby context supplied by the reader:\n{}",
    paper.title, paper.paper_id, paper.authors.join(", "), paper.r#abstract,
    conversation.selected_text, conversation.context_text,
  ))
}

fn completed_history(conversation: &AiConversation) -> Vec<(String, String)> {
  conversation
    .turns
    .iter()
    .filter(|turn| turn.phase == AiTurnPhase::Complete)
    .map(|turn| (turn.question.clone(), turn.answer.clone()))
    .collect()
}

fn validate_context(source: &str, history: &[(String, String)], question: &str) -> Result<()> {
  let size = source.len()
    + question.len()
    + history
      .iter()
      .map(|(question, answer)| question.len() + answer.len() + 24)
      .sum::<usize>();
  if size > validation::MAX_TEXT_BYTES {
    return Err("This conversation is too long for another AI request. Start a new conversation with a focused selection.".into());
  }
  validation::bound_text(source, "AI context", validation::MAX_TEXT_BYTES)
}

fn note_draft(
  content: &str,
  answer: &str,
  question: &str,
  context: &str,
  settings: &AiSettings,
  source_turn_count: usize,
) -> Result<AiNoteDraft> {
  validation::require_text(content, "AI note", validation::MAX_TEXT_BYTES)?;
  validation::require_text(answer, "AI answer", validation::MAX_TEXT_BYTES)?;
  Ok(AiNoteDraft {
    note_id: uuid::Uuid::new_v4().to_string(),
    content: content.to_owned(),
    answer: answer.to_owned(),
    question: question.to_owned(),
    provider_id: settings.base_url.clone(),
    model_id: settings.model_id.clone(),
    context_text: context.to_owned(),
    created_at: chrono::Utc::now().to_rfc3339(),
    saved_annotation_id: None,
    source_turn_count,
  })
}

fn append_bounded(target: &mut String, text: &str) {
  // Malformed provider text must not prevent persisting the interrupted turn.
  for segment in text.split('\0') {
    let mut length = segment
      .len()
      .min(validation::MAX_TEXT_BYTES.saturating_sub(target.len()));
    while !segment.is_char_boundary(length) {
      length -= 1;
    }
    target.push_str(&segment[..length]);
  }
}

fn emit_event(app: &AppHandle, request_id: &str, kind: AiStreamKind, text: &str) {
  let _ = app.emit(
    "ai-stream",
    AiStreamEvent {
      request_id: request_id.to_owned(),
      kind,
      text: text.to_owned(),
    },
  );
}

#[cfg(test)]
mod tests {
  use super::*;

  fn request() -> AiConversationRequest {
    AiConversationRequest {
      request_id: "request-1".into(),
      conversation_id: "conversation-1".into(),
      question: "Why?".into(),
      source: Some(AiConversationSource {
        paper_id: "1706.03762v7".into(),
        pdf_hash: "a".repeat(64),
        selected_text: "Selected passage".into(),
        context_text: "Context".into(),
        page_anchors: vec![PageAnchor {
          page_number: 1,
          quad_points: vec![[1., 2., 2., 2., 2., 1., 1., 1.]],
          text_quote: TextQuote {
            exact_text: "Selected passage".into(),
            prefix: "".into(),
            suffix: "".into(),
            normalization_version: 1,
          },
        }],
      }),
    }
  }

  #[test]
  fn setup_failure_is_durable_and_does_not_leave_the_conversation_busy() {
    tauri::async_runtime::block_on(async {
      let dir = tempfile::tempdir().unwrap();
      let state = AppState::initialize(dir.path().to_owned()).unwrap();
      let mut paper = crate::arxiv::parse_metadata(
        include_bytes!("../../tests/fixtures/arxiv-1706.03762.xml"),
        &crate::arxiv::ArxivId::parse("1706.03762").unwrap(),
      )
      .unwrap();
      let mut request = request();
      request.source.as_mut().unwrap().paper_id = paper.paper_id.clone();
      paper.pdf_hash = "a".repeat(64);
      state.database.save_paper(paper.clone()).await.unwrap();
      let error = ask_with_events(&state, request.clone(), &|_, _| {})
        .await
        .unwrap_err();
      assert!(error.contains("Settings"));
      let conversation = state
        .database
        .list_ai_conversations(paper.paper_id.clone())
        .await
        .unwrap()
        .remove(0);
      assert_eq!(conversation.turns[0].question, "Why?");
      assert_eq!(conversation.turns[0].phase, AiTurnPhase::Incomplete);
      assert!(conversation.active_request_id.is_none());
      assert!(conversation.note_draft.is_none());
      assert!(completed_history(&conversation).is_empty());

      let next = AiConversationRequest {
        request_id: "request-2".into(),
        source: None,
        ..request
      };
      let error = ask_with_events(&state, next, &|_, _| {}).await.unwrap_err();
      assert!(error.contains("Settings"));
      let db = crate::storage::Database::initialize(&dir.path().join("library.sqlite")).unwrap();
      let conversation = db
        .list_ai_conversations(paper.paper_id.clone())
        .await
        .unwrap()
        .remove(0);
      assert_eq!(conversation.turns.len(), 2);
      assert!(conversation.active_request_id.is_none());
      assert!(db
        .list_annotations(paper.paper_id)
        .await
        .unwrap()
        .is_empty());
    });
  }

  #[test]
  fn history_excludes_failed_pending_and_reasoning_text_and_bounds_the_complete_context() {
    let request = request();
    let source = request.source.unwrap();
    let mut conversation = AiConversation {
      conversation_id: request.conversation_id,
      target: AnnotationTarget {
        paper_id: source.paper_id,
        pdf_hash: source.pdf_hash,
        page_anchors: source.page_anchors,
      },
      selected_text: source.selected_text,
      context_text: source.context_text,
      paper_title: "Paper".into(),
      created_at: "".into(),
      updated_at: "".into(),
      turns: Vec::new(),
      note_draft: None,
      active_request_id: None,
      active_operation: None,
    };
    for (phase, question, answer) in [
      (AiTurnPhase::Complete, "First question", "First answer"),
      (
        AiTurnPhase::Incomplete,
        "Stopped question",
        "Do not use this fragment",
      ),
      (
        AiTurnPhase::Complete,
        "Follow-up question",
        "Follow-up answer",
      ),
      (AiTurnPhase::Pending, "Pending question", ""),
    ] {
      conversation.turns.push(AiConversationTurn {
        turn_id: question.into(),
        question: question.into(),
        answer: answer.into(),
        phase,
        provider_id: "provider".into(),
        model_id: "model".into(),
        error: None,
        created_at: "".into(),
      });
    }
    let history = completed_history(&conversation);
    assert_eq!(
      history,
      vec![
        ("First question".into(), "First answer".into()),
        ("Follow-up question".into(), "Follow-up answer".into())
      ]
    );
    assert!(validate_context("Original source", &history, "More?").is_ok());
    assert!(validate_context(&"x".repeat(validation::MAX_TEXT_BYTES), &history, "More?").is_err());
  }

  #[test]
  fn interrupted_partial_text_is_bounded_at_unicode_boundaries_and_can_be_stored() {
    let mut answer = "x".repeat(validation::MAX_TEXT_BYTES - 2);
    append_bounded(&mut answer, "字");
    assert_eq!(answer.len(), validation::MAX_TEXT_BYTES - 2);
    append_bounded(&mut answer, "\0ok\0more");
    assert_eq!(answer.len(), validation::MAX_TEXT_BYTES);
    assert!(answer.ends_with("ok"));
    assert!(validation::bound_text(&answer, "AI answer", validation::MAX_TEXT_BYTES).is_ok());
  }
}
