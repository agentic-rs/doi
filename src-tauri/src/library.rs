use crate::{error::Result, state::AppState, validation};

pub async fn remove_paper(state: &AppState, paper_id: String) -> Result<()> {
  validation::validate_id(&paper_id)?;
  let _import_guard = state.import_lock.lock().await;
  state.arxiv.invalidate_paper(&paper_id);
  let request_ids = state
    .database
    .remove_paper_and_pdf(paper_id, state.pdf_directory.clone())
    .await?;
  // The IDs were read in the same transaction that removed the conversations.
  // A completion racing cancellation cannot save into a deleted conversation.
  for request_id in request_ids {
    state.ai_requests.cancel(&request_id);
  }
  Ok(())
}
