use serde::{Deserialize, Serialize};
use tauri::{plugin::PluginHandle, AppHandle, Manager, Runtime};

tauri::ios_plugin_binding!(init_plugin_papertrail_reader);

struct NativeReader<R: Runtime>(PluginHandle<R>);

#[derive(Serialize)]
struct OrientationOptions {
  orientation: String,
}

#[derive(Deserialize)]
struct OrientationResponse {
  orientation: String,
}

pub fn set_orientation<R: Runtime>(
  app: &AppHandle<R>,
  orientation: String,
) -> Result<String, String> {
  app
    .state::<NativeReader<R>>()
    .0
    .run_mobile_plugin::<OrientationResponse>("setOrientation", OrientationOptions { orientation })
    .map(|response| response.orientation)
    .map_err(|error| format!("Could not change the reading direction: {error}"))
}

pub fn init<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
  tauri::plugin::Builder::new("papertrail-reader")
    .setup(|app, api| {
      let handle = api.register_ios_plugin(init_plugin_papertrail_reader)?;
      app.manage(NativeReader(handle));
      Ok(())
    })
    .build()
}
