use crate::error::Result;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ReaderOrientation {
  Portrait,
  Landscape,
}

#[derive(Serialize)]
pub struct ReaderCapabilities {
  pub supports_orientation: bool,
}

pub fn capabilities() -> ReaderCapabilities {
  ReaderCapabilities {
    supports_orientation: cfg!(target_os = "ios"),
  }
}

pub async fn set_orientation(
  app: AppHandle,
  orientation: ReaderOrientation,
) -> Result<ReaderOrientation> {
  #[cfg(target_os = "ios")]
  {
    let value = match orientation {
      ReaderOrientation::Portrait => "portrait",
      ReaderOrientation::Landscape => "landscape",
    };
    let response = tauri::async_runtime::spawn_blocking(move || {
      tauri_plugin_papertrail_reader::set_orientation(&app, value.to_string())
    })
    .await
    .map_err(|_| "The reading direction change was interrupted.".to_string())??;
    match response.as_str() {
      "portrait" => Ok(ReaderOrientation::Portrait),
      "landscape" => Ok(ReaderOrientation::Landscape),
      _ => Err("iOS returned an unknown reading direction.".to_string()),
    }
  }
  #[cfg(not(target_os = "ios"))]
  {
    let _ = (app, orientation);
    Err("Screen orientation changes are available only on iOS.".to_string())
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn orientation_contract_accepts_only_supported_native_directions() {
    let portrait = serde_json::from_str::<ReaderOrientation>("\"portrait\"").unwrap();
    assert_eq!(portrait, ReaderOrientation::Portrait);
    assert_eq!(
      serde_json::to_string(&ReaderOrientation::Landscape).unwrap(),
      "\"landscape\""
    );
    assert!(serde_json::from_str::<ReaderOrientation>("\"clockwise\"").is_err());
    assert!(serde_json::from_str::<ReaderOrientation>("90").is_err());
  }
}
