use serde::{Deserialize, Serialize};
use tauri::{plugin::PluginHandle, AppHandle, Manager, Runtime};

tauri::ios_plugin_binding!(init_plugin_papertrail_export);

struct NativeExport<R: Runtime>(PluginHandle<R>);

#[derive(Serialize)]
struct ExportOptions {
  file_path: String,
}

#[derive(Deserialize)]
struct ExportResponse {
  destination: Option<String>,
}

pub fn export_file<R: Runtime>(
  app: &AppHandle<R>,
  file_path: String,
) -> Result<Option<String>, String> {
  app
    .state::<NativeExport<R>>()
    .0
    .run_mobile_plugin::<ExportResponse>("exportFile", ExportOptions { file_path })
    .map(|response| response.destination)
    .map_err(|_| "Could not export annotations to Files.".to_string())
}

pub fn init<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
  tauri::plugin::Builder::new("papertrail-export")
    .setup(|app, api| {
      let handle = api.register_ios_plugin(init_plugin_papertrail_export)?;
      app.manage(NativeExport(handle));
      Ok(())
    })
    .build()
}
