use crate::{credentials, error::Result, models::*, state::AppState, validation};
use tauri::{AppHandle, Emitter};

mod cancellation;
mod conversations;
pub use conversations::{ask_conversation, generate_conversation_note};
mod provider;
pub use cancellation::RequestRegistry;

pub async fn get_settings(state: &AppState) -> Result<AiSettings> {
  let _guard = state.settings_lock.lock().await;
  let mut settings = state.database.get_settings().await?;
  settings.has_api_key = credentials::get_key(settings.base_url.clone())
    .await?
    .is_some();
  Ok(settings)
}

pub async fn save_settings(
  state: &AppState,
  mut settings: AiSettings,
  api_key: Option<String>,
) -> Result<AiSettings> {
  let _guard = state.settings_lock.lock().await;
  settings = provider::normalize_settings(settings)?;
  if settings.base_url.is_empty() != settings.model_id.is_empty() {
    return Err("Enter both the provider base URL and model ID, or clear both.".into());
  }
  credentials::update_key(settings.base_url.clone(), api_key).await?;
  state.database.save_settings(settings.clone()).await?;
  settings.has_api_key = credentials::get_key(settings.base_url.clone())
    .await?
    .is_some();
  Ok(settings)
}

pub async fn ask(state: &AppState, app: &AppHandle, request: AiRequest) -> Result<AiAnswer> {
  validation::validate_id(&request.request_id)?;
  let mut active = state.ai_requests.register(&request.request_id)?;
  active.run(ask_inner(state, app, &request)).await
}

async fn ask_inner(state: &AppState, app: &AppHandle, request: &AiRequest) -> Result<AiAnswer> {
  validation::require_text(&request.selected_text, "selection", 32 * 1024)?;
  validation::bound_text(&request.context_text, "context", validation::MAX_TEXT_BYTES)?;
  validation::require_text(&request.question, "question", 8192)?;
  let paper = state
    .database
    .get_paper(request.paper_id.clone())
    .await?
    .ok_or_else(|| "That paper is not in the local library.".to_string())?;
  let (settings, api_key) = {
    let _guard = state.settings_lock.lock().await;
    let settings = state.database.get_settings().await?;
    if settings.base_url.is_empty() || settings.model_id.is_empty() {
      return Err("Configure an AI provider and model in Settings first.".into());
    }
    let api_key = credentials::get_key(settings.base_url.clone()).await?;
    (settings, api_key)
  };
  let settings = provider::normalize_settings(settings)?;
  let user_content = format!(
    "Paper: {}\narXiv revision: {}\nAuthors: {}\nAbstract: {}\n\nSelected passage:\n{}\n\nNearby context supplied by the reader:\n{}\n\nQuestion:\n{}",
    paper.title, paper.paper_id, paper.authors.join(", "), paper.r#abstract, request.selected_text,
    request.context_text, request.question,
  );
  validation::bound_text(
    &user_content,
    "complete AI context",
    validation::MAX_TEXT_BYTES,
  )?;
  state.progress(
    app,
    &request.request_id,
    "ai",
    "Asking the configured model…",
    0,
    None,
  );
  let emit = |kind, text: &str| {
    let _ = app.emit(
      "ai-stream",
      AiStreamEvent {
        request_id: request.request_id.clone(),
        kind,
        text: text.to_owned(),
      },
    );
  };
  let completion =
    provider::complete(state.ai_http()?, &settings, api_key, &user_content, &emit).await?;
  state.progress(
    app,
    &request.request_id,
    "ai",
    "The answer is ready.",
    0,
    None,
  );
  Ok(AiAnswer {
    answer: completion.answer,
    thinking: completion.thinking,
    note_proposal: completion.note_proposal,
    proposal_warning: completion.proposal_warning,
    provider_id: settings.base_url,
    model_id: settings.model_id,
    context_text: user_content,
  })
}

pub async fn list_models(
  state: &AppState,
  settings: AiSettings,
  api_key: Option<String>,
) -> Result<Vec<AiModel>> {
  let settings = provider::normalize_settings(settings)?;
  if settings.base_url.is_empty() {
    return Err("Enter a provider base URL first.".into());
  }
  let api_key = match api_key {
    Some(value) => provider::normalize_key(Some(value))?,
    None => {
      let _guard = state.settings_lock.lock().await;
      credentials::get_key(settings.base_url.clone()).await?
    }
  };
  provider::list_models(state.ai_http()?, &settings, api_key).await
}
