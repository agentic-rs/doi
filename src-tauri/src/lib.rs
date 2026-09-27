mod ai;
mod arxiv;
mod commands;
mod credentials;
mod error;
mod export;
mod http;
mod models;
mod references;
mod state;
mod storage;
mod validation;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .setup(|app| {
      let directory = app.path().app_data_dir()?;
      let state = state::AppState::initialize(directory).map_err(std::io::Error::other)?;
      app.manage(state);
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      commands::open_arxiv_paper,
      commands::list_papers,
      commands::get_pdf_bytes,
      commands::save_reading_position,
      commands::list_annotations,
      commands::save_annotation,
      commands::delete_annotation,
      commands::get_settings,
      commands::save_settings,
      commands::ask_selection,
      commands::resolve_reference,
      commands::open_external,
      commands::save_annotation_file,
    ])
    .run(tauri::generate_context!())
    .expect("Could not start Papertrail");
}
