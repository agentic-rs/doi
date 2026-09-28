mod ai;
mod arxiv;
mod commands;
mod credentials;
mod error;
mod export;
mod http;
mod models;
mod reader;
mod reading_layout;
mod references;
mod state;
mod storage;
mod validation;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let builder = tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(
      tauri_plugin_opener::Builder::new()
        .open_js_links_on_click(false)
        .build(),
    );
  #[cfg(target_os = "ios")]
  let builder = builder
    .plugin(tauri_plugin_papertrail_export::init())
    .plugin(tauri_plugin_papertrail_reader::init());
  builder
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
      commands::get_reading_layout,
      commands::save_reading_layout,
      commands::list_annotations,
      commands::save_annotation,
      commands::delete_annotation,
      commands::get_settings,
      commands::save_settings,
      commands::ask_selection,
      commands::resolve_reference,
      commands::open_external,
      commands::save_annotation_file,
      commands::reader_capabilities,
      commands::set_reader_orientation,
    ])
    .run(tauri::generate_context!())
    .expect("Could not start Papertrail");
}
