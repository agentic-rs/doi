use crate::{
  ai, arxiv, error::Result, export, models::*, reader, references, state::AppState, validation,
};
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

#[tauri::command(rename_all = "snake_case")]
pub async fn open_arxiv_paper(
  app: AppHandle,
  state: State<'_, AppState>,
  input: String,
  request_id: String,
) -> Result<Paper> {
  validation::validate_id(&request_id)?;
  arxiv::open_paper(&state, &app, &input, &request_id).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn list_papers(state: State<'_, AppState>) -> Result<Vec<Paper>> {
  state.database.list_papers().await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn get_pdf_bytes(
  state: State<'_, AppState>,
  paper_id: String,
) -> Result<tauri::ipc::Response> {
  arxiv::read_pdf(&state, paper_id)
    .await
    .map(tauri::ipc::Response::new)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn save_reading_position(
  state: State<'_, AppState>,
  location: ReadingLocation,
) -> Result<()> {
  state.database.save_location(location).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn get_reading_layout(
  state: State<'_, AppState>,
  paper_id: String,
  layout_version: u32,
) -> Result<Option<ReadingLayout>> {
  state
    .database
    .get_reading_layout(paper_id, layout_version)
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn save_reading_layout(
  state: State<'_, AppState>,
  paper_id: String,
  layout: ReadingLayout,
) -> Result<()> {
  state.database.save_reading_layout(paper_id, layout).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn list_annotations(
  state: State<'_, AppState>,
  paper_id: String,
) -> Result<Vec<Annotation>> {
  state.database.list_annotations(paper_id).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn save_annotation(
  state: State<'_, AppState>,
  annotation: Annotation,
) -> Result<Annotation> {
  state.database.save_annotation(annotation).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn delete_annotation(state: State<'_, AppState>, annotation_id: String) -> Result<()> {
  validation::validate_id(&annotation_id)?;
  state.database.delete_annotation(annotation_id).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn get_settings(state: State<'_, AppState>) -> Result<AiSettings> {
  ai::get_settings(&state).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn save_settings(
  state: State<'_, AppState>,
  settings: AiSettings,
  api_key: Option<String>,
) -> Result<AiSettings> {
  ai::save_settings(&state, settings, api_key).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn list_ai_models(
  state: State<'_, AppState>,
  settings: AiSettings,
  api_key: Option<String>,
) -> Result<Vec<AiModel>> {
  ai::list_models(&state, settings, api_key).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn ask_selection(
  app: AppHandle,
  state: State<'_, AppState>,
  request: AiRequest,
) -> Result<AiAnswer> {
  ai::ask(&state, &app, request).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn cancel_ai_request(state: State<'_, AppState>, request_id: String) -> Result<()> {
  validation::validate_id(&request_id)?;
  state.ai_requests.cancel(&request_id);
  Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn resolve_reference(
  state: State<'_, AppState>,
  citation_text: String,
) -> Result<Vec<ReferenceCandidate>> {
  references::resolve(&state, citation_text).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn open_external(app: AppHandle, url: String) -> Result<()> {
  let url = validation::external_url(&url)?.to_string();
  tauri::async_runtime::spawn_blocking(move || {
    app
      .opener()
      .open_url(url, None::<&str>)
      .map_err(|_| "Could not open this link in your default browser.".to_string())
  })
  .await
  .map_err(|_| "Opening the external link was interrupted.".to_string())?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn save_annotation_file(
  app: AppHandle,
  state: State<'_, AppState>,
  file_name: String,
  content: String,
) -> Result<Option<String>> {
  export::save(&app, &state, file_name, content).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn reader_capabilities() -> reader::ReaderCapabilities {
  reader::capabilities()
}

#[tauri::command(rename_all = "snake_case")]
pub async fn set_reader_orientation(
  app: AppHandle,
  orientation: reader::ReaderOrientation,
) -> Result<reader::ReaderOrientation> {
  reader::set_orientation(app, orientation).await
}
